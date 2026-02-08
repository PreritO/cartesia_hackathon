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

const EXPERIENCE_MAP: Record<string, number> = {
  beginner: 15,
  casual: 40,
  knowledgeable: 65,
  expert: 90,
};

const STYLE_MAP: Record<string, number> = {
  balanced: 25,
  moderate: 50,
  homer: 80,
};

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

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

type View = 'call' | 'form';

export function ProfileSetup({ onComplete, onSkip }: ProfileSetupProps) {
  // ---- Shared state ----
  const [view, setView] = useState<View>('call');
  const [error, setError] = useState<string | null>(null);

  // ---- Call state ----
  const [status, setStatus] = useState('Connecting to Danny...');
  const [isActive, setIsActive] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);

  // ---- Form state (post-call) ----
  const [formName, setFormName] = useState('');
  const [formTeam, setFormTeam] = useState('');
  const [formExperience, setFormExperience] = useState('casual');
  const [formStyle, setFormStyle] = useState('balanced');
  const [formPlayers, setFormPlayers] = useState('');
  const [extracting, setExtracting] = useState(false);

  // ---- Refs ----
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const initCalledRef = useRef(false);
  const streamIdRef = useRef<string>('');
  const nextPlayTimeRef = useRef(0);

  // ---- Gapless audio playback ----
  const scheduleAudioChunk = useCallback((samples: Float32Array) => {
    const ctx = audioCtxRef.current;
    if (!ctx || samples.length === 0) return;

    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, nextPlayTimeRef.current);
    src.start(startAt);
    nextPlayTimeRef.current = startAt + buf.duration;
  }, []);

  // ---- Connect to Cartesia voice agent ----
  const connect = useCallback(async () => {
    setError(null);
    setStatus('Getting access token...');

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

    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE } });
      micStreamRef.current = micStream;
    } catch {
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL('mic-permission.html'),
          type: 'popup', width: 400, height: 300, focused: true,
        });
        setError('Please grant mic access in the popup, then click "Talk to Danny" again.');
      } catch {
        setError('Mic access denied. Enable it in Chrome settings.');
      }
      return;
    }

    setStatus('Connecting to Danny...');

    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    const ws = new WebSocket(
      `wss://api.cartesia.ai/agents/stream/${AGENT_ID}?access_token=${token}&cartesia_version=2025-04-16`,
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      console.log('[ProfileSetup] WebSocket connected');
      setStatus('Connected! Danny is greeting you...');
      setIsActive(true);
      ws.send(JSON.stringify({
        event: 'start',
        config: { input_format: `pcm_${SAMPLE_RATE}` },
      }));
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data);

        if (msg.event !== 'media_output') {
          console.log('[ProfileSetup] Event:', msg.event, msg);
        }

        if (msg.event === 'ack') {
          streamIdRef.current = msg.stream_id || '';
          startMicCapture(audioCtx, micStream, ws);
        }

        if (msg.event === 'media_output' && msg.media?.payload) {
          const samples = base64PcmToFloat32(msg.media.payload);
          scheduleAudioChunk(samples);
        }
      } catch (err) {
        console.error('[ProfileSetup] WS parse error:', err);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setError('Connection to voice agent failed.');
      setIsActive(false);
    };

    ws.onclose = (evt) => {
      if (!mountedRef.current) return;
      console.log('[ProfileSetup] WS closed: code=%d reason=%s', evt.code, evt.reason);

      // Agent ended the call → show profile form
      if (evt.code === 1000 && (evt.reason === 'call ended by agent' || evt.reason === 'connection cancelled')) {
        finishCall();
      } else if (evt.code !== 1000 && evt.code !== 1005) {
        setError(`Disconnected (code ${evt.code}). Try again.`);
      }

      setIsActive(false);
      setIsMicOn(false);
    };
  }, [scheduleAudioChunk]);

  // ---- Mic capture ----
  function startMicCapture(audioCtx: AudioContext, micStream: MediaStream, ws: WebSocket) {
    const source = audioCtx.createMediaStreamSource(micStream);
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

    const silentDest = audioCtx.createGain();
    silentDest.gain.value = 0;
    silentDest.connect(audioCtx.destination);
    source.connect(processor);
    processor.connect(silentDest);
    setIsMicOn(true);
  }

  // ---- Transition from call → form ----
  async function finishCall() {
    stopMic();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    setView('form');
    setExtracting(true);

    // Fetch transcript + extract profile from Cartesia call
    try {
      const res = await fetch(`${BACKEND_URL}/api/call-transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: AGENT_ID }),
      });
      if (res.ok) {
        const data = await res.json();
        const p = data.profile;
        console.log('[ProfileSetup] Profile extracted from transcript:', p);
        if (p) {
          setFormName(p.name || '');
          setFormTeam(p.favorite_team || '');
          if (p.experience) setFormExperience(p.experience);
          if (p.style) setFormStyle(p.style);
          if (p.favorite_players?.length) setFormPlayers(p.favorite_players.join(', '));
        }
      } else {
        console.warn('[ProfileSetup] Failed to fetch transcript:', res.status);
      }
    } catch (err) {
      console.warn('[ProfileSetup] Error fetching transcript:', err);
    }
    setExtracting(false);
  }

  // ---- Submit profile form ----
  function submitProfile() {
    const profile: UserProfileData = {
      name: formName.trim() || 'Fan',
      favorite_team: formTeam.trim() || null,
      rival_team: null,
      expertise_slider: EXPERIENCE_MAP[formExperience] ?? 40,
      hot_take_slider: STYLE_MAP[formStyle] ?? 25,
      voice_key: 'danny',
      favorite_players: formPlayers.trim() ? formPlayers.split(',').map((s) => s.trim()) : [],
      interests: [],
    };
    onComplete(profile);
  }

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
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
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
    return () => { mountedRef.current = false; disconnect(); };
  }, [connect]);

  // ===========================================================================
  // Render
  // ===========================================================================

  const containerStyle = {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#0f172a',
    color: 'white',
  };

  const headerStyle = {
    padding: '16px 16px 12px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
    textAlign: 'center' as const,
  };

  // ---- Form view (after call ends) ----
  if (view === 'form') {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Quick Confirm</h1>
          <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>
            {extracting ? 'Extracting what Danny learned...' : 'Verify what Danny learned, then let\'s watch!'}
          </p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FormField label="Your Name" value={formName} onChange={setFormName} placeholder="e.g. Prerit" />
          <FormField label="Favorite Team" value={formTeam} onChange={setFormTeam} placeholder="e.g. Arsenal" />

          <div>
            <label style={labelStyle}>Experience Level</label>
            <select value={formExperience} onChange={(e) => setFormExperience(e.target.value)} style={selectStyle}>
              <option value="beginner">Beginner — explain everything</option>
              <option value="casual">Casual — knows the basics</option>
              <option value="knowledgeable">Knowledgeable — loves tactics</option>
              <option value="expert">Expert — deep analysis</option>
            </select>
          </div>

          <div>
            <label style={labelStyle}>Commentary Style</label>
            <select value={formStyle} onChange={(e) => setFormStyle(e.target.value)} style={selectStyle}>
              <option value="balanced">Balanced — fair for both sides</option>
              <option value="moderate">Moderate — slight bias to my team</option>
              <option value="homer">Homer — full fan mode!</option>
            </select>
          </div>

          <FormField label="Favorite Players" value={formPlayers} onChange={setFormPlayers} placeholder="e.g. Saka, Salah" />
        </div>

        <div style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid #1e293b', textAlign: 'center' }}>
          <button onClick={submitProfile} style={{
            width: '100%', padding: '12px 16px', borderRadius: 8,
            border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
            backgroundColor: '#4ade80', color: '#0f172a',
          }}>
            Let's Watch!
          </button>
        </div>

        <style>{scrollbarCss}</style>
      </div>
    );
  }

  // ---- Call view (talking to Danny) ----
  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Meet Your Commentator</h1>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>
          Have a voice conversation with Danny before the game
        </p>
      </div>

      {/* Status */}
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: isActive ? (isMicOn ? '#4ade80' : '#facc15') : '#ef4444',
        }} />
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
      </div>

      {/* Voice indicator */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
        {isActive && (
          <>
            <div style={{
              width: 100, height: 100, borderRadius: '50%',
              background: isMicOn
                ? 'radial-gradient(circle, #7c3aed 0%, #4c1d95 70%)'
                : 'radial-gradient(circle, #475569 0%, #1e293b 70%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: isMicOn ? 'pulse-voice 2s ease-in-out infinite' : 'none',
              boxShadow: isMicOn ? '0 0 30px rgba(124, 58, 237, 0.4)' : 'none',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </div>
            <p style={{ fontSize: 14, color: '#e2e8f0', marginTop: 16, textAlign: 'center', fontWeight: 500 }}>
              Talking to Danny
            </p>
            <p style={{ fontSize: 12, color: '#64748b', marginTop: 4, textAlign: 'center' }}>
              Just speak naturally — he'll ask you a few questions
            </p>
          </>
        )}

        {error && (
          <div style={{
            padding: '8px 12px', borderRadius: 6, marginTop: 16,
            background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#fca5a5', fontSize: 12, textAlign: 'center',
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid #1e293b', textAlign: 'center' }}>
        {isActive && (
          <button onClick={finishCall} style={{
            width: '100%', padding: '12px 16px', borderRadius: 8,
            border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
            backgroundColor: '#4ade80', color: '#0f172a', marginBottom: 8,
          }}>
            Done — Next Step
          </button>
        )}

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
            fontSize: 12, cursor: 'pointer', padding: '4px 8px', marginTop: 4,
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
        ${scrollbarCss}
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles & small components
// ---------------------------------------------------------------------------

const labelStyle = {
  fontSize: 11,
  color: '#94a3b8',
  display: 'block' as const,
  marginBottom: 4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  fontWeight: 600,
};

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 6,
  border: '1px solid #334155',
  background: '#1e293b',
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box' as const,
};

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
  appearance: 'auto' as const,
};

const scrollbarCss = `
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #475569; }
`;

function FormField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </div>
  );
}
