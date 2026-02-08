/**
 * Content script injected into YouTube pages.
 *
 * Listens for MUTE_TAB_VIDEO / UNMUTE_TAB_VIDEO messages from the background
 * service worker to mute/unmute the page's <video> element and show a banner.
 */

const BANNER_ID = 'ai-commentator-banner';

function findVideo(): HTMLVideoElement | null {
  return document.querySelector('video');
}

function showBanner() {
  if (document.getElementById(BANNER_ID)) return;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.textContent = 'AI Commentary active — watching in sidebar';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '999999',
    background: 'linear-gradient(90deg, #2563eb, #7c3aed)',
    color: 'white',
    textAlign: 'center',
    padding: '8px 16px',
    fontSize: '13px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: '600',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  });
  document.body.appendChild(banner);
}

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove();
}

function muteVideo() {
  const video = findVideo();
  if (video) {
    video.muted = true;
  } else {
    // Video element may load later — observe for it
    const observer = new MutationObserver(() => {
      const v = findVideo();
      if (v) {
        v.muted = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Give up after 10s
    setTimeout(() => observer.disconnect(), 10000);
  }
  showBanner();
}

function unmuteVideo() {
  const video = findVideo();
  if (video) {
    video.muted = false;
  }
  removeBanner();
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'MUTE_TAB_VIDEO') {
        muteVideo();
      } else if (message.type === 'UNMUTE_TAB_VIDEO') {
        unmuteVideo();
      }
    });
  },
});
