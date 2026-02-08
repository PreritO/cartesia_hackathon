/**
 * Content script injected into YouTube pages.
 *
 * When the side panel connects via a port named "capture":
 * 1. Draws the page's <video> element to an offscreen canvas at 5 FPS.
 * 2. Sends JPEG frames (base64) to the side panel via the port.
 * 3. Overlays the YouTube video player with a "Watch in sidebar" banner.
 * 4. Mutes the video (audio comes from TTS in the sidebar).
 *
 * This decouples frame capture from display: the sidebar shows a delayed,
 * synced version while the tab's video is hidden under an overlay.
 */

const CAPTURE_FPS = 5;
const JPEG_QUALITY = 0.7;
const MAX_WIDTH = 1280;

let captureInterval: ReturnType<typeof setInterval> | null = null;
let overlayEl: HTMLDivElement | null = null;
let wasMuted = false;

function findVideo(): HTMLVideoElement | null {
  return document.querySelector('video');
}

function startCapture(port: chrome.runtime.Port) {
  const video = findVideo();
  if (!video) {
    port.postMessage({ type: 'ERROR', message: 'No video element found' });
    return;
  }

  // Remember mute state and mute (audio comes from TTS)
  wasMuted = video.muted;
  video.muted = true;

  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  // Show overlay
  showOverlay();

  captureInterval = setInterval(() => {
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return;

    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w === 0 || h === 0) return;

    if (w > MAX_WIDTH) {
      const scale = MAX_WIDTH / w;
      w = MAX_WIDTH;
      h = Math.round(h * scale);
    }

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64 = dataUrl.split(',')[1];
    port.postMessage({ type: 'FRAME', data: base64, ts: Date.now() });
  }, 1000 / CAPTURE_FPS);

  port.postMessage({ type: 'CAPTURE_ACTIVE' });
}

function stopCapture() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  hideOverlay();
  // Restore mute state
  const video = findVideo();
  if (video) video.muted = wasMuted;
}

// ---- Overlay on YouTube player ----

function showOverlay() {
  hideOverlay();
  const video = findVideo();
  if (!video) return;

  // YouTube wraps the video in .html5-video-player
  const player = video.closest('.html5-video-player') || video.parentElement;
  if (!player || !(player instanceof HTMLElement)) return;

  // Ensure parent is positioned so absolute overlay works
  const pos = getComputedStyle(player).position;
  if (pos === 'static') player.style.position = 'relative';

  overlayEl = document.createElement('div');
  overlayEl.id = 'ai-commentator-overlay';
  overlayEl.style.cssText = `
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(15, 23, 42, 0.92);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    pointer-events: none;
    font-family: system-ui, -apple-system, sans-serif;
  `;
  overlayEl.innerHTML = `
    <div style="text-align: center; color: white;">
      <div style="font-size: 48px; margin-bottom: 12px;">&#127908;</div>
      <div style="font-size: 18px; font-weight: 700; margin-bottom: 6px;">AI Commentary Active</div>
      <div style="font-size: 14px; color: #94a3b8;">Watch the synced broadcast in the sidebar</div>
    </div>
  `;
  player.appendChild(overlayEl);
}

function hideOverlay() {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

// ---- Entry point ----

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    console.log('[AI Commentator] Content script loaded on YouTube page');

    // Port-based communication for frame capture
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== 'capture') return;
      console.log('[AI Commentator] Capture port connected');

      port.onMessage.addListener((msg) => {
        if (msg.type === 'START_CAPTURE') startCapture(port);
        if (msg.type === 'STOP_CAPTURE') stopCapture();
      });

      port.onDisconnect.addListener(() => {
        console.log('[AI Commentator] Capture port disconnected');
        stopCapture();
      });
    });

    // Legacy message-based video control
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const video = findVideo();
      if (!video) {
        sendResponse({ ok: false, error: 'No video element found' });
        return;
      }

      switch (message.type) {
        case 'VIDEO_PLAY':
          video.play();
          sendResponse({ ok: true });
          break;
        case 'VIDEO_PAUSE':
          video.pause();
          sendResponse({ ok: true });
          break;
        case 'VIDEO_MUTE':
          video.muted = true;
          sendResponse({ ok: true });
          break;
        case 'VIDEO_UNMUTE':
          video.muted = false;
          sendResponse({ ok: true });
          break;
        case 'VIDEO_STATUS':
          sendResponse({
            ok: true,
            paused: video.paused,
            muted: video.muted,
            currentTime: video.currentTime,
            duration: video.duration,
          });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    });
  },
});
