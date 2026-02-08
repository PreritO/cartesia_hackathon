/**
 * Side Panel - Main UI surface for the AI Sports Commentator extension.
 *
 * Shows start/stop controls, YouTube player with delayed playback,
 * detection debug overlay, commentary text with emotion colors,
 * and plays TTS audio received from the backend.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommentatorState, ExtensionMessage } from '../../lib/messages';
import { PIPELINE_DELAY_MS } from '../../lib/constants';
import { YouTubePlayer } from './YouTubePlayer';
import { DetectionDebug } from './DetectionDebug';

interface CommentaryItem {
  id: number;
  text: string;
  emotion: string;
  timestamp: number;
  annotatedFrame?: string | null;
}

const EMOTION_COLORS: Record<string, string> = {
  excited: '#facc15',
  tense: '#f97316',
  thoughtful: '#60a5fa',
  celebratory: '#4ade80',
  disappointed: '#f87171',
  urgent: '#ef4444',
  neutral: '#9ca3af',
};

export function App() {
  const [state, setState] = useState<CommentatorState>({
    active: false,
    status: 'Ready',
    tabId: null,
    videoId: null,
  });
  const [commentary, setCommentary] = useState<CommentaryItem[]>([]);
  const [delayMs, setDelayMs] = useState(PIPELINE_DELAY_MS);
  const [latestFrame, setLatestFrame] = useState<string | null>(null);
  const nextIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Audio queue for sequential playback
  const audioQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopAllAudio = useCallback(() => {
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
  }, []);

  const playNextInQueue = useCallback(() => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      currentAudioRef.current = null;
      return;
    }

    isPlayingRef.current = true;
    const base64Audio = audioQueueRef.current.shift()!;

    try {
      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/mp3' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudioRef.current = audio;
      audio.volume = 0.8;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        playNextInQueue();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        playNextInQueue();
      };
      audio.play().catch(() => {
        playNextInQueue();
      });
    } catch {
      console.warn('[AI Commentator] Audio decode error');
      playNextInQueue();
    }
  }, []);

  const enqueueAudio = useCallback(
    (base64Audio: string) => {
      // Cap queue at 5 items to prevent memory buildup
      if (audioQueueRef.current.length >= 5) {
        audioQueueRef.current.shift();
      }
      audioQueueRef.current.push(base64Audio);
      if (!isPlayingRef.current) {
        playNextInQueue();
      }
    },
    [playNextInQueue],
  );

  // Load persisted state on mount
  useEffect(() => {
    chrome.storage.session.get('commentatorState', (result) => {
      if (result.commentatorState) {
        setState(result.commentatorState);
      }
    });

    // Listen for state changes
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.commentatorState) {
        setState(changes.commentatorState.newValue);
      }
    };
    chrome.storage.session.onChanged.addListener(storageListener);

    // Listen for commentary messages from service worker
    const messageListener = (message: ExtensionMessage) => {
      if (message.type === 'COMMENTARY') {
        const item: CommentaryItem = {
          id: nextIdRef.current++,
          text: message.text,
          emotion: message.emotion || 'neutral',
          timestamp: Date.now(),
          annotatedFrame: message.annotated_frame,
        };
        setCommentary((prev) => [...prev.slice(-19), item]);

        // Update latest annotated frame
        if (message.annotated_frame) {
          setLatestFrame(message.annotated_frame);
        }

        // Queue TTS audio for sequential playback
        if (message.audio) {
          enqueueAudio(message.audio);
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.storage.session.onChanged.removeListener(storageListener);
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [enqueueAudio]);

  // Auto-scroll to latest commentary
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [commentary]);

  const handleToggle = async () => {
    if (state.active) {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
      setCommentary([]);
      setLatestFrame(null);
      stopAllAudio();
    } else {
      await chrome.runtime.sendMessage({ type: 'START_CAPTURE' });
    }
  };

  const showVideo = state.active && state.videoId;

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
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>AI Sports Commentator</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: state.active ? '#4ade80' : '#6b7280',
            }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{state.status}</span>
        </div>
      </div>

      {/* YouTube Player */}
      {showVideo && (
        <div style={{ padding: '8px 16px' }}>
          <YouTubePlayer videoId={state.videoId!} delayMs={delayMs} />
        </div>
      )}

      {/* Detection Debug */}
      {state.active && <DetectionDebug annotatedFrame={latestFrame} />}

      {/* Delay Slider */}
      {showVideo && (
        <div style={{ padding: '4px 16px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
            Delay: {(delayMs / 1000).toFixed(1)}s
          </label>
          <input
            type="range"
            min={2000}
            max={10000}
            step={500}
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value))}
            style={{ flex: 1, accentColor: '#2563eb' }}
          />
        </div>
      )}

      {/* Controls */}
      <div style={{ padding: '8px 16px' }}>
        <button
          onClick={handleToggle}
          style={{
            width: '100%',
            padding: '10px 16px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 14,
            backgroundColor: state.active ? '#ef4444' : '#2563eb',
            color: 'white',
            transition: 'background-color 0.2s',
          }}
        >
          {state.active ? 'Stop Commentary' : 'Start Commentary'}
        </button>
      </div>

      {/* Commentary list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 16px 16px',
        }}
      >
        {commentary.length === 0 && !state.active && (
          <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 32 }}>
            Navigate to a sports video and click "Start Commentary" to begin.
          </p>
        )}
        {commentary.map((item) => (
          <div
            key={item.id}
            style={{
              background: 'rgba(30, 41, 59, 0.8)',
              borderLeft: `3px solid ${EMOTION_COLORS[item.emotion] || EMOTION_COLORS.neutral}`,
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 8,
              animation: 'slideIn 0.3s ease-out',
            }}
          >
            <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>{item.text}</p>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ padding: '8px 16px', borderTop: '1px solid #1e293b', textAlign: 'center' }}>
        <span style={{ fontSize: 10, color: '#475569' }}>Backend: localhost:8000</span>
      </div>

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
      `}</style>
    </div>
  );
}
