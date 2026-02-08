/**
 * Service Worker (background.ts)
 *
 * Orchestrates tab capture flow:
 * 1. Receives START_CAPTURE from side panel
 * 2. Gets media stream ID via chrome.tabCapture
 * 3. Creates offscreen document for frame extraction
 * 4. Relays commentary messages between offscreen doc and side panel
 */

import type { ExtensionMessage, CommentatorState } from '../lib/messages';

let activeTabId: number | null = null;
let isCapturing = false;
let activeVideoId: string | null = null;

/** Extract YouTube video ID from a URL. */
function extractVideoId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function updateState(state: CommentatorState) {
  chrome.storage.session.set({ commentatorState: state });
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Capture tab video frames for AI sports commentary',
  });
}

async function handleStartCapture(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    updateState({ active: false, status: 'No active tab found', tabId: null, videoId: null });
    return;
  }

  activeTabId = tab.id;
  activeVideoId = extractVideoId(tab.url);

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    await ensureOffscreen();

    isCapturing = true;
    updateState({ active: true, status: 'Starting capture...', tabId: tab.id, videoId: activeVideoId });

    // Mute the YouTube tab's video element
    if (activeVideoId) {
      chrome.tabs.sendMessage(tab.id, { type: 'MUTE_TAB_VIDEO' } satisfies ExtensionMessage).catch(() => {
        // Content script may not be injected yet — that's fine
      });
    }

    // Tell offscreen document to start capturing with this stream ID
    chrome.runtime.sendMessage({
      type: 'CAPTURE_STARTED',
      streamId,
      tabId: tab.id,
    } satisfies ExtensionMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    updateState({ active: false, status: `Capture failed: ${msg}`, tabId: null, videoId: null });
    isCapturing = false;
    activeTabId = null;
    activeVideoId = null;
  }
}

async function handleStopCapture(): Promise<void> {
  // Unmute the YouTube tab's video before clearing state
  if (activeTabId && activeVideoId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'UNMUTE_TAB_VIDEO' } satisfies ExtensionMessage).catch(() => {});
  }

  isCapturing = false;
  activeTabId = null;
  activeVideoId = null;

  // Tell offscreen document to stop
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' } satisfies ExtensionMessage);

  updateState({ active: false, status: 'Stopped', tabId: null, videoId: null });
}

// Listen for messages from popup, side panel, and offscreen document
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === 'START_CAPTURE') {
      handleStartCapture().then(() => sendResponse({ ok: true }));
      return true; // async response
    }

    if (message.type === 'STOP_CAPTURE') {
      handleStopCapture().then(() => sendResponse({ ok: true }));
      return true;
    }

    // Relay STATUS updates from offscreen doc
    if (message.type === 'STATUS') {
      updateState({
        active: isCapturing,
        status: message.message,
        tabId: activeTabId,
        videoId: activeVideoId,
      });
    }

    // COMMENTARY messages are relayed automatically to all extension pages
    // (side panel listens via chrome.runtime.onMessage)
  },
);

export default defineBackground(() => {
  console.log('[AI Commentator] Service worker started');

  // Open the side panel when the extension icon is clicked
  chrome.action.onClicked.addListener((tab) => {
    if (tab.windowId) {
      chrome.sidePanel.open({ windowId: tab.windowId });
    }
  });
});
