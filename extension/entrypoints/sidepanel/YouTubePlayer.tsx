import { useEffect, useRef, useState } from 'react';

interface Props {
  videoId: string;
  delayMs: number;
}

/**
 * Embeds a YouTube video via a sandboxed page with a configurable delay.
 *
 * Chrome extensions can't embed YouTube directly (Error 153).
 * A sandbox page runs in a unique null origin where YouTube embeds work.
 */
export function YouTubePlayer({ videoId, delayMs }: Props) {
  const [countdown, setCountdown] = useState(Math.ceil(delayMs / 1000));
  const [playing, setPlaying] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeLoadedRef = useRef(false);

  // Send the load message once both conditions are met: iframe loaded + delay elapsed
  function tryLoad() {
    if (iframeLoadedRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ action: 'load', videoId }, '*');
      setPlaying(true);
    }
  }

  useEffect(() => {
    iframeLoadedRef.current = false;
    setPlaying(false);
    setCountdown(Math.ceil(delayMs / 1000));

    // Countdown display
    const countdownInterval = setInterval(() => {
      setCountdown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);

    // Actual delay timer
    const delayTimer = setTimeout(() => {
      clearInterval(countdownInterval);
      setCountdown(0);
      tryLoad();
    }, delayMs);

    return () => {
      clearTimeout(delayTimer);
      clearInterval(countdownInterval);
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ action: 'clear' }, '*');
      }
    };
  }, [videoId, delayMs]);

  const handleIframeLoad = () => {
    iframeLoadedRef.current = true;
    // If delay already elapsed, load immediately
    if (countdown === 0 && !playing) {
      tryLoad();
    }
  };

  const sandboxUrl = chrome.runtime.getURL('youtube-sandbox.html');

  return (
    <div
      style={{
        width: '100%',
        aspectRatio: '16/9',
        background: '#000',
        borderRadius: 6,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <iframe
        ref={iframeRef}
        src={sandboxUrl}
        onLoad={handleIframeLoad}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
      {!playing && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#94a3b8',
            fontSize: 14,
            fontWeight: 600,
            background: '#000',
          }}
        >
          {countdown > 0 ? `Starting in ${countdown}s...` : 'Loading...'}
        </div>
      )}
    </div>
  );
}
