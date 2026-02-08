/**
 * Side Panel — streams the active tab's video via getDisplayMedia(),
 * captures frames at 5 FPS, sends them to the backend over WebSocket,
 * displays a DELAYED video feed (synced with commentary), commentary
 * text + TTS audio, and shows detection debug overlay.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BACKEND_WS_URL, CAPTURE_FPS, JPEG_QUALITY, MAX_CANVAS_WIDTH, PIPELINE_DELAY_MS } from '../../lib/constants';

interface CommentaryEntry {
  text: string;
  emotion: string;
}

interface DetectionInfo {
  annotatedFrame: string;
  personCount: number;
  ballCount: number;
}

interface BufferedFrame {
  blobUrl: string;
  timestamp: number;
}

export function App() {
  const [status, setStatus] = useState('Click "Start Stream" and pick your YouTube tab.');
  const [streaming, setStreaming] = useState(false);
  const [commentary, setCommentary] = useState<CommentaryEntry[]>([]);
  const [detection, setDetection] = useState<DetectionInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [delayMs, setDelayMs] = useState(PIPELINE_DELAY_MS);
  const [delayedFrameSrc, setDelayedFrameSrc] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const delayIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const playingAudioRef = useRef(false);
  const frameBufferRef = useRef<BufferedFrame[]>([]);
  const delayMsRef = useRef(delayMs);

  // Keep ref in sync with state
  useEffect(() => {
    delayMsRef.current = delayMs;
  }, [delayMs]);

  const startDelayedPlayback = useCallback(() => {
    // Every 200ms, find the frame that's ~delayMs old and display it
    delayIntervalRef.current = setInterval(() => {
      const buffer = frameBufferRef.current;
      const targetTime = Date.now() - delayMsRef.current;

      // Find the latest frame older than targetTime
      let bestIdx = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].timestamp <= targetTime) {
          bestIdx = i;
          break;
        }
      }

      if (bestIdx >= 0) {
        setDelayedFrameSrc(buffer[bestIdx].blobUrl);

        // Revoke and remove all frames before the displayed one
        for (let i = 0; i < bestIdx; i++) {
          URL.revokeObjectURL(buffer[i].blobUrl);
        }
        frameBufferRef.current = buffer.slice(bestIdx);
      }
    }, 200);
  }, []);

  const stopDelayedPlayback = useCallback(() => {
    if (delayIntervalRef.current) {
      clearInterval(delayIntervalRef.current);
      delayIntervalRef.current = null;
    }
    // Clean up all buffered frames
    for (const frame of frameBufferRef.current) {
      URL.revokeObjectURL(frame.blobUrl);
    }
    frameBufferRef.current = [];
    setDelayedFrameSrc(null);
  }, []);

  async function startStream() {
    setStatus('Waiting for tab selection...');
    setCommentary([]);
    setDetection(null);

    try {
      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.muted = true;
        await videoRef.current.play();
      }

      mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopStream();
        setStatus('Sharing stopped. Click "Start Stream" to try again.');
      });

      setStreaming(true);
      setStatus('Connecting to backend...');
      connectWebSocket();
    } catch (err) {
      console.error('[AI Commentator] Stream error:', err);
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setStatus('Cancelled. Click "Start Stream" to try again.');
      } else {
        setStatus(`Stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  function connectWebSocket() {
    const ws = new WebSocket(BACKEND_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[AI Commentator] WebSocket connected');
      setStatus('Connected! Buffering delayed video...');
      startFrameCapture();
      startDelayedPlayback();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          setStatus(msg.message);
        } else if (msg.type === 'detection') {
          setDetection({
            annotatedFrame: msg.annotated_frame,
            personCount: msg.person_count,
            ballCount: msg.ball_count,
          });
        } else if (msg.type === 'commentary') {
          console.log('[AI Commentator] Commentary:', msg.text, `[${msg.emotion}]`);

          setCommentary((prev) => [
            { text: msg.text, emotion: msg.emotion || 'neutral' },
            ...prev.slice(0, 19),
          ]);
          setStatus('Streaming + commenting!');

          if (msg.annotated_frame) {
            setDetection((prev) => ({
              annotatedFrame: msg.annotated_frame,
              personCount: prev?.personCount ?? 0,
              ballCount: prev?.ballCount ?? 0,
            }));
          }

          if (msg.audio) {
            audioQueueRef.current.push(msg.audio);
            playNextAudio();
          }
        }
      } catch (err) {
        console.error('[AI Commentator] Failed to parse WS message:', err);
      }
    };

    ws.onerror = () => {
      setStatus('Backend connection error — is the server running?');
    };

    ws.onclose = () => {
      console.log('[AI Commentator] WebSocket closed');
      stopFrameCapture();
      stopDelayedPlayback();
    };
  }

  function startFrameCapture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const intervalMs = 1000 / CAPTURE_FPS;

    captureIntervalRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (video.readyState < video.HAVE_CURRENT_DATA) return;

      let w = video.videoWidth;
      let h = video.videoHeight;
      if (w > MAX_CANVAS_WIDTH) {
        const scale = MAX_CANVAS_WIDTH / w;
        w = MAX_CANVAS_WIDTH;
        h = Math.round(h * scale);
      }

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      ctx.drawImage(video, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          // Send to backend
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(blob);
          }
          // Also buffer for delayed playback
          frameBufferRef.current.push({
            blobUrl: URL.createObjectURL(blob),
            timestamp: Date.now(),
          });
          // Cap buffer size (~20s of frames at 5fps = 100 frames)
          while (frameBufferRef.current.length > 100) {
            const old = frameBufferRef.current.shift();
            if (old) URL.revokeObjectURL(old.blobUrl);
          }
        },
        'image/jpeg',
        JPEG_QUALITY,
      );
    }, intervalMs);
  }

  function stopFrameCapture() {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
  }

  function playNextAudio() {
    if (playingAudioRef.current) return;
    const base64 = audioQueueRef.current.shift();
    if (!base64) return;

    playingAudioRef.current = true;
    const audio = new Audio(`data:audio/mp3;base64,${base64}`);
    audio.onended = () => {
      playingAudioRef.current = false;
      playNextAudio();
    };
    audio.onerror = () => {
      playingAudioRef.current = false;
      playNextAudio();
    };
    audio.play().catch(() => {
      playingAudioRef.current = false;
      playNextAudio();
    });
  }

  function stopStream() {
    stopFrameCapture();
    stopDelayedPlayback();

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    audioQueueRef.current = [];
    playingAudioRef.current = false;
    setStreaming(false);
  }

  const emotionColor: Record<string, string> = {
    excited: '#facc15',
    celebratory: '#4ade80',
    tense: '#f97316',
    urgent: '#ef4444',
    disappointed: '#94a3b8',
    thoughtful: '#60a5fa',
    neutral: '#cbd5e1',
  };

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f172a',
        color: 'white',
      }}
    >
      {/* Header — fixed */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>AI Sports Commentator</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <div
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: streaming ? '#4ade80' : '#ef4444',
            }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
        </div>
      </div>

      {/* Scrollable content area */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* Delayed video playback */}
        <div style={{ padding: '8px 16px 4px' }}>
          <div
            style={{
              width: '100%',
              aspectRatio: '16/9',
              background: '#000',
              borderRadius: 6,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
          >
            {streaming && delayedFrameSrc ? (
              <>
                <img
                  src={delayedFrameSrc}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  alt="Delayed playback"
                />
                <div
                  style={{
                    position: 'absolute', top: 6, right: 6,
                    background: 'rgba(0,0,0,0.7)', borderRadius: 4,
                    padding: '2px 8px', fontSize: 10, color: '#ef4444',
                    fontWeight: 600,
                  }}
                >
                  DELAYED {(delayMs / 1000).toFixed(1)}s
                </div>
              </>
            ) : (
              <span style={{ color: '#475569', fontSize: 13 }}>
                {streaming ? 'Buffering...' : 'No video yet'}
              </span>
            )}
          </div>
        </div>

        {/* Hidden video element for real-time capture */}
        <video
          ref={videoRef}
          style={{ display: 'none' }}
          playsInline
          muted
        />

        {/* Delay slider */}
        {streaming && (
          <div style={{ padding: '4px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>Delay:</span>
            <input
              type="range"
              min={2000}
              max={12000}
              step={500}
              value={delayMs}
              onChange={(e) => setDelayMs(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#7c3aed' }}
            />
            <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 32, textAlign: 'right' }}>
              {(delayMs / 1000).toFixed(1)}s
            </span>
          </div>
        )}

        {/* Detection debug overlay */}
        {streaming && (
          <div style={{ padding: '0 16px 4px' }}>
            <button
              onClick={() => setShowDebug(!showDebug)}
              style={{
                background: 'none', border: 'none', color: '#64748b',
                fontSize: 11, cursor: 'pointer', padding: '4px 0',
              }}
            >
              {showDebug ? 'Hide' : 'Show'} Detection View
              {detection && ` (${detection.personCount}p ${detection.ballCount}b)`}
            </button>
            {showDebug && detection?.annotatedFrame && (
              <div
                style={{
                  width: '100%',
                  aspectRatio: '16/9',
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: '1px solid #334155',
                  position: 'relative',
                }}
              >
                <img
                  src={`data:image/jpeg;base64,${detection.annotatedFrame}`}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  alt="Detection overlay"
                />
                <div
                  style={{
                    position: 'absolute', bottom: 4, left: 4,
                    background: 'rgba(0,0,0,0.7)', borderRadius: 4,
                    padding: '2px 6px', fontSize: 10, color: '#94a3b8',
                  }}
                >
                  {detection.personCount} players
                  {detection.ballCount > 0 ? ' | ball' : ' | no ball'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Controls */}
        <div style={{ padding: '4px 16px 8px' }}>
          <button
            onClick={streaming ? () => { stopStream(); setStatus('Stopped.'); } : startStream}
            style={{
              width: '100%',
              padding: '10px 16px', borderRadius: 8, border: 'none',
              cursor: 'pointer',
              fontWeight: 600, fontSize: 14,
              backgroundColor: streaming ? '#ef4444' : '#7c3aed',
              color: 'white',
            }}
          >
            {streaming ? 'Stop' : 'Start Stream'}
          </button>
        </div>

        {/* Commentary feed */}
        {streaming && commentary.length > 0 && (
          <div
            style={{
              padding: '0 16px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {commentary.map((entry, i) => (
              <div
                key={i}
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: '#1e293b',
                  borderLeft: `3px solid ${emotionColor[entry.emotion] || '#cbd5e1'}`,
                  opacity: i === 0 ? 1 : 0.6,
                }}
              >
                <span style={{ fontSize: 9, color: emotionColor[entry.emotion] || '#cbd5e1', textTransform: 'uppercase', fontWeight: 600 }}>
                  {entry.emotion}
                </span>
                <p style={{ fontSize: 12, margin: '2px 0 0', lineHeight: 1.4, color: '#e2e8f0' }}>
                  {entry.text}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Instructions when not streaming */}
        {!streaming && commentary.length === 0 && (
          <div style={{ padding: '0 16px' }}>
            <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
              1. Open a YouTube video in any tab<br />
              2. Click "Start Stream"<br />
              3. Pick the YouTube tab from Chrome's picker<br />
              4. AI commentary will appear here
            </p>
          </div>
        )}
      </div>

      {/* Hidden canvas for frame extraction */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <style>{`
        body { margin: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
      `}</style>
    </div>
  );
}
