/**
 * Content script injected into YouTube pages.
 *
 * When the side panel connects via a port named "capture":
 * 1. Draws the page's <video> element to an offscreen canvas at 15 FPS.
 * 2. Sends JPEG frames (base64) to the side panel via the port.
 * 3. Video plays normally in the tab (no overlay, no muting).
 *
 * Supports PAUSE_CAPTURE / RESUME_CAPTURE to freeze/resume capture.
 */

const CAPTURE_FPS = 15;
const JPEG_QUALITY = 0.5;
const MAX_WIDTH = 1280;

let captureInterval: ReturnType<typeof setInterval> | null = null;
let capturePort: chrome.runtime.Port | null = null;
let captureCanvas: HTMLCanvasElement | null = null;
let captureCtx: CanvasRenderingContext2D | null = null;

function findVideo(): HTMLVideoElement | null {
  return document.querySelector('video');
}

// ---- Capture lifecycle ----

function startCapture(port: chrome.runtime.Port) {
  const video = findVideo();
  if (!video) {
    port.postMessage({ type: 'ERROR', message: 'No video element found' });
    return;
  }

  capturePort = port;

  // Create offscreen canvas
  captureCanvas = document.createElement('canvas');
  captureCtx = captureCanvas.getContext('2d')!;

  startCaptureLoop();
  port.postMessage({ type: 'CAPTURE_ACTIVE' });
}

function startCaptureLoop() {
  stopCaptureLoop();
  const video = findVideo();
  if (!video || !captureCtx || !captureCanvas || !capturePort) return;

  const canvas = captureCanvas;
  const ctx = captureCtx;
  const port = capturePort;

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
}

function stopCaptureLoop() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
}

function stopCapture() {
  stopCaptureLoop();
  capturePort = null;
  captureCanvas = null;
  captureCtx = null;
}

function pauseCapture() {
  stopCaptureLoop();
  const video = findVideo();
  if (video) video.pause();
}

function resumeCapture() {
  const video = findVideo();
  if (video) video.play();
  startCaptureLoop();
}

// ---- Entry point ----

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    console.log('[AI Commentator] Content script loaded on YouTube page');

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== 'capture') return;
      console.log('[AI Commentator] Capture port connected');

      port.onMessage.addListener((msg) => {
        switch (msg.type) {
          case 'START_CAPTURE':
            startCapture(port);
            break;
          case 'STOP_CAPTURE':
            stopCapture();
            break;
          case 'PAUSE_CAPTURE':
            pauseCapture();
            break;
          case 'RESUME_CAPTURE':
            resumeCapture();
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        console.log('[AI Commentator] Capture port disconnected');
        stopCapture();
      });
    });

  },
});
