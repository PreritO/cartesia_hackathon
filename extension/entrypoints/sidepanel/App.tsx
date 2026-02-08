/**
 * Side Panel - YouTube tab mirror + playback controls.
 *
 * - Background service worker gets the tabCapture stream ID
 *   (tabCapture.getMediaStreamId requires service worker context)
 * - Side panel calls getUserMedia() with that stream ID
 * - chrome.scripting.executeScript() for play/pause
 */

import { useEffect, useRef, useState } from 'react';

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
  const [streaming, setStreaming] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    findYouTubeTab();
    return () => stopStream();
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

      const result = await runOnTab(tab.id, () => {
        const v = document.querySelector('video');
        if (!v) return null;
        return { paused: v.paused };
      });

      if (!result) {
        setStatus('Could not find video element. Is the video loaded?');
        setTabId(null);
        return;
      }

      setTabId(tab.id);
      setTabTitle(tab.title?.slice(0, 50) || 'YouTube');
      setPaused(result.paused);
      setStatus('Connected! Click "Start Stream" to mirror the video.');
    } catch (err) {
      console.error('[AI Commentator]', err);
      setStatus('Error connecting. Try reloading the YouTube page.');
      setTabId(null);
    }
  }

  async function startStream() {
    if (!tabId) return;
    setStatus('Requesting tab capture...');

    try {
      // Step 1: Ask background service worker for a stream ID
      // (tabCapture.getMediaStreamId must be called from the SW)
      console.log('[AI Commentator] Requesting stream ID for tab:', tabId);
      const response = await new Promise<{ streamId?: string; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'GET_STREAM_ID', tabId },
          (resp) => {
            if (chrome.runtime.lastError) {
              console.error('[AI Commentator] lastError:', chrome.runtime.lastError);
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              console.log('[AI Commentator] Raw response:', resp);
              resolve(resp || { error: 'Empty response from background' });
            }
          },
        );
      });

      if (response.error) {
        throw new Error(response.error);
      }
      if (!response.streamId) {
        throw new Error('Background returned no stream ID');
      }

      const streamId = response.streamId;
      console.log('[AI Commentator] Got stream ID:', streamId?.slice(0, 20));

      // Step 2: Get the actual media stream
      setStatus('Connecting to stream...');
      // @ts-expect-error -- chromeMediaSource is a Chrome-specific constraint
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
      });

      // Step 3: Display in video element
      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.muted = true;
        await videoRef.current.play();
      }

      setStreaming(true);
      setStatus('Streaming!');
    } catch (err) {
      console.error('[AI Commentator] Stream error:', err);
      setStatus(`Stream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStreaming(false);
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
              background: streaming ? '#4ade80' : connected ? '#facc15' : '#ef4444',
            }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{status}</span>
        </div>
        {connected && (
          <p style={{ fontSize: 11, color: '#64748b', margin: '4px 0 0' }}>{tabTitle}</p>
        )}
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
            <span style={{ color: '#475569', fontSize: 13 }}>
              {connected ? 'Click "Start Stream" below' : 'Connect to a YouTube tab first'}
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
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

        <button
          onClick={streaming ? () => { stopStream(); setStatus('Stream stopped.'); } : startStream}
          disabled={!connected}
          style={{
            padding: '10px 16px', borderRadius: 8, border: 'none',
            cursor: connected ? 'pointer' : 'not-allowed',
            fontWeight: 600, fontSize: 14,
            backgroundColor: !connected ? '#1e293b' : streaming ? '#ef4444' : '#7c3aed',
            color: connected ? 'white' : '#475569',
          }}
        >
          {streaming ? 'Stop Stream' : 'Start Stream'}
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
      </div>

      {!connected && (
        <div style={{ flex: 1, padding: '0 16px' }}>
          <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
            1. Open a YouTube video<br />
            2. Click "Refresh Connection"<br />
            3. Click "Start Stream" to mirror the video<br />
            4. Use Play / Pause to control playback
          </p>
        </div>
      )}

      <style>{`body { margin: 0; }`}</style>
    </div>
  );
}
