/**
 * Side Panel — captures frames from the YouTube tab via content script,
 * forwards them to the backend for AI commentary, and displays commentary
 * text + plays TTS audio in the sidebar. The YouTube video plays normally
 * in its tab (no overlay, no muting).
 */

import { useRef, useState } from 'react';
import { BACKEND_WS_URL } from '../../lib/constants';
import { ProfileSetup, UserProfileData } from './ProfileSetup';

/** Send every Nth frame to backend (15 FPS / 5 = 3 FPS to Claude). */
const BACKEND_SEND_EVERY = 5;

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
  timestamp: number;
}

export function App() {
  const [view, setView] = useState<'setup' | 'stream'>('setup');
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [sport, setSport] = useState<'soccer' | 'football'>('football');
  const [status, setStatus] = useState('Click "Start Stream" to begin.');
  const [streaming, setStreaming] = useState(false);
  const [commentary, setCommentary] = useState<CommentaryEntry[]>([]);
  const [paused, setPaused] = useState(false);

  const capturePortRef = useRef<chrome.runtime.Port | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const playingAudioRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const frameCountRef = useRef(0);
  const pausedRef = useRef(false);

  // ---- Stream lifecycle ----

  async function startStream() {
    setStatus('Finding YouTube tab...');
    setCommentary([]);

    try {
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

      // Inject content script (may already be loaded)
      setStatus('Injecting capture script...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content-scripts/content.js'],
        });
      } catch {
        // Already injected — fine
      }

      await new Promise((r) => setTimeout(r, 200));

      // Connect to content script
      setStatus('Connecting to tab...');
      const port = chrome.tabs.connect(tabId, { name: 'capture' });
      capturePortRef.current = port;

      let gotFirstFrame = false;

      port.onMessage.addListener((msg) => {
        if (msg.type === 'FRAME') {
          if (!gotFirstFrame) {
            gotFirstFrame = true;
            setStatus('Capturing frames — waiting for first commentary...');
          }
          handleFrame(msg.data as string, msg.ts as number);
        } else if (msg.type === 'CAPTURE_ACTIVE') {
          setStatus('Capturing...');
        } else if (msg.type === 'ERROR') {
          setStatus(`Capture error: ${msg.message}`);
          stopStream();
        }
      });

      port.onDisconnect.addListener(() => {
        if (capturePortRef.current === port) {
          stopStream();
          setStatus('Tab disconnected. Click "Start Stream" to reconnect.');
        }
      });

      setStreaming(true);
      setStatus('Connecting to backend...');
      connectWebSocket();

      frameCountRef.current = 0;
      port.postMessage({ type: 'START_CAPTURE' });
    } catch (err) {
      setStatus(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Forward every Nth frame to backend. */
  function handleFrame(base64: string, ts: number) {
    frameCountRef.current++;
    if (frameCountRef.current % BACKEND_SEND_EVERY === 0) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'frame_ts', ts }));
        ws.send(base64ToBlob(base64));
      }
    }
  }

  function connectWebSocket() {
    const ws = new WebSocket(BACKEND_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('Connected — waiting for first commentary...');
      ws.send(JSON.stringify({ type: 'set_sport', sport }));
      if (userProfile) {
        ws.send(JSON.stringify({ type: 'set_profile', profile: userProfile }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          // Only show backend status if we're past initial setup
          if (commentary.length > 0 || msg.message.includes('Ready')) {
            setStatus(msg.message);
          }
        } else if (msg.type === 'commentary') {
          const emotion = msg.emotion || 'neutral';
          const analyst = msg.analyst || 'Danny';
          const audio = msg.audio || null;

          setCommentary((prev) => [
            { text: msg.text, emotion, analyst, timestamp: Date.now() },
            ...prev.slice(0, 29),
          ]);
          setStatus('Live');

          if (audio) {
            audioQueueRef.current.push(audio);
            playNextAudio();
          }
        }
      } catch (err) {
        console.error('[AI Commentator] WS parse error:', err);
      }
    };

    ws.onerror = () => {
      setStatus('Backend connection error — is the server running?');
    };

    ws.onclose = () => {
      console.log('[AI Commentator] WebSocket closed');
    };
  }

  // ---- Audio queue ----

  function playNextAudio() {
    if (pausedRef.current) return;
    if (playingAudioRef.current) {
      // If queue backs up, drop old entries and skip to latest
      if (audioQueueRef.current.length > 2 && currentAudioRef.current) {
        while (audioQueueRef.current.length > 1) audioQueueRef.current.shift();
        currentAudioRef.current.pause();
        currentAudioRef.current.src = '';
        currentAudioRef.current = null;
        playingAudioRef.current = false;
      } else {
        return;
      }
    }

    const base64 = audioQueueRef.current.shift();
    if (!base64) { playingAudioRef.current = false; return; }

    playingAudioRef.current = true;
    const audio = new Audio(`data:audio/mp3;base64,${base64}`);
    currentAudioRef.current = audio;
    audio.onended = () => { playingAudioRef.current = false; currentAudioRef.current = null; playNextAudio(); };
    audio.onerror = () => { playingAudioRef.current = false; currentAudioRef.current = null; playNextAudio(); };
    audio.play().catch(() => { playingAudioRef.current = false; currentAudioRef.current = null; playNextAudio(); });
  }

  // ---- Pause / Resume ----

  function togglePause() {
    if (pausedRef.current) {
      // Resume
      pausedRef.current = false;
      setPaused(false);
      if (currentAudioRef.current?.paused) currentAudioRef.current.play().catch(() => {});
      playNextAudio();
      try { capturePortRef.current?.postMessage({ type: 'RESUME_CAPTURE' }); } catch {}
      setStatus('Live');
    } else {
      // Pause
      pausedRef.current = true;
      setPaused(true);
      if (currentAudioRef.current && !currentAudioRef.current.paused) currentAudioRef.current.pause();
      try { capturePortRef.current?.postMessage({ type: 'PAUSE_CAPTURE' }); } catch {}
      setStatus('Paused');
    }
  }

  // ---- Stop ----

  function stopStream() {
    if (capturePortRef.current) {
      try { capturePortRef.current.postMessage({ type: 'STOP_CAPTURE' }); } catch {}
      capturePortRef.current.disconnect();
      capturePortRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    wsRef.current = null;
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }
    audioQueueRef.current = [];
    playingAudioRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setStreaming(false);
  }

  // ---- Render ----

  const emotionColor: Record<string, string> = {
    excited: '#facc15', celebratory: '#4ade80', tense: '#f97316',
    urgent: '#ef4444', disappointed: '#94a3b8', thoughtful: '#60a5fa', neutral: '#cbd5e1',
  };

  const analystColor: Record<string, string> = {
    Danny: '#7c3aed', 'Coach Kay': '#0ea5e9', Rookie: '#f97316',
  };

  // ---- Profile setup ----
  if (view === 'setup') {
    return (
      <ProfileSetup
        onComplete={(profile) => { setUserProfile(profile); setView('stream'); }}
        onSkip={() => setView('stream')}
      />
    );
  }

  // ---- Streaming view ----
  return (
    <div style={{
      fontFamily: 'system-ui, -apple-system, sans-serif',
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: '#0f172a', color: 'white',
    }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>AI Sports Commentator</h1>
          {streaming && (
            <button
              onClick={togglePause}
              style={{
                background: 'none', border: '1px solid #334155', borderRadius: 6,
                color: paused ? '#facc15' : '#4ade80', fontSize: 11, fontWeight: 600,
                padding: '3px 10px', cursor: 'pointer',
              }}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: streaming ? (paused ? '#facc15' : '#4ade80') : '#ef4444',
          }} />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* User profile badge */}
        {userProfile && (
          <div style={{ padding: '8px 16px 4px' }}>
            <div style={{
              padding: '8px 12px', borderRadius: 6,
              background: '#1e293b', border: '1px solid #334155',
              fontSize: 12, color: '#94a3b8',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
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

        {/* Sport selector + Controls */}
        <div style={{ padding: '4px 16px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{
            display: 'flex', borderRadius: 8, overflow: 'hidden',
            border: '1px solid #334155',
          }}>
            {(['football', 'soccer'] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  setSport(s);
                  const ws = wsRef.current;
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'set_sport', sport: s }));
                  }
                }}
                style={{
                  flex: 1, padding: '6px 0', border: 'none', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  background: sport === s ? '#7c3aed' : '#1e293b',
                  color: sport === s ? 'white' : '#64748b',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {s === 'football' ? 'Football' : 'Soccer'}
              </button>
            ))}
          </div>

          <button
            onClick={streaming ? () => { stopStream(); setStatus('Stopped.'); } : startStream}
            style={{
              width: '100%', padding: '10px 16px', borderRadius: 8, border: 'none',
              cursor: 'pointer', fontWeight: 600, fontSize: 14,
              backgroundColor: streaming ? '#ef4444' : '#7c3aed', color: 'white',
            }}
          >
            {streaming ? 'Stop' : 'Start Stream'}
          </button>
        </div>

        {/* Commentary feed */}
        {commentary.length > 0 && (
          <div style={{ padding: '0 16px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {commentary.map((entry, i) => (
              <div
                key={`${entry.timestamp}-${i}`}
                style={{
                  padding: '8px 12px', borderRadius: 8,
                  background: '#1e293b',
                  borderLeft: `3px solid ${analystColor[entry.analyst] || '#7c3aed'}`,
                  opacity: i === 0 ? 1 : 0.7 - i * 0.03,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    color: analystColor[entry.analyst] || '#7c3aed',
                  }}>
                    {entry.analyst}
                  </span>
                  <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 4,
                    background: `${emotionColor[entry.emotion] || '#cbd5e1'}22`,
                    color: emotionColor[entry.emotion] || '#cbd5e1',
                    textTransform: 'uppercase', fontWeight: 600,
                  }}>
                    {entry.emotion}
                  </span>
                </div>
                <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5, color: '#e2e8f0' }}>
                  {entry.text}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Waiting state */}
        {streaming && commentary.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <div style={{
              width: 28, height: 28, border: '3px solid #334155',
              borderTop: '3px solid #7c3aed', borderRadius: '50%',
              animation: 'spin 1s linear infinite', margin: '0 auto 12px',
            }} />
            <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
              Analyzing video — first commentary incoming...
            </p>
          </div>
        )}

        {/* Instructions */}
        {!streaming && commentary.length === 0 && (
          <div style={{ padding: '16px' }}>
            <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', lineHeight: 1.6 }}>
              1. Open a YouTube video in any tab<br />
              2. Select your sport above<br />
              3. Click "Start Stream"<br />
              4. AI commentary will appear here with audio
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
