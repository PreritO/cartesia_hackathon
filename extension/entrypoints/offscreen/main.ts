/**
 * Offscreen Document
 *
 * Handles the actual tab capture and frame extraction:
 * 1. Receives stream ID from service worker
 * 2. Gets MediaStream via getUserMedia with chromeMediaSource
 * 3. Draws video frames to canvas at 5 FPS
 * 4. Sends JPEG blobs over WebSocket to backend
 * 5. Relays commentary responses back to service worker
 */

import { BACKEND_WS_URL, CAPTURE_FPS, JPEG_QUALITY, MAX_CANVAS_WIDTH } from '../../lib/constants';
import type { ExtensionMessage } from '../../lib/messages';

let mediaStream: MediaStream | null = null;
let ws: WebSocket | null = null;
let captureInterval: ReturnType<typeof setInterval> | null = null;

const video = document.getElementById('captureVideo') as HTMLVideoElement;
const canvas = document.getElementById('captureCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function sendStatus(message: string) {
  chrome.runtime.sendMessage({ type: 'STATUS', message } satisfies ExtensionMessage);
}

async function startCapture(streamId: string): Promise<void> {
  try {
    // Get MediaStream from tab capture stream ID
    // @ts-expect-error -- chromeMediaSource is a Chrome-specific constraint
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    video.srcObject = mediaStream;
    await video.play();

    // Wait for video dimensions to be available
    await new Promise<void>((resolve) => {
      if (video.videoWidth > 0) {
        resolve();
        return;
      }
      video.onloadedmetadata = () => resolve();
    });

    // Set canvas dimensions, capping at MAX_CANVAS_WIDTH
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > MAX_CANVAS_WIDTH) {
      const scale = MAX_CANVAS_WIDTH / w;
      w = MAX_CANVAS_WIDTH;
      h = Math.round(h * scale);
    }
    canvas.width = w;
    canvas.height = h;

    sendStatus('Connecting to backend...');

    // Connect WebSocket to backend
    ws = new WebSocket(BACKEND_WS_URL);

    ws.onopen = () => {
      sendStatus('Connected to backend');
      startFrameExtraction();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'status') {
        sendStatus(msg.message);
      } else if (msg.type === 'commentary') {
        // Relay commentary to service worker -> side panel
        chrome.runtime.sendMessage({
          type: 'COMMENTARY',
          text: msg.text,
          emotion: msg.emotion,
          audio: msg.audio,
        } satisfies ExtensionMessage);
      }
    };

    ws.onerror = () => {
      sendStatus('WebSocket error — is the backend running?');
    };

    ws.onclose = () => {
      sendStatus('Disconnected from backend');
      stopCapture();
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    sendStatus(`Capture error: ${msg}`);
  }
}

function startFrameExtraction(): void {
  const intervalMs = 1000 / CAPTURE_FPS;

  captureInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (video.readyState < video.HAVE_CURRENT_DATA) return;

    // Draw current video frame to canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Extract JPEG blob and send over WebSocket as binary
    canvas.toBlob(
      (blob) => {
        if (blob && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(blob);
        }
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  }, intervalMs);
}

function stopCapture(): void {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close();
  }
  ws = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  video.srcObject = null;
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === 'CAPTURE_STARTED') {
    startCapture(message.streamId);
  }
  if (message.type === 'STOP_CAPTURE') {
    stopCapture();
  }
});
