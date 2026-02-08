import { useEffect, useRef } from 'react';

interface Props {
  videoId: string;
  delayMs: number;
  onReady?: () => void;
}

declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

let apiLoaded = false;
let apiLoading = false;
const apiReadyCallbacks: (() => void)[] = [];

function loadYouTubeAPI(): Promise<void> {
  if (apiLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    if (apiLoading) {
      apiReadyCallbacks.push(resolve);
      return;
    }
    apiLoading = true;
    apiReadyCallbacks.push(resolve);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      apiLoaded = true;
      apiLoading = false;
      prev?.();
      for (const cb of apiReadyCallbacks) cb();
      apiReadyCallbacks.length = 0;
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
}

export function YouTubePlayer({ videoId, delayMs, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef(false);

  // Use refs to always access latest props without stale closures
  const delayMsRef = useRef(delayMs);
  delayMsRef.current = delayMs;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  function startDelayedPlayback() {
    if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
    delayTimerRef.current = setTimeout(() => {
      playerRef.current?.playVideo();
      onReadyRef.current?.();
    }, delayMsRef.current);
  }

  useEffect(() => {
    let destroyed = false;
    initializedRef.current = false;

    loadYouTubeAPI().then(() => {
      if (destroyed || !containerRef.current) return;

      // Clear any previous player
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          autoplay: 0,
          mute: 1, // Audio comes from TTS, not the video
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            if (!destroyed) {
              initializedRef.current = true;
              startDelayedPlayback();
            }
          },
        },
      });
    });

    return () => {
      destroyed = true;
      if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [videoId]); // Recreate player when videoId changes

  // If delayMs changes after initialization, restart the delay
  useEffect(() => {
    if (playerRef.current && initializedRef.current) {
      playerRef.current.pauseVideo();
      playerRef.current.seekTo(0, true);
      startDelayedPlayback();
    }
  }, [delayMs]);

  return (
    <div style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 6, overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
