/**
 * Side Panel — streams the active tab's video via getDisplayMedia(),
 * captures frames at 5 FPS, sends them to the backend over WebSocket,
 * and displays commentary text + plays TTS audio.
 */

import { useRef, useState } from 'react';
import { BACKEND_WS_URL, CAPTURE_FPS, JPEG_QUALITY, MAX_CANVAS_WIDTH } from '../../lib/constants';

interface CommentaryEntry {
  text: string;
  emotion: string;
}

export function App() {
  const [status, setStatus] = useState('Click "Start Stream" and pick your YouTube tab.');
  const [streaming, setStreaming] = useState(false);
  const [commentary, setCommentary] = useState<CommentaryEntry[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const playingAudioRef = useRef(false);

  async function startStream() {
    setStatus('Waiting for tab selection...');
    setCommentary([]);

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

      // Connect WebSocket and start frame capture
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
      setStatus('Connected! Sending frames...');
      startFrameCapture();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          setStatus(msg.message);
        } else if (msg.type === 'commentary') {
          console.log('[AI Commentator] Commentary:', msg.text, `[${msg.emotion}]`);

          setCommentary((prev) => [
            { text: msg.text, emotion: msg.emotion || 'neutral' },
            ...prev.slice(0, 19), // Keep last 20 entries
          ]);
          setStatus('Streaming + commenting!');

          // Queue audio for playback
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

      // Scale to max width while preserving aspect ratio
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
          if (blob && ws.readyState === WebSocket.OPEN) {
            ws.send(blob);
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
      playNextAudio(); // Play next in queue
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
    // Stop frame capture
    stopFrameCapture();

    // Close WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    // Stop media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Clear audio queue
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
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
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

      {/* Video mirror */}
      <div style={{ padding: '8px 16px' }}>
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
          }}
        >
          <video
            ref={videoRef}
            style={{
              width: '100%', height: '100%', objectFit: 'contain',
              display: streaming ? 'block' : 'none',
            }}
            playsInline
            muted
          />
          {!streaming && (
            <span style={{ color: '#475569', fontSize: 13 }}>No video yet</span>
          )}
        </div>
      </div>

      {/* Hidden canvas for frame extraction */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Controls */}
      <div style={{ padding: '8px 16px' }}>
        <button
          onClick={streaming ? () => { stopStream(); setStatus('Stopped.'); } : startStream}
          style={{
            width: '100%',
            padding: '12px 16px', borderRadius: 8, border: 'none',
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
            flex: 1,
            overflow: 'auto',
            padding: '8px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {commentary.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: '#1e293b',
                borderLeft: `3px solid ${emotionColor[entry.emotion] || '#cbd5e1'}`,
                opacity: i === 0 ? 1 : 0.7,
              }}
            >
              <span style={{ fontSize: 10, color: emotionColor[entry.emotion] || '#cbd5e1', textTransform: 'uppercase', fontWeight: 600 }}>
                {entry.emotion}
              </span>
              <p style={{ fontSize: 13, margin: '4px 0 0', lineHeight: 1.4, color: '#e2e8f0' }}>
                {entry.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Instructions when not streaming */}
      {!streaming && commentary.length === 0 && (
        <div style={{ flex: 1, padding: '0 16px' }}>
          <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
            1. Open a YouTube video in any tab<br />
            2. Click "Start Stream"<br />
            3. Pick the YouTube tab from Chrome's picker<br />
            4. AI commentary will appear here
          </p>
        </div>
      )}

      <style>{`body { margin: 0; }`}</style>
    </div>
  );
}
