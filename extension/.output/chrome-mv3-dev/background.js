var background = (function() {
  "use strict";
  function defineBackground(arg) {
    if (arg == null || typeof arg === "function") return { main: arg };
    return arg;
  }
  let activeTabId = null;
  let isCapturing = false;
  let activeVideoId = null;
  function extractVideoId(url) {
    if (!url) return null;
    const match = url.match(/(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }
  function updateState(state) {
    chrome.storage.session.set({ commentatorState: state });
  }
  async function ensureOffscreen() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture tab video frames for AI sports commentary"
    });
  }
  async function handleStartCapture() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      updateState({ active: false, status: "No active tab found", tabId: null, videoId: null });
      return;
    }
    activeTabId = tab.id;
    activeVideoId = extractVideoId(tab.url);
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id
      });
      await ensureOffscreen();
      isCapturing = true;
      updateState({ active: true, status: "Starting capture...", tabId: tab.id, videoId: activeVideoId });
      if (activeVideoId) {
        chrome.tabs.sendMessage(tab.id, { type: "MUTE_TAB_VIDEO" }).catch(() => {
        });
      }
      chrome.runtime.sendMessage({
        type: "CAPTURE_STARTED",
        streamId,
        tabId: tab.id
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      updateState({ active: false, status: `Capture failed: ${msg}`, tabId: null, videoId: null });
      isCapturing = false;
      activeTabId = null;
      activeVideoId = null;
    }
  }
  async function handleStopCapture() {
    if (activeTabId && activeVideoId) {
      chrome.tabs.sendMessage(activeTabId, { type: "UNMUTE_TAB_VIDEO" }).catch(() => {
      });
    }
    isCapturing = false;
    activeTabId = null;
    activeVideoId = null;
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    updateState({ active: false, status: "Stopped", tabId: null, videoId: null });
  }
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message.type === "START_CAPTURE") {
        handleStartCapture().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message.type === "STOP_CAPTURE") {
        handleStopCapture().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message.type === "STATUS") {
        updateState({
          active: isCapturing,
          status: message.message,
          tabId: activeTabId,
          videoId: activeVideoId
        });
      }
    }
  );
  const definition = defineBackground(() => {
    console.log("[AI Commentator] Service worker started");
    chrome.action.onClicked.addListener((tab) => {
      if (tab.windowId) {
        chrome.sidePanel.open({ windowId: tab.windowId });
      }
    });
  });
  function initPlugins() {
  }
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  var _MatchPattern = class {
    constructor(matchPattern) {
      if (matchPattern === "<all_urls>") {
        this.isAllUrls = true;
        this.protocolMatches = [..._MatchPattern.PROTOCOLS];
        this.hostnameMatch = "*";
        this.pathnameMatch = "*";
      } else {
        const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
        if (groups == null)
          throw new InvalidMatchPattern(matchPattern, "Incorrect format");
        const [_, protocol, hostname, pathname] = groups;
        validateProtocol(matchPattern, protocol);
        validateHostname(matchPattern, hostname);
        this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
        this.hostnameMatch = hostname;
        this.pathnameMatch = pathname;
      }
    }
    includes(url) {
      if (this.isAllUrls)
        return true;
      const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
      return !!this.protocolMatches.find((protocol) => {
        if (protocol === "http")
          return this.isHttpMatch(u);
        if (protocol === "https")
          return this.isHttpsMatch(u);
        if (protocol === "file")
          return this.isFileMatch(u);
        if (protocol === "ftp")
          return this.isFtpMatch(u);
        if (protocol === "urn")
          return this.isUrnMatch(u);
      });
    }
    isHttpMatch(url) {
      return url.protocol === "http:" && this.isHostPathMatch(url);
    }
    isHttpsMatch(url) {
      return url.protocol === "https:" && this.isHostPathMatch(url);
    }
    isHostPathMatch(url) {
      if (!this.hostnameMatch || !this.pathnameMatch)
        return false;
      const hostnameMatchRegexs = [
        this.convertPatternToRegex(this.hostnameMatch),
        this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))
      ];
      const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
      return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
    }
    isFileMatch(url) {
      throw Error("Not implemented: file:// pattern matching. Open a PR to add support");
    }
    isFtpMatch(url) {
      throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
    }
    isUrnMatch(url) {
      throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
    }
    convertPatternToRegex(pattern) {
      const escaped = this.escapeForRegex(pattern);
      const starsReplaced = escaped.replace(/\\\*/g, ".*");
      return RegExp(`^${starsReplaced}$`);
    }
    escapeForRegex(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  };
  var MatchPattern = _MatchPattern;
  MatchPattern.PROTOCOLS = ["http", "https", "file", "ftp", "urn"];
  var InvalidMatchPattern = class extends Error {
    constructor(matchPattern, reason) {
      super(`Invalid match pattern "${matchPattern}": ${reason}`);
    }
  };
  function validateProtocol(matchPattern, protocol) {
    if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*")
      throw new InvalidMatchPattern(
        matchPattern,
        `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`
      );
  }
  function validateHostname(matchPattern, hostname) {
    if (hostname.includes(":"))
      throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
    if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*."))
      throw new InvalidMatchPattern(
        matchPattern,
        `If using a wildcard (*), it must go at the start of the hostname`
      );
  }
  function print(method, ...args) {
    if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
    else method("[wxt]", ...args);
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args)
  };
  let ws;
  function getDevServerWebSocket() {
    if (ws == null) {
      const serverUrl = "ws://localhost:3000";
      logger.debug("Connecting to dev server @", serverUrl);
      ws = new WebSocket(serverUrl, "vite-hmr");
      ws.addWxtEventListener = ws.addEventListener.bind(ws);
      ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({
        type: "custom",
        event,
        payload
      }));
      ws.addEventListener("open", () => {
        logger.debug("Connected to dev server");
      });
      ws.addEventListener("close", () => {
        logger.debug("Disconnected from dev server");
      });
      ws.addEventListener("error", (event) => {
        logger.error("Failed to connect to dev server", event);
      });
      ws.addEventListener("message", (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message.type === "custom") ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
        } catch (err) {
          logger.error("Failed to handle message", err);
        }
      });
    }
    return ws;
  }
  function keepServiceWorkerAlive() {
    setInterval(async () => {
      await browser.runtime.getPlatformInfo();
    }, 5e3);
  }
  function reloadContentScript(payload) {
    if (browser.runtime.getManifest().manifest_version == 2) reloadContentScriptMv2();
    else reloadContentScriptMv3(payload);
  }
  async function reloadContentScriptMv3({ registration, contentScript }) {
    if (registration === "runtime") await reloadRuntimeContentScriptMv3(contentScript);
    else await reloadManifestContentScriptMv3(contentScript);
  }
  async function reloadManifestContentScriptMv3(contentScript) {
    const id = `wxt:${contentScript.js[0]}`;
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const existing = registered.find((cs) => cs.id === id);
    if (existing) {
      logger.debug("Updating content script", existing);
      await browser.scripting.updateContentScripts([{
        ...contentScript,
        id,
        css: contentScript.css ?? []
      }]);
    } else {
      logger.debug("Registering new content script...");
      await browser.scripting.registerContentScripts([{
        ...contentScript,
        id,
        css: contentScript.css ?? []
      }]);
    }
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadRuntimeContentScriptMv3(contentScript) {
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const matches = registered.filter((cs) => {
      const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
      const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
      return hasJs || hasCss;
    });
    if (matches.length === 0) {
      logger.log("Content script is not registered yet, nothing to reload", contentScript);
      return;
    }
    await browser.scripting.updateContentScripts(matches);
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadTabsForContentScript(contentScript) {
    const allTabs = await browser.tabs.query({});
    const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
    const matchingTabs = allTabs.filter((tab) => {
      const url = tab.url;
      if (!url) return false;
      return !!matchPatterns.find((pattern) => pattern.includes(url));
    });
    await Promise.all(matchingTabs.map(async (tab) => {
      try {
        await browser.tabs.reload(tab.id);
      } catch (err) {
        logger.warn("Failed to reload tab:", err);
      }
    }));
  }
  async function reloadContentScriptMv2(_payload) {
    throw Error("TODO: reloadContentScriptMv2");
  }
  {
    try {
      const ws2 = getDevServerWebSocket();
      ws2.addWxtEventListener("wxt:reload-extension", () => {
        browser.runtime.reload();
      });
      ws2.addWxtEventListener("wxt:reload-content-script", (event) => {
        reloadContentScript(event.detail);
      });
      if (true) {
        ws2.addEventListener("open", () => ws2.sendCustom("wxt:background-initialized"));
        keepServiceWorkerAlive();
      }
    } catch (err) {
      logger.error("Failed to setup web socket connection with dev server", err);
    }
    browser.commands.onCommand.addListener((command) => {
      if (command === "wxt:reload-extension") browser.runtime.reload();
    });
  }
  let result;
  try {
    initPlugins();
    result = definition.main();
    if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
  } catch (err) {
    logger.error("The background crashed on startup!");
    throw err;
  }
  var background_entrypoint_default = result;
  return background_entrypoint_default;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL2VudHJ5cG9pbnRzL2JhY2tncm91bmQudHMiLCIuLi8uLi9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3ZWJleHQtY29yZS9tYXRjaC1wYXR0ZXJucy9saWIvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8jcmVnaW9uIHNyYy91dGlscy9kZWZpbmUtYmFja2dyb3VuZC50c1xuZnVuY3Rpb24gZGVmaW5lQmFja2dyb3VuZChhcmcpIHtcblx0aWYgKGFyZyA9PSBudWxsIHx8IHR5cGVvZiBhcmcgPT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHsgbWFpbjogYXJnIH07XG5cdHJldHVybiBhcmc7XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQmFja2dyb3VuZCB9OyIsIi8qKlxuICogU2VydmljZSBXb3JrZXIgKGJhY2tncm91bmQudHMpXG4gKlxuICogT3JjaGVzdHJhdGVzIHRhYiBjYXB0dXJlIGZsb3c6XG4gKiAxLiBSZWNlaXZlcyBTVEFSVF9DQVBUVVJFIGZyb20gc2lkZSBwYW5lbFxuICogMi4gR2V0cyBtZWRpYSBzdHJlYW0gSUQgdmlhIGNocm9tZS50YWJDYXB0dXJlXG4gKiAzLiBDcmVhdGVzIG9mZnNjcmVlbiBkb2N1bWVudCBmb3IgZnJhbWUgZXh0cmFjdGlvblxuICogNC4gUmVsYXlzIGNvbW1lbnRhcnkgbWVzc2FnZXMgYmV0d2VlbiBvZmZzY3JlZW4gZG9jIGFuZCBzaWRlIHBhbmVsXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25NZXNzYWdlLCBDb21tZW50YXRvclN0YXRlIH0gZnJvbSAnLi4vbGliL21lc3NhZ2VzJztcblxubGV0IGFjdGl2ZVRhYklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbmxldCBpc0NhcHR1cmluZyA9IGZhbHNlO1xubGV0IGFjdGl2ZVZpZGVvSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogRXh0cmFjdCBZb3VUdWJlIHZpZGVvIElEIGZyb20gYSBVUkwuICovXG5mdW5jdGlvbiBleHRyYWN0VmlkZW9JZCh1cmw6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIXVybCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG1hdGNoID0gdXJsLm1hdGNoKC8oPzp2PXxcXC9lbWJlZFxcL3x5b3V0dVxcLmJlXFwvKShbYS16QS1aMC05Xy1dezExfSkvKTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0gOiBudWxsO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdGF0ZShzdGF0ZTogQ29tbWVudGF0b3JTdGF0ZSkge1xuICBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IGNvbW1lbnRhdG9yU3RhdGU6IHN0YXRlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVPZmZzY3JlZW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoe1xuICAgIGNvbnRleHRUeXBlczogWydPRkZTQ1JFRU5fRE9DVU1FTlQnIGFzIGNocm9tZS5ydW50aW1lLkNvbnRleHRUeXBlXSxcbiAgfSk7XG4gIGlmIChjb250ZXh0cy5sZW5ndGggPiAwKSByZXR1cm47XG5cbiAgYXdhaXQgY2hyb21lLm9mZnNjcmVlbi5jcmVhdGVEb2N1bWVudCh7XG4gICAgdXJsOiAnb2Zmc2NyZWVuLmh0bWwnLFxuICAgIHJlYXNvbnM6IFsnVVNFUl9NRURJQScgYXMgY2hyb21lLm9mZnNjcmVlbi5SZWFzb25dLFxuICAgIGp1c3RpZmljYXRpb246ICdDYXB0dXJlIHRhYiB2aWRlbyBmcmFtZXMgZm9yIEFJIHNwb3J0cyBjb21tZW50YXJ5JyxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0YXJ0Q2FwdHVyZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgW3RhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgY3VycmVudFdpbmRvdzogdHJ1ZSB9KTtcbiAgaWYgKCF0YWI/LmlkKSB7XG4gICAgdXBkYXRlU3RhdGUoeyBhY3RpdmU6IGZhbHNlLCBzdGF0dXM6ICdObyBhY3RpdmUgdGFiIGZvdW5kJywgdGFiSWQ6IG51bGwsIHZpZGVvSWQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgYWN0aXZlVGFiSWQgPSB0YWIuaWQ7XG4gIGFjdGl2ZVZpZGVvSWQgPSBleHRyYWN0VmlkZW9JZCh0YWIudXJsKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHN0cmVhbUlkID0gYXdhaXQgY2hyb21lLnRhYkNhcHR1cmUuZ2V0TWVkaWFTdHJlYW1JZCh7XG4gICAgICB0YXJnZXRUYWJJZDogdGFiLmlkLFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZW5zdXJlT2Zmc2NyZWVuKCk7XG5cbiAgICBpc0NhcHR1cmluZyA9IHRydWU7XG4gICAgdXBkYXRlU3RhdGUoeyBhY3RpdmU6IHRydWUsIHN0YXR1czogJ1N0YXJ0aW5nIGNhcHR1cmUuLi4nLCB0YWJJZDogdGFiLmlkLCB2aWRlb0lkOiBhY3RpdmVWaWRlb0lkIH0pO1xuXG4gICAgLy8gTXV0ZSB0aGUgWW91VHViZSB0YWIncyB2aWRlbyBlbGVtZW50XG4gICAgaWYgKGFjdGl2ZVZpZGVvSWQpIHtcbiAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgeyB0eXBlOiAnTVVURV9UQUJfVklERU8nIH0gc2F0aXNmaWVzIEV4dGVuc2lvbk1lc3NhZ2UpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgLy8gQ29udGVudCBzY3JpcHQgbWF5IG5vdCBiZSBpbmplY3RlZCB5ZXQg4oCUIHRoYXQncyBmaW5lXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBUZWxsIG9mZnNjcmVlbiBkb2N1bWVudCB0byBzdGFydCBjYXB0dXJpbmcgd2l0aCB0aGlzIHN0cmVhbSBJRFxuICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcbiAgICAgIHR5cGU6ICdDQVBUVVJFX1NUQVJURUQnLFxuICAgICAgc3RyZWFtSWQsXG4gICAgICB0YWJJZDogdGFiLmlkLFxuICAgIH0gc2F0aXNmaWVzIEV4dGVuc2lvbk1lc3NhZ2UpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogJ1Vua25vd24gZXJyb3InO1xuICAgIHVwZGF0ZVN0YXRlKHsgYWN0aXZlOiBmYWxzZSwgc3RhdHVzOiBgQ2FwdHVyZSBmYWlsZWQ6ICR7bXNnfWAsIHRhYklkOiBudWxsLCB2aWRlb0lkOiBudWxsIH0pO1xuICAgIGlzQ2FwdHVyaW5nID0gZmFsc2U7XG4gICAgYWN0aXZlVGFiSWQgPSBudWxsO1xuICAgIGFjdGl2ZVZpZGVvSWQgPSBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVN0b3BDYXB0dXJlKCk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBVbm11dGUgdGhlIFlvdVR1YmUgdGFiJ3MgdmlkZW8gYmVmb3JlIGNsZWFyaW5nIHN0YXRlXG4gIGlmIChhY3RpdmVUYWJJZCAmJiBhY3RpdmVWaWRlb0lkKSB7XG4gICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UoYWN0aXZlVGFiSWQsIHsgdHlwZTogJ1VOTVVURV9UQUJfVklERU8nIH0gc2F0aXNmaWVzIEV4dGVuc2lvbk1lc3NhZ2UpLmNhdGNoKCgpID0+IHt9KTtcbiAgfVxuXG4gIGlzQ2FwdHVyaW5nID0gZmFsc2U7XG4gIGFjdGl2ZVRhYklkID0gbnVsbDtcbiAgYWN0aXZlVmlkZW9JZCA9IG51bGw7XG5cbiAgLy8gVGVsbCBvZmZzY3JlZW4gZG9jdW1lbnQgdG8gc3RvcFxuICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdTVE9QX0NBUFRVUkUnIH0gc2F0aXNmaWVzIEV4dGVuc2lvbk1lc3NhZ2UpO1xuXG4gIHVwZGF0ZVN0YXRlKHsgYWN0aXZlOiBmYWxzZSwgc3RhdHVzOiAnU3RvcHBlZCcsIHRhYklkOiBudWxsLCB2aWRlb0lkOiBudWxsIH0pO1xufVxuXG4vLyBMaXN0ZW4gZm9yIG1lc3NhZ2VzIGZyb20gcG9wdXAsIHNpZGUgcGFuZWwsIGFuZCBvZmZzY3JlZW4gZG9jdW1lbnRcbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihcbiAgKG1lc3NhZ2U6IEV4dGVuc2lvbk1lc3NhZ2UsIF9zZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdTVEFSVF9DQVBUVVJFJykge1xuICAgICAgaGFuZGxlU3RhcnRDYXB0dXJlKCkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm4gdHJ1ZTsgLy8gYXN5bmMgcmVzcG9uc2VcbiAgICB9XG5cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnU1RPUF9DQVBUVVJFJykge1xuICAgICAgaGFuZGxlU3RvcENhcHR1cmUoKS50aGVuKCgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8vIFJlbGF5IFNUQVRVUyB1cGRhdGVzIGZyb20gb2Zmc2NyZWVuIGRvY1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdTVEFUVVMnKSB7XG4gICAgICB1cGRhdGVTdGF0ZSh7XG4gICAgICAgIGFjdGl2ZTogaXNDYXB0dXJpbmcsXG4gICAgICAgIHN0YXR1czogbWVzc2FnZS5tZXNzYWdlLFxuICAgICAgICB0YWJJZDogYWN0aXZlVGFiSWQsXG4gICAgICAgIHZpZGVvSWQ6IGFjdGl2ZVZpZGVvSWQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBDT01NRU5UQVJZIG1lc3NhZ2VzIGFyZSByZWxheWVkIGF1dG9tYXRpY2FsbHkgdG8gYWxsIGV4dGVuc2lvbiBwYWdlc1xuICAgIC8vIChzaWRlIHBhbmVsIGxpc3RlbnMgdmlhIGNocm9tZS5ydW50aW1lLm9uTWVzc2FnZSlcbiAgfSxcbik7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUJhY2tncm91bmQoKCkgPT4ge1xuICBjb25zb2xlLmxvZygnW0FJIENvbW1lbnRhdG9yXSBTZXJ2aWNlIHdvcmtlciBzdGFydGVkJyk7XG5cbiAgLy8gT3BlbiB0aGUgc2lkZSBwYW5lbCB3aGVuIHRoZSBleHRlbnNpb24gaWNvbiBpcyBjbGlja2VkXG4gIGNocm9tZS5hY3Rpb24ub25DbGlja2VkLmFkZExpc3RlbmVyKCh0YWIpID0+IHtcbiAgICBpZiAodGFiLndpbmRvd0lkKSB7XG4gICAgICBjaHJvbWUuc2lkZVBhbmVsLm9wZW4oeyB3aW5kb3dJZDogdGFiLndpbmRvd0lkIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb24gQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pXG4qIGBgYFxuKiBAbW9kdWxlIHd4dC9icm93c2VyXG4qL1xuY29uc3QgYnJvd3NlciA9IGJyb3dzZXIkMTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07IiwiLy8gc3JjL2luZGV4LnRzXG52YXIgX01hdGNoUGF0dGVybiA9IGNsYXNzIHtcbiAgY29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuKSB7XG4gICAgaWYgKG1hdGNoUGF0dGVybiA9PT0gXCI8YWxsX3VybHM+XCIpIHtcbiAgICAgIHRoaXMuaXNBbGxVcmxzID0gdHJ1ZTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gWy4uLl9NYXRjaFBhdHRlcm4uUFJPVE9DT0xTXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IFwiKlwiO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gXCIqXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGdyb3VwcyA9IC8oLiopOlxcL1xcLyguKj8pKFxcLy4qKS8uZXhlYyhtYXRjaFBhdHRlcm4pO1xuICAgICAgaWYgKGdyb3VwcyA9PSBudWxsKVxuICAgICAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIFwiSW5jb3JyZWN0IGZvcm1hdFwiKTtcbiAgICAgIGNvbnN0IFtfLCBwcm90b2NvbCwgaG9zdG5hbWUsIHBhdGhuYW1lXSA9IGdyb3VwcztcbiAgICAgIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCk7XG4gICAgICB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpO1xuICAgICAgdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gcHJvdG9jb2wgPT09IFwiKlwiID8gW1wiaHR0cFwiLCBcImh0dHBzXCJdIDogW3Byb3RvY29sXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IGhvc3RuYW1lO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gcGF0aG5hbWU7XG4gICAgfVxuICB9XG4gIGluY2x1ZGVzKHVybCkge1xuICAgIGlmICh0aGlzLmlzQWxsVXJscylcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IHUgPSB0eXBlb2YgdXJsID09PSBcInN0cmluZ1wiID8gbmV3IFVSTCh1cmwpIDogdXJsIGluc3RhbmNlb2YgTG9jYXRpb24gPyBuZXcgVVJMKHVybC5ocmVmKSA6IHVybDtcbiAgICByZXR1cm4gISF0aGlzLnByb3RvY29sTWF0Y2hlcy5maW5kKChwcm90b2NvbCkgPT4ge1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImh0dHBcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiaHR0cHNcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwc01hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImZpbGVcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNGaWxlTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiZnRwXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzRnRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwidXJuXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzVXJuTWF0Y2godSk7XG4gICAgfSk7XG4gIH1cbiAgaXNIdHRwTWF0Y2godXJsKSB7XG4gICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG4gIH1cbiAgaXNIdHRwc01hdGNoKHVybCkge1xuICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcbiAgfVxuICBpc0hvc3RQYXRoTWF0Y2godXJsKSB7XG4gICAgaWYgKCF0aGlzLmhvc3RuYW1lTWF0Y2ggfHwgIXRoaXMucGF0aG5hbWVNYXRjaClcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBob3N0bmFtZU1hdGNoUmVnZXhzID0gW1xuICAgICAgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoKSxcbiAgICAgIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaC5yZXBsYWNlKC9eXFwqXFwuLywgXCJcIikpXG4gICAgXTtcbiAgICBjb25zdCBwYXRobmFtZU1hdGNoUmVnZXggPSB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLnBhdGhuYW1lTWF0Y2gpO1xuICAgIHJldHVybiAhIWhvc3RuYW1lTWF0Y2hSZWdleHMuZmluZCgocmVnZXgpID0+IHJlZ2V4LnRlc3QodXJsLmhvc3RuYW1lKSkgJiYgcGF0aG5hbWVNYXRjaFJlZ2V4LnRlc3QodXJsLnBhdGhuYW1lKTtcbiAgfVxuICBpc0ZpbGVNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZmlsZTovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgaXNGdHBNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZnRwOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBpc1Vybk1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiB1cm46Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGNvbnZlcnRQYXR0ZXJuVG9SZWdleChwYXR0ZXJuKSB7XG4gICAgY29uc3QgZXNjYXBlZCA9IHRoaXMuZXNjYXBlRm9yUmVnZXgocGF0dGVybik7XG4gICAgY29uc3Qgc3RhcnNSZXBsYWNlZCA9IGVzY2FwZWQucmVwbGFjZSgvXFxcXFxcKi9nLCBcIi4qXCIpO1xuICAgIHJldHVybiBSZWdFeHAoYF4ke3N0YXJzUmVwbGFjZWR9JGApO1xuICB9XG4gIGVzY2FwZUZvclJlZ2V4KHN0cmluZykge1xuICAgIHJldHVybiBzdHJpbmcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICB9XG59O1xudmFyIE1hdGNoUGF0dGVybiA9IF9NYXRjaFBhdHRlcm47XG5NYXRjaFBhdHRlcm4uUFJPVE9DT0xTID0gW1wiaHR0cFwiLCBcImh0dHBzXCIsIFwiZmlsZVwiLCBcImZ0cFwiLCBcInVyblwiXTtcbnZhciBJbnZhbGlkTWF0Y2hQYXR0ZXJuID0gY2xhc3MgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybiwgcmVhc29uKSB7XG4gICAgc3VwZXIoYEludmFsaWQgbWF0Y2ggcGF0dGVybiBcIiR7bWF0Y2hQYXR0ZXJufVwiOiAke3JlYXNvbn1gKTtcbiAgfVxufTtcbmZ1bmN0aW9uIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCkge1xuICBpZiAoIU1hdGNoUGF0dGVybi5QUk9UT0NPTFMuaW5jbHVkZXMocHJvdG9jb2wpICYmIHByb3RvY29sICE9PSBcIipcIilcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihcbiAgICAgIG1hdGNoUGF0dGVybixcbiAgICAgIGAke3Byb3RvY29sfSBub3QgYSB2YWxpZCBwcm90b2NvbCAoJHtNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmpvaW4oXCIsIFwiKX0pYFxuICAgICk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpIHtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiOlwiKSlcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGBIb3N0bmFtZSBjYW5ub3QgaW5jbHVkZSBhIHBvcnRgKTtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiKlwiKSAmJiBob3N0bmFtZS5sZW5ndGggPiAxICYmICFob3N0bmFtZS5zdGFydHNXaXRoKFwiKi5cIikpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4oXG4gICAgICBtYXRjaFBhdHRlcm4sXG4gICAgICBgSWYgdXNpbmcgYSB3aWxkY2FyZCAoKiksIGl0IG11c3QgZ28gYXQgdGhlIHN0YXJ0IG9mIHRoZSBob3N0bmFtZWBcbiAgICApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKSB7XG4gIHJldHVybjtcbn1cbmV4cG9ydCB7XG4gIEludmFsaWRNYXRjaFBhdHRlcm4sXG4gIE1hdGNoUGF0dGVyblxufTtcbiJdLCJuYW1lcyI6WyJicm93c2VyIl0sIm1hcHBpbmdzIjoiOztBQUNBLFdBQVMsaUJBQWlCLEtBQUs7QUFDOUIsUUFBSSxPQUFPLFFBQVEsT0FBTyxRQUFRLFdBQVksUUFBTyxFQUFFLE1BQU0sSUFBRztBQUNoRSxXQUFPO0FBQUEsRUFDUjtBQ1FBLE1BQUEsY0FBQTtBQUNBLE1BQUEsY0FBQTtBQUNBLE1BQUEsZ0JBQUE7QUFHQSxXQUFBLGVBQUEsS0FBQTtBQUNFLFFBQUEsQ0FBQSxJQUFBLFFBQUE7QUFDQSxVQUFBLFFBQUEsSUFBQSxNQUFBLGlEQUFBO0FBQ0EsV0FBQSxRQUFBLE1BQUEsQ0FBQSxJQUFBO0FBQUEsRUFDRjtBQUVBLFdBQUEsWUFBQSxPQUFBO0FBQ0UsV0FBQSxRQUFBLFFBQUEsSUFBQSxFQUFBLGtCQUFBLE9BQUE7QUFBQSxFQUNGO0FBRUEsaUJBQUEsa0JBQUE7QUFDRSxVQUFBLFdBQUEsTUFBQSxPQUFBLFFBQUEsWUFBQTtBQUFBLE1BQWtELGNBQUEsQ0FBQSxvQkFBQTtBQUFBLElBQ2lCLENBQUE7QUFFbkUsUUFBQSxTQUFBLFNBQUEsRUFBQTtBQUVBLFVBQUEsT0FBQSxVQUFBLGVBQUE7QUFBQSxNQUFzQyxLQUFBO0FBQUEs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
