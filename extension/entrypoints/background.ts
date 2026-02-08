/**
 * Service Worker (background.ts)
 *
 * 1. Opens side panel on icon click
 * 2. Handles GET_STREAM_ID requests from the side panel —
 *    tabCapture.getMediaStreamId() must be called from the
 *    service worker (it has the tabCapture privilege).
 */

export default defineBackground(() => {
  console.log('[AI Commentator] Service worker started');

  // Open the side panel when the extension icon is clicked
  chrome.action.onClicked.addListener((tab) => {
    if (tab.windowId) {
      chrome.sidePanel.open({ windowId: tab.windowId });
    }
  });

  // Handle stream ID requests from the side panel
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_STREAM_ID') {
      const tabId = message.tabId as number;
      console.log('[AI Commentator] GET_STREAM_ID for tab:', tabId);

      chrome.tabCapture
        .getMediaStreamId({ targetTabId: tabId })
        .then((streamId) => {
          console.log('[AI Commentator] Got stream ID:', streamId?.slice(0, 20));
          sendResponse({ streamId });
        })
        .catch((err) => {
          console.error('[AI Commentator] tabCapture error:', err);
          sendResponse({ error: String(err) });
        });

      return true; // Keep message channel open for async sendResponse
    }
  });
});
