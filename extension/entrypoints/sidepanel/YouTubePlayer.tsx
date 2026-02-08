import { useEffect, useRef, useState } from 'react';

interface Props {
  videoId: string;
  delayMs: number;
  onReady?: () => void;
}

/**
 * Embeds a YouTube video via a sandboxed page.
 *
 * Chrome extensions can't embed YouTube directly from chrome-extension:// origin
 * (Error 153). A sandbox page runs in a unique null origin where embeds work.
 * Communication happens via postMessage.
 */
export function YouTubePlayer({ videoId, delayMs, onReady }: Props) {
  const [started, setStarted] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // After delay, tell the sandbox to load the video
  useEffect(() => {
    setStarted(false);

    timerRef.current = setTimeout(() => {
      setStarted(true);
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          { action: 'load', videoId },
          '*',
        );
      }
      onReady?.();
    }, delayMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Clear the sandbox on unmount
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ action: 'clear' }, '*');
      }
    };
  }, [videoId, delayMs]);

  const sandboxUrl = chrome.runtime.getURL('youtube-sandbox.html');

  return (
    <div style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
      <iframe
        ref={iframeRef}
        src={sandboxUrl}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
      {!started && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#94a3b8',
            fontSize: 13,
            background: '#000',
          }}
        >
          Starting in {Math.ceil(delayMs / 1000)}s...
        </div>
      )}
    </div>
  );
}
