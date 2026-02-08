/**
 * Side Panel - Step 1: Control YouTube playback on the active tab.
 *
 * Uses chrome.scripting.executeScript to directly control the <video>
 * element on the YouTube page. No content script needed.
 */

import { useEffect, useState } from 'react';

// Helper: run a function on the active YouTube tab and return the result
async function runOnTab<T>(tabId: number, func: () => T): Promise<T | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
    });
    return results?.[0]?.result ?? null;
  } catch (err) {
    console.error('[AI Commentator] executeScript error:', err);
    return null;
  }
}

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabTitle, setTabTitle] = useState('');
  const [status, setStatus] = useState('Looking for YouTube tab...');
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    findYouTubeTab();
  }, []);

  async function findYouTubeTab() {
    setStatus('Looking for YouTube tab...');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus('No active tab found.');
        setTabId(null);
        return;
      }
      if (!tab.url?.includes('youtube.com/watch')) {
        setStatus('Active tab is not a YouTube video.');
        setTabId(null);
        return;
      }

      // Test that we can execute scripts on this tab
      const result = await runOnTab(tab.id, () => {
        const v = document.querySelector('video');
        if (!v) return null;
        return { paused: v.paused, muted: v.muted };
      });

      if (!result) {
        setStatus('Could not find video element. Is the video loaded?');
        setTabId(null);
        return;
      }

      setTabId(tab.id);
      setTabTitle(tab.title?.slice(0, 50) || 'YouTube');
      setPaused(result.paused);
      setMuted(result.muted);
      setStatus('Connected!');
    } catch (err) {
      console.error('[AI Commentator]', err);
      setStatus('Error connecting. Try reloading the YouTube page.');
      setTabId(null);
    }
  }

  async function handlePlay() {
    if (!tabId) return;
    await runOnTab(tabId, () => { document.querySelector('video')?.play(); });
    setPaused(false);
  }

  async function handlePause() {
    if (!tabId) return;
    await runOnTab(tabId, () => { document.querySelector('video')?.pause(); });
    setPaused(true);
  }

  async function handleMuteToggle() {
    if (!tabId) return;
    const newMuted = !muted;
    await runOnTab(tabId, () => {
      const v = document.querySelector('video');
      if (v) v.muted = !v.muted;
    });
    setMuted(newMuted);
  }

  const connected = tabId !== null;

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
              width: 8, height: 8, borderRadius: '50%',
              background: connected ? '#4ade80' : '#ef4444',
            }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
        </div>
        {connected && (
          <p style={{ fontSize: 11, color: '#64748b', margin: '4px 0 0' }}>{tabTitle}</p>
        )}
      </div>

      {/* Controls */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={findYouTubeTab}
          style={{
            padding: '8px 16px', borderRadius: 6,
            border: '1px solid #334155', background: '#1e293b',
            color: '#94a3b8', fontSize: 13, cursor: 'pointer',
          }}
        >
          Refresh Connection
        </button>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handlePlay}
            disabled={!connected}
            style={{
              flex: 1, padding: '12px 16px', borderRadius: 8, border: 'none',
              cursor: connected ? 'pointer' : 'not-allowed',
              fontWeight: 600, fontSize: 14,
              backgroundColor: connected ? '#22c55e' : '#1e293b',
              color: connected ? 'white' : '#475569',
            }}
          >
            Play
          </button>
          <button
            onClick={handlePause}
            disabled={!connected}
            style={{
              flex: 1, padding: '12px 16px', borderRadius: 8, border: 'none',
              cursor: connected ? 'pointer' : 'not-allowed',
              fontWeight: 600, fontSize: 14,
              backgroundColor: connected ? '#ef4444' : '#1e293b',
              color: connected ? 'white' : '#475569',
            }}
          >
            Pause
          </button>
        </div>

        <button
          onClick={handleMuteToggle}
          disabled={!connected}
          style={{
            padding: '10px 16px', borderRadius: 8, border: 'none',
            cursor: connected ? 'pointer' : 'not-allowed',
            fontWeight: 600, fontSize: 14,
            backgroundColor: connected ? (muted ? '#f97316' : '#2563eb') : '#1e293b',
            color: connected ? 'white' : '#475569',
          }}
        >
          {muted ? 'Unmute Video' : 'Mute Video'}
        </button>
      </div>

      {!connected && (
        <div style={{ flex: 1, padding: '0 16px' }}>
          <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
            1. Open a YouTube video<br />
            2. Click "Refresh Connection"<br />
            3. Use Play / Pause to control it
          </p>
        </div>
      )}

      <style>{`body { margin: 0; }`}</style>
    </div>
  );
}
