import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfileData {
  name: string;
  favorite_team: string | null;
  rival_team: string | null;
  expertise_slider: number;
  hot_take_slider: number;
  voice_key: string;
  favorite_players: string[];
  interests: string[];
}

export interface ProfileSetupProps {
  onComplete: (profile: UserProfileData) => void;
  onSkip: () => void;
}

const BACKEND_URL = 'http://localhost:8000';
const AGENT_ID = 'agent_DjLxh2mFbRjouYAXQVGpzr';
const SAMPLE_RATE = 44100;
const COMPLETION_PHRASE = "i've got the full picture";

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Convert a Float32Array of PCM samples to 16-bit PCM and base64 encode. */
function float32ToBase64Pcm(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 PCM (16-bit signed LE) to Float32Array. */
function base64PcmToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProfileSetup({ onComplete, onSkip }: ProfileSetupProps) {
  const [status, setStatus] = useState('Connecting to Danny...');
  const [isActive, setIsActive] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState<{ role: string; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mountedRef = useRef(true);
  const initCalledRef = useRef(false);
  const streamIdRef = useRef<string>('');
  const transcriptRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Gapless audio scheduling: schedule each chunk to start exactly when
  // the previous one ends, using AudioContext.currentTime for precision.
  const nextPlayTimeRef = useRef(0);

  // ---- Auto-scroll ----
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptLines]);

  // ---- Schedule agent audio chunk for gapless playback ----
  const scheduleAudioChunk = useCallback((samples: Float32Array) => {
    const ctx = audioCtxRef.current;
    if (!ctx || samples.length === 0) return;

    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    // Schedule this chunk right after the previous one ends (gapless).
    // If we've fallen behind (nextPlayTime < now), start immediately.
    const now = ctx.currentTime;
    const startAt = Math.max(now, nextPlayTimeRef.current);
    src.start(startAt);
    nextPlayTimeRef.current = startAt + buf.duration;
  }, []);

  // ---- Connect to Cartesia voice agent ----
  const connect = useCallback(async () => {
    setError(null);
    setStatus('Getting access token...');

    // 1. Get access token from our backend
    let token: string;
    try {
      const res = await fetch(`${BACKEND_URL}/api/agent-token`, { method: 'POST' });
      if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
      const data = await res.json();
      token = data.token;
    } catch (err) {
      setError(`Failed to get token: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 2. Request mic permission
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE } });
      micStreamRef.current = micStream;
    } catch {
      // Try opening permission popup for Chrome extension
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL('mic-permission.html'),
          type: 'popup',
          width: 400,
          height: 300,
          focused: true,
        });
        setError('Please grant mic access in the popup, then click "Talk to Danny" again.');
      } catch {
        setError('Mic access denied. Enable it in Chrome settings.');
      }
      return;
    }

    setStatus('Connecting to Danny...');

    // 3. Set up AudioContext for mic capture + playback
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    // 4. Connect WebSocket to Cartesia voice agent
    // Browser WebSocket can't set headers, so Cartesia uses ?access_token= for browser clients.
    const ws = new WebSocket(
      `wss://api.cartesia.ai/agents/stream/${AGENT_ID}?access_token=${token}&cartesia_version=2025-04-16`,
    );

    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      console.log('[ProfileSetup] WebSocket connected to Cartesia agent');
      setStatus('Connected! Danny is greeting you...');
      setIsActive(true);

      // Send start event
      ws.send(JSON.stringify({
        event: 'start',
        config: { input_format: `pcm_${SAMPLE_RATE}` },
      }));
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data);

        if (msg.event === 'ack') {
          streamIdRef.current = msg.stream_id || '';
          console.log('[ProfileSetup] Stream ack:', streamIdRef.current);

          // Now start sending mic audio
          startMicCapture(audioCtx, micStream, ws);
        }

        if (msg.event === 'media_output' && msg.media?.payload) {
          // Agent audio — decode and schedule for gapless playback
          const samples = base64PcmToFloat32(msg.media.payload);
          scheduleAudioChunk(samples);
        }

        if (msg.event === 'transcript') {
          // Agent or user transcript
          const role = msg.role || 'assistant';
          const text = msg.text || msg.transcript || '';
          if (text) {
            setTranscriptLines((prev) => [...prev, { role, text }]);
            transcriptRef.current += `${role === 'assistant' ? 'Danny' : 'User'}: ${text}\n`;

            // Check for completion phrase
            if (role === 'assistant' && text.toLowerCase().includes(COMPLETION_PHRASE)) {
              handleConversationComplete();
            }
          }
        }
      } catch (err) {
        console.error('[ProfileSetup] WS message parse error:', err);
      }
    };

    ws.onerror = (evt) => {
      if (!mountedRef.current) return;
      console.error('[ProfileSetup] WS error:', evt);
      setError('Connection to voice agent failed. Check console for details.');
      setIsActive(false);
    };

    ws.onclose = (evt) => {
      if (!mountedRef.current) return;
      console.log('[ProfileSetup] WS closed: code=%d reason=%s wasClean=%s', evt.code, evt.reason, evt.wasClean);
      if (evt.code !== 1000 && evt.code !== 1005 && !transcriptRef.current) {
        // Unexpected close before any conversation happened
        setError(`Voice agent disconnected (code ${evt.code}${evt.reason ? ': ' + evt.reason : ''}). Try again.`);
      }
      if (evt.reason === 'call ended by agent') {
        handleConversationComplete();
      }
      setIsActive(false);
      setIsMicOn(false);
    };
  }, [scheduleAudioChunk]);

  // ---- Mic capture via ScriptProcessor (worklet requires module URL) ----
  function startMicCapture(audioCtx: AudioContext, micStream: MediaStream, ws: WebSocket) {
    const source = audioCtx.createMediaStreamSource(micStream);

    // Use ScriptProcessor for simplicity (deprecated but works everywhere)
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN || !streamIdRef.current) return;
      const samples = e.inputBuffer.getChannelData(0);
      const b64 = float32ToBase64Pcm(samples);
      ws.send(JSON.stringify({
        event: 'media_input',
        stream_id: streamIdRef.current,
        media: { payload: b64 },
      }));
    };

    // ScriptProcessor must be connected to a destination to fire onaudioprocess.
    // Use a silent GainNode so mic audio doesn't echo through speakers.
    const silentDest = audioCtx.createGain();
    silentDest.gain.value = 0;
    silentDest.connect(audioCtx.destination);

    source.connect(processor);
    processor.connect(silentDest);
    setIsMicOn(true);
  }

  // ---- Extract profile when Danny signals completion ----
  const handleConversationComplete = useCallback(async () => {
    setStatus('Extracting your profile...');

    // Close the voice agent connection
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    stopMic();

    // Send transcript to our backend for structured extraction
    try {
      const res = await fetch(`${BACKEND_URL}/api/extract-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcriptRef.current }),
      });
      if (!res.ok) throw new Error(`Extract failed: ${res.status}`);
      const data = await res.json();

      if (mountedRef.current && data.profile) {
        setStatus('Profile ready!');
        setTimeout(() => {
          if (mountedRef.current) onComplete(data.profile);
        }, 1000);
      }
    } catch (err) {
      console.error('[ProfileSetup] Profile extraction failed:', err);
      setError('Could not extract profile. Using defaults.');
      setTimeout(() => onSkip(), 1500);
    }
  }, [onComplete, onSkip]);

  // ---- Cleanup ----
  function stopMic() {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setIsMicOn(false);
  }

  function disconnect() {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    stopMic();
    nextPlayTimeRef.current = 0;
    setIsActive(false);
  }

  useEffect(() => {
    mountedRef.current = true;

    if (!initCalledRef.current) {
      initCalledRef.current = true;
      connect();
    }

    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [connect]);

  // ---- Render ----

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
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid #1e293b',
          flexShrink: 0,
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
          Meet Your Commentator
        </h1>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>
          Have a voice conversation with Danny before the game
        </p>
      </div>

      {/* Status bar */}
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: isActive ? (isMicOn ? '#4ade80' : '#facc15') : '#ef4444',
          }}
        />
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
      </div>

      {/* Conversation visual */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Active voice indicator */}
        {isActive && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px 0',
            }}
          >
            <div
              style={{
                width: 80, height: 80, borderRadius: '50%',
                background: isMicOn
                  ? 'radial-gradient(circle, #7c3aed 0%, #4c1d95 70%)'
                  : 'radial-gradient(circle, #475569 0%, #1e293b 70%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                animation: isMicOn ? 'pulse-voice 2s ease-in-out infinite' : 'none',
                boxShadow: isMicOn ? '0 0 30px rgba(124, 58, 237, 0.4)' : 'none',
              }}
            >
              {/* Mic icon */}
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </div>
            <p style={{ fontSize: 13, color: '#94a3b8', marginTop: 12, textAlign: 'center' }}>
              {isMicOn ? 'Listening — just talk naturally' : 'Connecting mic...'}
            </p>
          </div>
        )}

        {/* Transcript bubbles */}
        {transcriptLines.map((line, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: line.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '85%',
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.5,
                ...(line.role !== 'user'
                  ? { background: '#1e293b', borderLeft: '3px solid #7c3aed', color: '#e2e8f0' }
                  : { background: '#334155', color: '#e2e8f0' }),
              }}
            >
              {line.role !== 'user' && (
                <div style={{
                  fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                  color: '#7c3aed', marginBottom: 4, letterSpacing: '0.05em',
                }}>
                  Danny
                </div>
              )}
              {line.text}
            </div>
          </div>
        ))}

        {/* Error */}
        {error && (
          <div
            style={{
              padding: '8px 12px', borderRadius: 6,
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#fca5a5', fontSize: 12, textAlign: 'center',
            }}
          >
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom controls */}
      <div
        style={{
          flexShrink: 0,
          padding: '12px 16px',
          borderTop: '1px solid #1e293b',
          textAlign: 'center',
        }}
      >
        {!isActive && !error && (
          <button
            onClick={() => { initCalledRef.current = false; connect(); }}
            style={{
              width: '100%', padding: '10px 16px', borderRadius: 8,
              border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
              backgroundColor: '#7c3aed', color: 'white',
            }}
          >
            Talk to Danny
          </button>
        )}

        {error && (
          <button
            onClick={() => { setError(null); initCalledRef.current = false; connect(); }}
            style={{
              width: '100%', padding: '10px 16px', borderRadius: 8,
              border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
              backgroundColor: '#7c3aed', color: 'white', marginBottom: 8,
            }}
          >
            Try Again
          </button>
        )}

        <button
          onClick={() => { disconnect(); onSkip(); }}
          style={{
            background: 'none', border: 'none', color: '#64748b',
            fontSize: 12, cursor: 'pointer', padding: '4px 8px',
            marginTop: isActive ? 0 : 8,
          }}
        >
          Skip setup and use defaults
        </button>
      </div>

      <style>{`
        @keyframes pulse-voice {
          0%, 100% { transform: scale(1); box-shadow: 0 0 20px rgba(124, 58, 237, 0.3); }
          50% { transform: scale(1.08); box-shadow: 0 0 40px rgba(124, 58, 237, 0.6); }
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
      `}</style>
    </div>
  );
}
