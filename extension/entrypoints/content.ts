/**
 * Content script injected into YouTube pages.
 *
 * Controls the page's <video> element in response to messages
 * from the side panel (via chrome.tabs.sendMessage).
 */

function findVideo(): HTMLVideoElement | null {
  return document.querySelector('video');
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    console.log('[AI Commentator] Content script loaded on YouTube page');

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
