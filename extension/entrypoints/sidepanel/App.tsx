/**
 * Side Panel — streams the active tab's video via getDisplayMedia(),
 * captures frames at 15 FPS (sends to backend at 5 FPS), displays a
 * DELAYED video feed auto-synced with commentary, and plays TTS audio.
 *
 * The delay is dynamic: it auto-calibrates to match the backend's actual
 * processing time so commentary always arrives in sync with the delayed video.
 */

import { useCallback, useRef, useState } from 'react';
import { BACKEND_WS_URL, CAPTURE_FPS, JPEG_QUALITY, MAX_CANVAS_WIDTH } from '../../lib/constants';

/** Display buffer runs at higher FPS for smooth delayed playback. */
const DISPLAY_FPS = 15;
/** Send to backend every Nth display frame to match CAPTURE_FPS. */
const BACKEND_SEND_EVERY = Math.max(1, Math.round(DISPLAY_FPS / CAPTURE_FPS));

/** Default delay before we've measured actual processing time. */
const INITIAL_DELAY_MS = 8000;
/** Minimum delay (always need some buffer to have frames to show). */
const MIN_DELAY_MS = 2000;
/** Maximum delay (don't get absurd). */
const MAX_DELAY_MS = 25000;
/** How fast the delay can change: ms of delay adjustment per real second. */
const DELAY_CONVERGE_SPEED = 1500;
/** Buffer added on top of measured processing time for safety margin. */
const DELAY_BUFFER_MS = 500;
/** Max frame buffer: ~25s at 15 FPS. */
const MAX_BUFFER_FRAMES = 375;

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
  const [commentary, setCommentary] = useState<CommentaryEntry[]>([]);
  const [detection, setDetection] = useState<DetectionInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [delayedFrameSrc, setDelayedFrameSrc] = useState<string | null>(null);
  const [persona, setPersona] = useState('');
  /** Displayed delay for UI indicator (updated periodically from ref). */
  const [displayDelay, setDisplayDelay] = useState(INITIAL_DELAY_MS);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const playingAudioRef = useRef(false);
  const frameBufferRef = useRef<BufferedFrame[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const frameCaptureCountRef = useRef(0);
  const commentaryTimerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ---- Dynamic delay auto-sync ----
  /** The delay currently being applied to the video (smoothly changes). */
  const currentDelayRef = useRef(INITIAL_DELAY_MS);
  /** Where we want the delay to converge to (computed from processing times). */
  const targetDelayRef = useRef(INITIAL_DELAY_MS);
  /** Recent processing times (ms) for computing target delay. */
  const processingTimesRef = useRef<number[]>([]);
  /** Wall-clock time of the last rAF tick (for smooth convergence). */
  const lastTickTimeRef = useRef(0);
  /** Counter for throttling React state updates (don't re-render every rAF). */
  const tickCountRef = useRef(0);

  /**
   * Called when commentary arrives. Measures actual processing time and
   * updates the target delay so the video stays in sync.
   */
  function updateTargetDelay(frameTs: number) {
    const processingTime = Date.now() - frameTs;
    const times = processingTimesRef.current;
    times.push(processingTime);
    // Keep a window of last 5 measurements
    if (times.length > 5) times.shift();

    // Use the max of recent times + buffer to be safe (never too early)
    const maxRecent = Math.max(...times);
    const newTarget = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, maxRecent + DELAY_BUFFER_MS));
    targetDelayRef.current = newTarget;

    console.log(
      '[AI Commentator] Processing time: %dms, target delay: %dms (current: %dms)',
      processingTime, newTarget, Math.round(currentDelayRef.current),
    );
  }

  /**
   * Schedule commentary to display at the right time.
   * Uses the CURRENT delay (which smoothly tracks the target).
   */
  function scheduleCommentary(text: string, emotion: string, audio: string | null, frameTs: number) {
    const displayAt = frameTs + currentDelayRef.current;
    const waitMs = Math.max(0, displayAt - Date.now());

    const timerId = setTimeout(() => {
      setCommentary((prev) => [
        { text, emotion },
        ...prev.slice(0, 19),
      ]);
      if (audio) {
        audioQueueRef.current.push(audio);
        playNextAudio();
      }
    }, waitMs);

    commentaryTimerIdsRef.current.push(timerId);
  }

  const startDelayedPlayback = useCallback(() => {
    let lastDisplayedUrl: string | null = null;
    lastTickTimeRef.current = performance.now();
    tickCountRef.current = 0;

    function tick() {
      const now = performance.now();
      const elapsed = now - lastTickTimeRef.current;
      lastTickTimeRef.current = now;
      tickCountRef.current++;

      // ---- Smoothly converge currentDelay toward targetDelay ----
      const target = targetDelayRef.current;
      const current = currentDelayRef.current;
      const diff = target - current;

      if (Math.abs(diff) > 50) {
        // Max step this tick: proportional to elapsed time
        const maxStep = (elapsed / 1000) * DELAY_CONVERGE_SPEED;
        const step = Math.sign(diff) * Math.min(Math.abs(diff), maxStep);
        currentDelayRef.current = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, current + step));
      }

      // Update React state for UI display ~2x per second (every 30 ticks at 60fps)
      if (tickCountRef.current % 30 === 0) {
        setDisplayDelay(Math.round(currentDelayRef.current));
      }

      // ---- Pick the right delayed frame to display ----
      const buffer = frameBufferRef.current;
      const targetTime = Date.now() - currentDelayRef.current;

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
    processingTimesRef.current = [];
    currentDelayRef.current = INITIAL_DELAY_MS;
    targetDelayRef.current = INITIAL_DELAY_MS;
    setDelayedFrameSrc(null);
    setDisplayDelay(INITIAL_DELAY_MS);
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
      setStatus('Connected! Calibrating sync...');
      if (persona) {
        ws.send(JSON.stringify({ type: 'set_persona', persona }));
      }
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
          const frameTs = msg.frame_ts || 0;

          // Update detection debug frame immediately
          if (msg.annotated_frame) {
            setDetection((prev) => ({
              annotatedFrame: msg.annotated_frame,
              personCount: prev?.personCount ?? 0,
              ballCount: prev?.ballCount ?? 0,
            }));
          }

          setStatus('Streaming + commenting!');
          const emotion = msg.emotion || 'neutral';
          const audio = msg.audio || null;

          if (frameTs > 0) {
            // Auto-tune the delay based on actual processing time
            updateTargetDelay(frameTs);
            // Schedule commentary to display when delayed video reaches this frame
            scheduleCommentary(msg.text, emotion, audio, frameTs);
          } else {
            // No sync info — display immediately
            setCommentary((prev) => [
              { text: msg.text, emotion },
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

      // Buffer every frame for smooth delayed playback
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>AI Sports Commentator</h1>
          {streaming && (
            <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
              sync: {(displayDelay / 1000).toFixed(1)}s
            </span>
          )}
        </div>
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
              <img
                src={delayedFrameSrc}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                alt="Delayed playback"
              />
            ) : (
              <span style={{ color: '#475569', fontSize: 13 }}>
                {streaming ? 'Calibrating sync...' : 'No video yet'}
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
