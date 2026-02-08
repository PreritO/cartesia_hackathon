/**
 * Side Panel — streams the active tab's video via getDisplayMedia(),
 * captures frames at 15 FPS (sends to backend at 5 FPS), displays a
 * DELAYED video feed synced with AI commentary + TTS audio.
 *
 * Sync strategy: "Calibrate-then-play"
 * 1. Capture frames and send to backend immediately.
 * 2. Buffer frames but DON'T show video yet ("Calibrating...").
 * 3. When first commentary arrives, measure actual processing time.
 * 4. Lock video delay = processingTime + buffer. Never change it again.
 * 5. Start playing delayed video. Schedule all commentary with same delay.
 * Result: smooth playback + perfectly synced commentary from the start.
 */

import { useCallback, useRef, useState } from 'react';
import { BACKEND_WS_URL, CAPTURE_FPS, JPEG_QUALITY, MAX_CANVAS_WIDTH } from '../../lib/constants';

/** Display buffer FPS for smooth delayed playback. */
const DISPLAY_FPS = 15;
/** Send to backend every Nth display frame to match CAPTURE_FPS. */
const BACKEND_SEND_EVERY = Math.max(1, Math.round(DISPLAY_FPS / CAPTURE_FPS));
/** Buffer added on top of measured processing time. */
const DELAY_BUFFER_MS = 2500;
/** Min delay even if processing is somehow instant. */
const MIN_DELAY_MS = 3000;
/** Number of commentaries to sample before locking delay. */
const CALIBRATION_SAMPLES = 2;
/** Max frames in buffer (~30s at 15 FPS). */
const MAX_BUFFER_FRAMES = 450;

