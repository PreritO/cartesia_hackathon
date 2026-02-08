/**
 * Service Worker (background.ts)
 *
 * Minimal — just opens the side panel on icon click.
 * Video capture is handled entirely in the side panel via getDisplayMedia().
 */

export default defineBackground(() => {
  console.log('[AI Commentator] Service worker started');

  // Open side panel when icon is clicked
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
