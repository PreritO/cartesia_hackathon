import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'AI Sports Commentator',
    description: 'Real-time AI-powered sports commentary for any video in your browser',
    permissions: ['tabCapture', 'offscreen', 'activeTab', 'tabs', 'storage', 'scripting', 'sidePanel'],
    minimum_chrome_version: '116',
    action: {
      default_title: 'AI Sports Commentator',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    content_security_policy: {
      sandbox:
        "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' https://www.youtube.com; frame-src https://www.youtube.com; child-src https://www.youtube.com",
    },
    sandbox: {
      pages: ['youtube-sandbox.html'],
    },
  },
});