interface CommentaryEntry {
  text: string;
  emotion: string;
  analyst: string;
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

const PERSONA_OPTIONS = [
  { key: '', label: 'Default (General Audience)' },
  { key: 'casual_fan', label: 'Casual Fan — Alex' },
  { key: 'new_to_soccer', label: 'New to Soccer — Jordan' },
  { key: 'tactical_nerd', label: 'Tactical Nerd — Sam' },
  { key: 'passionate_homer', label: 'Passionate Homer — Danny' },
] as const;

export function App() {
  const [status, setStatus] = useState('Click "Start Stream" and pick your YouTube tab.');
  const [streaming, setStreaming] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [commentary, setCommentary] = useState<CommentaryEntry[]>([]);
  const [detection, setDetection] = useState<DetectionInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [delayedFrameSrc, setDelayedFrameSrc] = useState<string | null>(null);
  const [persona, setPersona] = useState('');
  const [lockedDelayDisplay, setLockedDelayDisplay] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const playingAudioRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const frameBufferRef = useRef<BufferedFrame[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const frameCaptureCountRef = useRef(0);
  const commentaryTimerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ---- Calibration state ----
  /** Whether we've locked the delay (set once, never changes). */
  const calibratedRef = useRef(false);
  /** The locked video delay in ms. Set once after calibration, then frozen. */
  const lockedDelayRef = useRef(0);
  /** Processing time samples collected during calibration. */
  const calibrationSamplesRef = useRef<number[]>([]);

  // ---- Calibration: collects samples, locks delay on the Nth commentary ----

  function calibrate(frameTs: number) {
    const processingTime = Date.now() - frameTs;
    calibrationSamplesRef.current.push(processingTime);

    const sampleCount = calibrationSamplesRef.current.length;
    console.log(
      '[AI Commentator] Calibration sample %d/%d: processingTime=%dms',
      sampleCount, CALIBRATION_SAMPLES, processingTime,
    );

    if (sampleCount < CALIBRATION_SAMPLES) {
      // Still collecting — show this commentary immediately (no sync yet)
      return false;
    }

    // Use the max of all samples for the most conservative estimate
    const worstCase = Math.max(...calibrationSamplesRef.current);
    const delay = Math.max(MIN_DELAY_MS, worstCase + DELAY_BUFFER_MS);

    lockedDelayRef.current = delay;
    calibratedRef.current = true;
    setCalibrated(true);
    setLockedDelayDisplay(delay);

    console.log(
      '[AI Commentator] Calibrated! samples=%o, worstCase=%dms, lockedDelay=%dms',
      calibrationSamplesRef.current, worstCase, delay,
    );

    // NOW start the delayed playback loop (video appears)
    startDelayedPlayback();
    return true;
  }

  // ---- Schedule commentary to appear when delayed video shows the frame ----

  function scheduleCommentary(text: string, emotion: string, analyst: string, audio: string | null, frameTs: number) {
    const displayAt = frameTs + lockedDelayRef.current;
    const waitMs = Math.max(0, displayAt - Date.now());

    console.log('[AI Commentator] %s commentary scheduled: waitMs=%dms', analyst, waitMs);

    const timerId = setTimeout(() => {
      setCommentary((prev) => [
        { text, emotion, analyst },
        ...prev.slice(0, 19),
      ]);
      if (audio) {
        audioQueueRef.current.push(audio);
        playNextAudio();
      }
    }, waitMs);

    commentaryTimerIdsRef.current.push(timerId);
  }

  // ---- Delayed playback (rAF loop, started AFTER calibration) ----

  const startDelayedPlayback = useCallback(() => {
    let lastDisplayedUrl: string | null = null;

    function tick() {
      const buffer = frameBufferRef.current;
      const targetTime = Date.now() - lockedDelayRef.current;

      // Find the latest frame at or before targetTime
      let bestIdx = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].timestamp <= targetTime) {
          bestIdx = i;
          break;
        }
      }

      if (bestIdx >= 0 && buffer[bestIdx].blobUrl !== lastDisplayedUrl) {
        lastDisplayedUrl = buffer[bestIdx].blobUrl;
        setDelayedFrameSrc(lastDisplayedUrl);

        // Revoke frames we've passed
        for (let i = 0; i < bestIdx; i++) {
          URL.revokeObjectURL(buffer[i].blobUrl);
        }
        frameBufferRef.current = buffer.slice(bestIdx);
      }

      rafIdRef.current = requestAnimationFrame(tick);
    }

    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const stopDelayedPlayback = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    for (const frame of frameBufferRef.current) {
      URL.revokeObjectURL(frame.blobUrl);
    }
    frameBufferRef.current = [];
    for (const id of commentaryTimerIdsRef.current) {
      clearTimeout(id);
    }
    commentaryTimerIdsRef.current = [];
    calibratedRef.current = false;
    lockedDelayRef.current = 0;
    calibrationSamplesRef.current = [];
    setDelayedFrameSrc(null);
    setCalibrated(false);
    setLockedDelayDisplay(0);
  }, []);

  // ---- Stream lifecycle ----

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
      setStatus('Calibrating sync — first commentary incoming...');
      if (persona) {
        ws.send(JSON.stringify({ type: 'set_persona', persona }));
      }
      // Start capturing frames immediately (they buffer for later)
      startFrameCapture();
      // NOTE: do NOT start delayed playback yet — wait for calibration
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          // Don't overwrite calibration status while calibrating
          if (calibratedRef.current) {
            setStatus(msg.message);
          }
        } else if (msg.type === 'detection') {
          setDetection({
            annotatedFrame: msg.annotated_frame,
            personCount: msg.person_count,
            ballCount: msg.ball_count,
          });
        } else if (msg.type === 'commentary') {
          const frameTs = msg.frame_ts || 0;
          const emotion = msg.emotion || 'neutral';
          const analyst = msg.analyst || 'Danny';
          const audio = msg.audio || null;

          // Update detection debug overlay immediately
          if (msg.annotated_frame) {
            setDetection((prev) => ({
              annotatedFrame: msg.annotated_frame,
              personCount: prev?.personCount ?? 0,
              ballCount: prev?.ballCount ?? 0,
            }));
          }

          if (frameTs > 0 && !calibratedRef.current) {
            // Still calibrating — collect sample and show immediately
            const locked = calibrate(frameTs);
            if (!locked) {
              // Pre-calibration: show commentary immediately (no sync yet)
              setCommentary((prev) => [
                { text: msg.text, emotion, analyst },
                ...prev.slice(0, 19),
              ]);
              if (audio) {
                audioQueueRef.current.push(audio);
                playNextAudio();
              }
              setStatus(`Calibrating... (${calibrationSamplesRef.current.length}/${CALIBRATION_SAMPLES})`);
              return;
            }
          }

          if (frameTs > 0 && calibratedRef.current) {
            // Schedule commentary to appear when delayed video shows this frame
            scheduleCommentary(msg.text, emotion, analyst, audio, frameTs);
            setStatus('Live — synced!');
          } else if (frameTs === 0) {
            // No sync info — display immediately
            setCommentary((prev) => [
              { text: msg.text, emotion, analyst },
              ...prev.slice(0, 19),
            ]);
            if (audio) {
              audioQueueRef.current.push(audio);
              playNextAudio();
            }
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

  // ---- Frame capture (starts immediately, buffers for delayed playback) ----

  function startFrameCapture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    frameCaptureCountRef.current = 0;
    const intervalMs = 1000 / DISPLAY_FPS;

    captureIntervalRef.current = setInterval(() => {
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
      frameCaptureCountRef.current++;

      const now = Date.now();

      // Buffer every frame for delayed playback
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          frameBufferRef.current.push({
            blobUrl: URL.createObjectURL(blob),
            timestamp: now,
          });
          while (frameBufferRef.current.length > MAX_BUFFER_FRAMES) {
            const old = frameBufferRef.current.shift();
            if (old) URL.revokeObjectURL(old.blobUrl);
          }
        },
        'image/jpeg',
        0.5,
      );

      // Send to backend at CAPTURE_FPS rate
      const ws = wsRef.current;
      if (
        ws &&
        ws.readyState === WebSocket.OPEN &&
        frameCaptureCountRef.current % BACKEND_SEND_EVERY === 0
      ) {
        ws.send(JSON.stringify({ type: 'frame_ts', ts: now }));
        canvas.toBlob(
          (blob) => {
            if (blob && ws.readyState === WebSocket.OPEN) {
              ws.send(blob);
            }
          },
          'image/jpeg',
          JPEG_QUALITY,
        );
      }
    }, intervalMs);
  }

  function stopFrameCapture() {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
  }

  // ---- Audio playback (queue with graceful handoff) ----

  function playNextAudio() {
    // If something is already playing, let it finish naturally.
    // The onended callback will pick up the next item in the queue.
    // Only interrupt if we're falling behind (>2 items queued).
    if (playingAudioRef.current) {
      if (audioQueueRef.current.length > 2 && currentAudioRef.current) {
        // Falling behind — skip to latest
        while (audioQueueRef.current.length > 1) {
          audioQueueRef.current.shift();
        }
        currentAudioRef.current.pause();
        currentAudioRef.current.src = '';
        currentAudioRef.current = null;
        playingAudioRef.current = false;
        // Fall through to play the latest
      } else {
        // Let current audio finish, queue will be picked up by onended
        return;
      }
    }

    const base64 = audioQueueRef.current.shift();
    if (!base64) {
      playingAudioRef.current = false;
      return;
    }

    playingAudioRef.current = true;
    const audio = new Audio(`data:audio/mp3;base64,${base64}`);
    currentAudioRef.current = audio;
    audio.onended = () => {
      playingAudioRef.current = false;
      currentAudioRef.current = null;
      playNextAudio();
    };
    audio.onerror = () => {
      playingAudioRef.current = false;
      currentAudioRef.current = null;
      playNextAudio();
    };
    audio.play().catch(() => {
      playingAudioRef.current = false;
      currentAudioRef.current = null;
      playNextAudio();
    });
  }

  // ---- Stop everything ----

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

    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }
    audioQueueRef.current = [];
    playingAudioRef.current = false;
    setStreaming(false);
  }

  // ---- Render ----

  const emotionColor: Record<string, string> = {
    excited: '#facc15',
    celebratory: '#4ade80',
    tense: '#f97316',
    urgent: '#ef4444',
    disappointed: '#94a3b8',
    thoughtful: '#60a5fa',
    neutral: '#cbd5e1',
  };

  const analystColor: Record<string, string> = {
    Danny: '#7c3aed',
    'Coach Kay': '#0ea5e9',
    Rookie: '#f97316',
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
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>AI Sports Commentator</h1>
          {streaming && calibrated && (
            <span style={{ fontSize: 10, color: '#4ade80', fontFamily: 'monospace' }}>
              synced ({(lockedDelayDisplay / 1000).toFixed(1)}s)
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <div
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: streaming ? (calibrated ? '#4ade80' : '#facc15') : '#ef4444',
            }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* Video area */}
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
            }}
          >
            {streaming && calibrated && delayedFrameSrc ? (
              <img
                src={delayedFrameSrc}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                alt="Synced playback"
              />
            ) : (
              <div style={{ textAlign: 'center' }}>
                <span style={{ color: '#475569', fontSize: 13 }}>
                  {!streaming
                    ? 'No video yet'
                    : !calibrated
                      ? 'Calibrating sync...'
                      : 'Loading...'}
                </span>
                {streaming && !calibrated && (
                  <div style={{
                    marginTop: 8, width: 24, height: 24, border: '3px solid #334155',
                    borderTop: '3px solid #7c3aed', borderRadius: '50%',
                    animation: 'spin 1s linear infinite', margin: '8px auto 0',
                  }} />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Hidden video element for real-time capture */}
        <video ref={videoRef} style={{ display: 'none' }} playsInline muted />

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

        {/* Persona selector */}
        <div style={{ padding: '4px 16px 8px' }}>
          <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
            Viewer Persona
          </label>
          <select
            value={persona}
            onChange={(e) => {
              const key = e.target.value;
              setPersona(key);
              const ws = wsRef.current;
              if (ws && ws.readyState === WebSocket.OPEN) {
                if (key) {
                  ws.send(JSON.stringify({ type: 'set_persona', persona: key }));
                } else {
                  ws.send(JSON.stringify({ type: 'set_profile', profile: {} }));
                }
              }
            }}
            style={{
              width: '100%',
              padding: '8px 10px', borderRadius: 6,
              border: '1px solid #334155',
              background: '#1e293b', color: '#e2e8f0',
              fontSize: 13, cursor: 'pointer',
              appearance: 'auto',
            }}
          >
            {PERSONA_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>
        </div>

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
                  borderLeft: `3px solid ${analystColor[entry.analyst] || '#7c3aed'}`,
                  opacity: i === 0 ? 1 : 0.6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                    color: analystColor[entry.analyst] || '#7c3aed',
                  }}>
                    {entry.analyst}
                  </span>
                  <span style={{
                    fontSize: 8, color: emotionColor[entry.emotion] || '#cbd5e1',
                    textTransform: 'uppercase', opacity: 0.8,
                  }}>
                    {entry.emotion}
                  </span>
                </div>
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

      {/* Hidden canvas */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <style>{`
        body { margin: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
