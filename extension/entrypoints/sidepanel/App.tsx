/**
 * Side Panel — receives frames from the content script (via Chrome port),
 * buffers them for delayed playback synced with AI commentary + TTS audio.
 *
 * Sync strategy: "Calibrate-then-play"
 * 1. Content script captures frames from YouTube's <video> element.
 * 2. Side panel receives frames, buffers them, and forwards to backend.
 * 3. When first commentary arrives, measure actual processing time.
 * 4. Lock video delay = processingTime + buffer. Never change it again.
 * 5. Start playing delayed video. Schedule all commentary with same delay.
 * Result: smooth playback + perfectly synced commentary from the start.
 */

import { useCallback, useRef, useState } from 'react';
import { BACKEND_WS_URL } from '../../lib/constants';
import { ProfileSetup, UserProfileData } from './ProfileSetup';

/** Buffer added on top of measured processing time. */
const DELAY_BUFFER_MS = 2500;
/** Min delay even if processing is somehow instant. */
const MIN_DELAY_MS = 3000;
/** Number of commentaries to sample before locking delay. */
const CALIBRATION_SAMPLES = 2;
/** Max frames in buffer (~60s at 5 FPS). */
const MAX_BUFFER_FRAMES = 300;

/** Convert a base64 string to a Blob for WebSocket binary send. */
function base64ToBlob(b64: string, mime = 'image/jpeg'): Blob {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

interface CommentaryEntry {
  text: string;
  emotion: string;
  analyst: string;
  capturedAt: number;
  displayedAt: number;
}

interface DetectionInfo {
  annotatedFrame: string;
  personCount: number;
  ballCount: number;
}

interface BufferedFrame {
  /** data:image/jpeg;base64,... URL for direct <img> src use. */
  src: string;
  timestamp: number;
}

export function App() {
  const [view, setView] = useState<'setup' | 'stream'>('setup');
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [status, setStatus] = useState('Click "Start Stream" to begin.');
  const [streaming, setStreaming] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [commentary, setCommentary] = useState<CommentaryEntry[]>([]);
  const [detection, setDetection] = useState<DetectionInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [delayedFrameSrc, setDelayedFrameSrc] = useState<string | null>(null);
  const [lockedDelayDisplay, setLockedDelayDisplay] = useState(0);

  const capturePortRef = useRef<chrome.runtime.Port | null>(null);
  const captureTabIdRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const playingAudioRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const frameBufferRef = useRef<BufferedFrame[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const commentaryTimerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const streamStartRef = useRef(0);

  // ---- Calibration state ----
  const calibratedRef = useRef(false);
  const lockedDelayRef = useRef(0);
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
      return false;
    }

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
        { text, emotion, analyst, capturedAt: frameTs, displayedAt: Date.now() },
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
    let lastDisplayedSrc: string | null = null;

    function tick() {
      const buffer = frameBufferRef.current;
      const targetTime = Date.now() - lockedDelayRef.current;

      let bestIdx = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].timestamp <= targetTime) {
          bestIdx = i;
          break;
        }
      }

      if (bestIdx >= 0 && buffer[bestIdx].src !== lastDisplayedSrc) {
        lastDisplayedSrc = buffer[bestIdx].src;
        setDelayedFrameSrc(lastDisplayedSrc);

        // Drop older frames (no URL.revokeObjectURL needed for data URLs)
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
    setStatus('Finding YouTube tab...');
    setCommentary([]);
    setDetection(null);

    try {
      // Find the active YouTube tab
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) {
        setStatus('No active tab found. Open a YouTube video first.');
        return;
      }

      if (!tab.url?.includes('youtube.com')) {
        setStatus('Active tab is not YouTube. Navigate to a YouTube video first.');
        return;
      }

      const tabId = tab.id;
      captureTabIdRef.current = tabId;

      // Ensure the content script is loaded on this tab.
      // After extension reload, already-open tabs won't have it.
      setStatus('Injecting capture script...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content-scripts/content.js'],
        });
        console.log('[AI Commentator] Content script injected into tab %d', tabId);
      } catch (injectErr) {
        // May fail if already injected — that's fine
        console.log('[AI Commentator] Script injection skipped (may be already loaded):', injectErr);
      }

      // Small delay to let the content script's onConnect listener register
      await new Promise((r) => setTimeout(r, 200));

      // Connect to the content script via a port
      setStatus('Connecting to tab...');
      const port = chrome.tabs.connect(tabId, { name: 'capture' });
      capturePortRef.current = port;

      let gotFirstFrame = false;

      // Listen for frames from the content script
      port.onMessage.addListener((msg) => {
        if (msg.type === 'FRAME') {
          if (!gotFirstFrame) {
            gotFirstFrame = true;
            console.log('[AI Commentator] First frame received from content script');
          }
          handleFrame(msg.data as string, msg.ts as number);
        } else if (msg.type === 'CAPTURE_ACTIVE') {
          console.log('[AI Commentator] Content script capture is active');
          setStatus('Capturing — calibrating sync...');
        } else if (msg.type === 'ERROR') {
          setStatus(`Capture error: ${msg.message}`);
          stopStream();
        }
      });

      port.onDisconnect.addListener(() => {
        console.log('[AI Commentator] Capture port disconnected, lastError:', chrome.runtime.lastError?.message);
        // Only auto-stop if we were actively streaming
        if (capturePortRef.current === port) {
          stopStream();
          setStatus('Tab disconnected. Click "Start Stream" to reconnect.');
        }
      });

      setStreaming(true);
      setStatus('Connecting to backend...');

      // Open WebSocket to backend
      connectWebSocket();

      // Tell content script to start capturing
      port.postMessage({ type: 'START_CAPTURE' });
      console.log('[AI Commentator] Sent START_CAPTURE to content script');
    } catch (err) {
      console.error('[AI Commentator] Start error:', err);
      setStatus(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Handle a frame received from the content script. */
  function handleFrame(base64: string, ts: number) {
    const src = `data:image/jpeg;base64,${base64}`;

    // Buffer for delayed playback
    frameBufferRef.current.push({ src, timestamp: ts });
    while (frameBufferRef.current.length > MAX_BUFFER_FRAMES) {
      frameBufferRef.current.shift();
    }

    // Forward to backend WebSocket as binary
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'frame_ts', ts }));
      ws.send(base64ToBlob(base64));
    }
  }

  function connectWebSocket() {
    const ws = new WebSocket(BACKEND_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[AI Commentator] WebSocket connected');
      streamStartRef.current = Date.now();
      setStatus('Calibrating sync — first commentary incoming...');
      if (userProfile) {
        ws.send(JSON.stringify({ type: 'set_profile', profile: userProfile }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
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

          if (msg.annotated_frame) {
            setDetection((prev) => ({
              annotatedFrame: msg.annotated_frame,
              personCount: prev?.personCount ?? 0,
              ballCount: prev?.ballCount ?? 0,
            }));
          }

          if (frameTs > 0 && !calibratedRef.current) {
            const locked = calibrate(frameTs);
            if (!locked) {
              setCommentary((prev) => [
                { text: msg.text, emotion, analyst, capturedAt: frameTs || Date.now(), displayedAt: Date.now() },
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
            scheduleCommentary(msg.text, emotion, analyst, audio, frameTs);
            setStatus('Live — synced!');
          } else if (frameTs === 0) {
            setCommentary((prev) => [
              { text: msg.text, emotion, analyst, capturedAt: frameTs || Date.now(), displayedAt: Date.now() },
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
      stopDelayedPlayback();
    };
  }

  // ---- Audio playback (queue with graceful handoff) ----

  function playNextAudio() {
    if (playingAudioRef.current) {
      if (audioQueueRef.current.length > 2 && currentAudioRef.current) {
        while (audioQueueRef.current.length > 1) {
          audioQueueRef.current.shift();
        }
        currentAudioRef.current.pause();
        currentAudioRef.current.src = '';
        currentAudioRef.current = null;
        playingAudioRef.current = false;
      } else {
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
    stopDelayedPlayback();

    // Tell content script to stop and disconnect port
    if (capturePortRef.current) {
      try {
        capturePortRef.current.postMessage({ type: 'STOP_CAPTURE' });
      } catch {
        // Port may already be disconnected
      }
      capturePortRef.current.disconnect();
      capturePortRef.current = null;
    }
    captureTabIdRef.current = null;

    // Close backend WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    // Stop any playing audio
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

  function fmtTime(ms: number): string {
    const elapsed = Math.max(0, Math.round((ms - streamStartRef.current) / 1000));
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ---- Profile setup view ----
  if (view === 'setup') {
    return (
      <ProfileSetup
        onComplete={(profile) => {
          setUserProfile(profile);
          setView('stream');
        }}
        onSkip={() => setView('stream')}
      />
    );
  }

  // ---- Streaming view ----
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

        {/* User profile badge */}
        {userProfile && (
          <div style={{ padding: '4px 16px 8px' }}>
            <div
              style={{
                padding: '8px 12px', borderRadius: 6,
                background: '#1e293b', border: '1px solid #334155',
                fontSize: 12, color: '#94a3b8',
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <span style={{ color: '#7c3aed', fontWeight: 700 }}>{userProfile.name}</span>
              {userProfile.favorite_team && (
                <span style={{ color: '#64748b' }}>{userProfile.favorite_team}</span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
                {userProfile.expertise_slider > 60 ? 'Expert' : userProfile.expertise_slider > 30 ? 'Casual' : 'Beginner'}
              </span>
            </div>
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
                  <span style={{ marginLeft: 'auto', fontSize: 8, color: '#475569', fontFamily: 'monospace' }}
                    title={`Captured: ${fmtTime(entry.capturedAt)} | Displayed: ${fmtTime(entry.displayedAt)} | Delay: ${lockedDelayDisplay}ms`}
                  >
                    {fmtTime(entry.capturedAt)} +{((entry.displayedAt - entry.capturedAt) / 1000).toFixed(1)}s
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
              3. Commentary + synced video will appear here<br />
              4. The YouTube tab video will be hidden
            </p>
          </div>
        )}
      </div>

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
