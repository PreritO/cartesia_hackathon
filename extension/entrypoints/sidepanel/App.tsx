/**
 * Side Panel — streams the active tab's video via getDisplayMedia().
 *
 * No service worker IPC needed. The side panel calls getDisplayMedia()
 * directly, Chrome shows a tab picker, and we get a MediaStream.
 */

import { useRef, useState } from 'react';

export function App() {
  const [status, setStatus] = useState('Click "Start Stream" and pick your YouTube tab.');
  const [streaming, setStreaming] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  async function startStream() {
    setStatus('Waiting for tab selection...');

    try {
      // getDisplayMedia shows Chrome's built-in tab/window picker.
      // No service worker, no tabCapture IPC — just works.
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

      // Detect when user stops sharing (via Chrome's "Stop sharing" button)
      mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopStream();
        setStatus('Sharing stopped. Click "Start Stream" to try again.');
      });

      setStreaming(true);
      setStatus('Streaming!');
    } catch (err) {
      console.error('[AI Commentator] Stream error:', err);
      // User cancelled the picker
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setStatus('Cancelled. Click "Start Stream" to try again.');
      } else {
        setStatus(`Stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
            <span style={{ color: '#475569', fontSize: 13 }}>
              No video yet
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={{ padding: '8px 16px' }}>
        <button
          onClick={streaming ? () => { stopStream(); setStatus('Stopped. Click "Start Stream" to try again.'); } : startStream}
          style={{
            width: '100%',
            padding: '12px 16px', borderRadius: 8, border: 'none',
            cursor: 'pointer',
            fontWeight: 600, fontSize: 14,
            backgroundColor: streaming ? '#ef4444' : '#7c3aed',
            color: 'white',
          }}
        >
          {streaming ? 'Stop Stream' : 'Start Stream'}
        </button>
      </div>

      {!streaming && (
        <div style={{ flex: 1, padding: '0 16px' }}>
          <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
            1. Open a YouTube video in any tab<br />
            2. Click "Start Stream"<br />
            3. Pick the YouTube tab from Chrome's picker<br />
            4. The video will appear above
          </p>
        </div>
      )}

      <style>{`body { margin: 0; }`}</style>
    </div>
  );
}
