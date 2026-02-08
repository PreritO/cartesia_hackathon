var content = (function() {
  "use strict";
  function defineContentScript(definition2) {
    return definition2;
  }
  const CAPTURE_FPS = 5;
  const JPEG_QUALITY = 0.7;
  const MAX_WIDTH = 1280;
  let captureInterval = null;
  let overlayEl = null;
  let wasMuted = false;
  function findVideo() {
    return document.querySelector("video");
  }
  function startCapture(port) {
    const video = findVideo();
    if (!video) {
      port.postMessage({ type: "ERROR", message: "No video element found" });
      return;
    }
    wasMuted = video.muted;
    video.muted = true;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
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
      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      const base64 = dataUrl.split(",")[1];
      port.postMessage({ type: "FRAME", data: base64, ts: Date.now() });
    }, 1e3 / CAPTURE_FPS);
    port.postMessage({ type: "CAPTURE_ACTIVE" });
  }
  function stopCapture() {
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    hideOverlay();
    const video = findVideo();
    if (video) video.muted = wasMuted;
  }
  function showOverlay() {
    hideOverlay();
    const video = findVideo();
    if (!video) return;
    const player = video.closest(".html5-video-player") || video.parentElement;
    if (!player || !(player instanceof HTMLElement)) return;
    const pos = getComputedStyle(player).position;
    if (pos === "static") player.style.position = "relative";
    overlayEl = document.createElement("div");
    overlayEl.id = "ai-commentator-overlay";
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
  const definition = defineContentScript({
    matches: ["*://*.youtube.com/*"],
    runAt: "document_idle",
    main() {
      console.log("[AI Commentator] Content script loaded on YouTube page");
      chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== "capture") return;
        console.log("[AI Commentator] Capture port connected");
        port.onMessage.addListener((msg) => {
          if (msg.type === "START_CAPTURE") startCapture(port);
          if (msg.type === "STOP_CAPTURE") stopCapture();
        });
        port.onDisconnect.addListener(() => {
          console.log("[AI Commentator] Capture port disconnected");
          stopCapture();
        });
      });
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        const video = findVideo();
        if (!video) {
          sendResponse({ ok: false, error: "No video element found" });
          return;
        }
        switch (message.type) {
          case "VIDEO_PLAY":
            video.play();
            sendResponse({ ok: true });
            break;
          case "VIDEO_PAUSE":
            video.pause();
            sendResponse({ ok: true });
            break;
          case "VIDEO_MUTE":
            video.muted = true;
            sendResponse({ ok: true });
            break;
          case "VIDEO_UNMUTE":
            video.muted = false;
            sendResponse({ ok: true });
            break;
          case "VIDEO_STATUS":
            sendResponse({
              ok: true,
              paused: video.paused,
              muted: video.muted,
              currentTime: video.currentTime,
              duration: video.duration
            });
            break;
          default:
            sendResponse({ ok: false, error: "Unknown message type" });
        }
      });
    }
  });
  function print$1(method, ...args) {
    if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
    else method("[wxt]", ...args);
  }
  const logger$1 = {
    debug: (...args) => print$1(console.debug, ...args),
    log: (...args) => print$1(console.log, ...args),
    warn: (...args) => print$1(console.warn, ...args),
    error: (...args) => print$1(console.error, ...args)
  };
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  var WxtLocationChangeEvent = class WxtLocationChangeEvent2 extends Event {
    static EVENT_NAME = getUniqueEventName("wxt:locationchange");
    constructor(newUrl, oldUrl) {
      super(WxtLocationChangeEvent2.EVENT_NAME, {});
      this.newUrl = newUrl;
      this.oldUrl = oldUrl;
    }
  };
  function getUniqueEventName(eventName) {
    return `${browser?.runtime?.id}:${"content"}:${eventName}`;
  }
  function createLocationWatcher(ctx) {
    let interval;
    let oldUrl;
    return { run() {
      if (interval != null) return;
      oldUrl = new URL(location.href);
      interval = ctx.setInterval(() => {
        let newUrl = new URL(location.href);
        if (newUrl.href !== oldUrl.href) {
          window.dispatchEvent(new WxtLocationChangeEvent(newUrl, oldUrl));
          oldUrl = newUrl;
        }
      }, 1e3);
    } };
  }
  var ContentScriptContext = class ContentScriptContext2 {
    static SCRIPT_STARTED_MESSAGE_TYPE = getUniqueEventName("wxt:content-script-started");
    isTopFrame = window.self === window.top;
    abortController;
    locationWatcher = createLocationWatcher(this);
    receivedMessageIds = /* @__PURE__ */ new Set();
    constructor(contentScriptName, options) {
      this.contentScriptName = contentScriptName;
      this.options = options;
      this.abortController = new AbortController();
      if (this.isTopFrame) {
        this.listenForNewerScripts({ ignoreFirstEvent: true });
        this.stopOldScripts();
      } else this.listenForNewerScripts();
    }
    get signal() {
      return this.abortController.signal;
    }
    abort(reason) {
      return this.abortController.abort(reason);
    }
    get isInvalid() {
      if (browser.runtime?.id == null) this.notifyInvalidated();
      return this.signal.aborted;
    }
    get isValid() {
      return !this.isInvalid;
    }
    /**
    * Add a listener that is called when the content script's context is invalidated.
    *
    * @returns A function to remove the listener.
    *
    * @example
    * browser.runtime.onMessage.addListener(cb);
    * const removeInvalidatedListener = ctx.onInvalidated(() => {
    *   browser.runtime.onMessage.removeListener(cb);
    * })
    * // ...
    * removeInvalidatedListener();
    */
    onInvalidated(cb) {
      this.signal.addEventListener("abort", cb);
      return () => this.signal.removeEventListener("abort", cb);
    }
    /**
    * Return a promise that never resolves. Useful if you have an async function that shouldn't run
    * after the context is expired.
    *
    * @example
    * const getValueFromStorage = async () => {
    *   if (ctx.isInvalid) return ctx.block();
    *
    *   // ...
    * }
    */
    block() {
      return new Promise(() => {
      });
    }
    /**
    * Wrapper around `window.setInterval` that automatically clears the interval when invalidated.
    *
    * Intervals can be cleared by calling the normal `clearInterval` function.
    */
    setInterval(handler, timeout) {
      const id = setInterval(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearInterval(id));
      return id;
    }
    /**
    * Wrapper around `window.setTimeout` that automatically clears the interval when invalidated.
    *
    * Timeouts can be cleared by calling the normal `setTimeout` function.
    */
    setTimeout(handler, timeout) {
      const id = setTimeout(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearTimeout(id));
      return id;
    }
    /**
    * Wrapper around `window.requestAnimationFrame` that automatically cancels the request when
    * invalidated.
    *
    * Callbacks can be canceled by calling the normal `cancelAnimationFrame` function.
    */
    requestAnimationFrame(callback) {
      const id = requestAnimationFrame((...args) => {
        if (this.isValid) callback(...args);
      });
      this.onInvalidated(() => cancelAnimationFrame(id));
      return id;
    }
    /**
    * Wrapper around `window.requestIdleCallback` that automatically cancels the request when
    * invalidated.
    *
    * Callbacks can be canceled by calling the normal `cancelIdleCallback` function.
    */
    requestIdleCallback(callback, options) {
      const id = requestIdleCallback((...args) => {
        if (!this.signal.aborted) callback(...args);
      }, options);
      this.onInvalidated(() => cancelIdleCallback(id));
      return id;
    }
    addEventListener(target, type, handler, options) {
      if (type === "wxt:locationchange") {
        if (this.isValid) this.locationWatcher.run();
      }
      target.addEventListener?.(type.startsWith("wxt:") ? getUniqueEventName(type) : type, handler, {
        ...options,
        signal: this.signal
      });
    }
    /**
    * @internal
    * Abort the abort controller and execute all `onInvalidated` listeners.
    */
    notifyInvalidated() {
      this.abort("Content script context invalidated");
      logger$1.debug(`Content script "${this.contentScriptName}" context invalidated`);
    }
    stopOldScripts() {
      window.postMessage({
        type: ContentScriptContext2.SCRIPT_STARTED_MESSAGE_TYPE,
        contentScriptName: this.contentScriptName,
        messageId: Math.random().toString(36).slice(2)
      }, "*");
    }
    verifyScriptStartedEvent(event) {
      const isScriptStartedEvent = event.data?.type === ContentScriptContext2.SCRIPT_STARTED_MESSAGE_TYPE;
      const isSameContentScript = event.data?.contentScriptName === this.contentScriptName;
      const isNotDuplicate = !this.receivedMessageIds.has(event.data?.messageId);
      return isScriptStartedEvent && isSameContentScript && isNotDuplicate;
    }
    listenForNewerScripts(options) {
      let isFirst = true;
      const cb = (event) => {
        if (this.verifyScriptStartedEvent(event)) {
          this.receivedMessageIds.add(event.data.messageId);
          const wasFirst = isFirst;
          isFirst = false;
          if (wasFirst && options?.ignoreFirstEvent) return;
          this.notifyInvalidated();
        }
      };
      addEventListener("message", cb);
      this.onInvalidated(() => removeEventListener("message", cb));
    }
  };
  function initPlugins() {
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
  const result = (async () => {
    try {
      initPlugins();
      const { main, ...options } = definition;
      return await main(new ContentScriptContext("content", options));
    } catch (err) {
      logger.error(`The content script "${"content"}" crashed on startup!`, err);
      throw err;
    }
  })();
  return result;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9lbnRyeXBvaW50cy9jb250ZW50LnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvY2F0aW9uLXdhdGNoZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2NvbnRlbnQtc2NyaXB0LWNvbnRleHQubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vI3JlZ2lvbiBzcmMvdXRpbHMvZGVmaW5lLWNvbnRlbnQtc2NyaXB0LnRzXG5mdW5jdGlvbiBkZWZpbmVDb250ZW50U2NyaXB0KGRlZmluaXRpb24pIHtcblx0cmV0dXJuIGRlZmluaXRpb247XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQ29udGVudFNjcmlwdCB9OyIsIi8qKlxuICogQ29udGVudCBzY3JpcHQgaW5qZWN0ZWQgaW50byBZb3VUdWJlIHBhZ2VzLlxuICpcbiAqIFdoZW4gdGhlIHNpZGUgcGFuZWwgY29ubmVjdHMgdmlhIGEgcG9ydCBuYW1lZCBcImNhcHR1cmVcIjpcbiAqIDEuIERyYXdzIHRoZSBwYWdlJ3MgPHZpZGVvPiBlbGVtZW50IHRvIGFuIG9mZnNjcmVlbiBjYW52YXMgYXQgNSBGUFMuXG4gKiAyLiBTZW5kcyBKUEVHIGZyYW1lcyAoYmFzZTY0KSB0byB0aGUgc2lkZSBwYW5lbCB2aWEgdGhlIHBvcnQuXG4gKiAzLiBPdmVybGF5cyB0aGUgWW91VHViZSB2aWRlbyBwbGF5ZXIgd2l0aCBhIFwiV2F0Y2ggaW4gc2lkZWJhclwiIGJhbm5lci5cbiAqIDQuIE11dGVzIHRoZSB2aWRlbyAoYXVkaW8gY29tZXMgZnJvbSBUVFMgaW4gdGhlIHNpZGViYXIpLlxuICpcbiAqIFRoaXMgZGVjb3VwbGVzIGZyYW1lIGNhcHR1cmUgZnJvbSBkaXNwbGF5OiB0aGUgc2lkZWJhciBzaG93cyBhIGRlbGF5ZWQsXG4gKiBzeW5jZWQgdmVyc2lvbiB3aGlsZSB0aGUgdGFiJ3MgdmlkZW8gaXMgaGlkZGVuIHVuZGVyIGFuIG92ZXJsYXkuXG4gKi9cblxuY29uc3QgQ0FQVFVSRV9GUFMgPSA1O1xuY29uc3QgSlBFR19RVUFMSVRZID0gMC43O1xuY29uc3QgTUFYX1dJRFRIID0gMTI4MDtcblxubGV0IGNhcHR1cmVJbnRlcnZhbDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG5sZXQgb3ZlcmxheUVsOiBIVE1MRGl2RWxlbWVudCB8IG51bGwgPSBudWxsO1xubGV0IHdhc011dGVkID0gZmFsc2U7XG5cbmZ1bmN0aW9uIGZpbmRWaWRlbygpOiBIVE1MVmlkZW9FbGVtZW50IHwgbnVsbCB7XG4gIHJldHVybiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCd2aWRlbycpO1xufVxuXG5mdW5jdGlvbiBzdGFydENhcHR1cmUocG9ydDogY2hyb21lLnJ1bnRpbWUuUG9ydCkge1xuICBjb25zdCB2aWRlbyA9IGZpbmRWaWRlbygpO1xuICBpZiAoIXZpZGVvKSB7XG4gICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6ICdFUlJPUicsIG1lc3NhZ2U6ICdObyB2aWRlbyBlbGVtZW50IGZvdW5kJyB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZW1lbWJlciBtdXRlIHN0YXRlIGFuZCBtdXRlIChhdWRpbyBjb21lcyBmcm9tIFRUUylcbiAgd2FzTXV0ZWQgPSB2aWRlby5tdXRlZDtcbiAgdmlkZW8ubXV0ZWQgPSB0cnVlO1xuXG4gIC8vIENyZWF0ZSBvZmZzY3JlZW4gY2FudmFzXG4gIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKSE7XG5cbiAgLy8gU2hvdyBvdmVybGF5XG4gIHNob3dPdmVybGF5KCk7XG5cbiAgY2FwdHVyZUludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGlmICghdmlkZW8gfHwgdmlkZW8ucmVhZHlTdGF0ZSA8IHZpZGVvLkhBVkVfQ1VSUkVOVF9EQVRBKSByZXR1cm47XG5cbiAgICBsZXQgdyA9IHZpZGVvLnZpZGVvV2lkdGg7XG4gICAgbGV0IGggPSB2aWRlby52aWRlb0hlaWdodDtcbiAgICBpZiAodyA9PT0gMCB8fCBoID09PSAwKSByZXR1cm47XG5cbiAgICBpZiAodyA+IE1BWF9XSURUSCkge1xuICAgICAgY29uc3Qgc2NhbGUgPSBNQVhfV0lEVEggLyB3O1xuICAgICAgdyA9IE1BWF9XSURUSDtcbiAgICAgIGggPSBNYXRoLnJvdW5kKGggKiBzY2FsZSk7XG4gICAgfVxuXG4gICAgaWYgKGNhbnZhcy53aWR0aCAhPT0gdyB8fCBjYW52YXMuaGVpZ2h0ICE9PSBoKSB7XG4gICAgICBjYW52YXMud2lkdGggPSB3O1xuICAgICAgY2FudmFzLmhlaWdodCA9IGg7XG4gICAgfVxuXG4gICAgY3R4LmRyYXdJbWFnZSh2aWRlbywgMCwgMCwgdywgaCk7XG4gICAgY29uc3QgZGF0YVVybCA9IGNhbnZhcy50b0RhdGFVUkwoJ2ltYWdlL2pwZWcnLCBKUEVHX1FVQUxJVFkpO1xuICAgIGNvbnN0IGJhc2U2NCA9IGRhdGFVcmwuc3BsaXQoJywnKVsxXTtcbiAgICBwb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogJ0ZSQU1FJywgZGF0YTogYmFzZTY0LCB0czogRGF0ZS5ub3coKSB9KTtcbiAgfSwgMTAwMCAvIENBUFRVUkVfRlBTKTtcblxuICBwb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogJ0NBUFRVUkVfQUNUSVZFJyB9KTtcbn1cblxuZnVuY3Rpb24gc3RvcENhcHR1cmUoKSB7XG4gIGlmIChjYXB0dXJlSW50ZXJ2YWwpIHtcbiAgICBjbGVhckludGVydmFsKGNhcHR1cmVJbnRlcnZhbCk7XG4gICAgY2FwdHVyZUludGVydmFsID0gbnVsbDtcbiAgfVxuICBoaWRlT3ZlcmxheSgpO1xuICAvLyBSZXN0b3JlIG11dGUgc3RhdGVcbiAgY29uc3QgdmlkZW8gPSBmaW5kVmlkZW8oKTtcbiAgaWYgKHZpZGVvKSB2aWRlby5tdXRlZCA9IHdhc011dGVkO1xufVxuXG4vLyAtLS0tIE92ZXJsYXkgb24gWW91VHViZSBwbGF5ZXIgLS0tLVxuXG5mdW5jdGlvbiBzaG93T3ZlcmxheSgpIHtcbiAgaGlkZU92ZXJsYXkoKTtcbiAgY29uc3QgdmlkZW8gPSBmaW5kVmlkZW8oKTtcbiAgaWYgKCF2aWRlbykgcmV0dXJuO1xuXG4gIC8vIFlvdVR1YmUgd3JhcHMgdGhlIHZpZGVvIGluIC5odG1sNS12aWRlby1wbGF5ZXJcbiAgY29uc3QgcGxheWVyID0gdmlkZW8uY2xvc2VzdCgnLmh0bWw1LXZpZGVvLXBsYXllcicpIHx8IHZpZGVvLnBhcmVudEVsZW1lbnQ7XG4gIGlmICghcGxheWVyIHx8ICEocGxheWVyIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSByZXR1cm47XG5cbiAgLy8gRW5zdXJlIHBhcmVudCBpcyBwb3NpdGlvbmVkIHNvIGFic29sdXRlIG92ZXJsYXkgd29ya3NcbiAgY29uc3QgcG9zID0gZ2V0Q29tcHV0ZWRTdHlsZShwbGF5ZXIpLnBvc2l0aW9uO1xuICBpZiAocG9zID09PSAnc3RhdGljJykgcGxheWVyLnN0eWxlLnBvc2l0aW9uID0gJ3JlbGF0aXZlJztcblxuICBvdmVybGF5RWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgb3ZlcmxheUVsLmlkID0gJ2FpLWNvbW1lbnRhdG9yLW92ZXJsYXknO1xuICBvdmVybGF5RWwuc3R5bGUuY3NzVGV4dCA9IGBcbiAgICBwb3NpdGlvbjogYWJzb2x1dGU7XG4gICAgdG9wOiAwOyBsZWZ0OiAwOyByaWdodDogMDsgYm90dG9tOiAwO1xuICAgIGJhY2tncm91bmQ6IHJnYmEoMTUsIDIzLCA0MiwgMC45Mik7XG4gICAgZGlzcGxheTogZmxleDtcbiAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7XG4gICAgei1pbmRleDogOTk5OTtcbiAgICBwb2ludGVyLWV2ZW50czogbm9uZTtcbiAgICBmb250LWZhbWlseTogc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBzYW5zLXNlcmlmO1xuICBgO1xuICBvdmVybGF5RWwuaW5uZXJIVE1MID0gYFxuICAgIDxkaXYgc3R5bGU9XCJ0ZXh0LWFsaWduOiBjZW50ZXI7IGNvbG9yOiB3aGl0ZTtcIj5cbiAgICAgIDxkaXYgc3R5bGU9XCJmb250LXNpemU6IDQ4cHg7IG1hcmdpbi1ib3R0b206IDEycHg7XCI+JiMxMjc5MDg7PC9kaXY+XG4gICAgICA8ZGl2IHN0eWxlPVwiZm9udC1zaXplOiAxOHB4OyBmb250LXdlaWdodDogNzAwOyBtYXJnaW4tYm90dG9tOiA2cHg7XCI+QUkgQ29tbWVudGFyeSBBY3RpdmU8L2Rpdj5cbiAgICAgIDxkaXYgc3R5bGU9XCJmb250LXNpemU6IDE0cHg7IGNvbG9yOiAjOTRhM2I4O1wiPldhdGNoIHRoZSBzeW5jZWQgYnJvYWRjYXN0IGluIHRoZSBzaWRlYmFyPC9kaXY+XG4gICAgPC9kaXY+XG4gIGA7XG4gIHBsYXllci5hcHBlbmRDaGlsZChvdmVybGF5RWwpO1xufVxuXG5mdW5jdGlvbiBoaWRlT3ZlcmxheSgpIHtcbiAgaWYgKG92ZXJsYXlFbCkge1xuICAgIG92ZXJsYXlFbC5yZW1vdmUoKTtcbiAgICBvdmVybGF5RWwgPSBudWxsO1xuICB9XG59XG5cbi8vIC0tLS0gRW50cnkgcG9pbnQgLS0tLVxuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb250ZW50U2NyaXB0KHtcbiAgbWF0Y2hlczogWycqOi8vKi55b3V0dWJlLmNvbS8qJ10sXG4gIHJ1bkF0OiAnZG9jdW1lbnRfaWRsZScsXG4gIG1haW4oKSB7XG4gICAgY29uc29sZS5sb2coJ1tBSSBDb21tZW50YXRvcl0gQ29udGVudCBzY3JpcHQgbG9hZGVkIG9uIFlvdVR1YmUgcGFnZScpO1xuXG4gICAgLy8gUG9ydC1iYXNlZCBjb21tdW5pY2F0aW9uIGZvciBmcmFtZSBjYXB0dXJlXG4gICAgY2hyb21lLnJ1bnRpbWUub25Db25uZWN0LmFkZExpc3RlbmVyKChwb3J0KSA9PiB7XG4gICAgICBpZiAocG9ydC5uYW1lICE9PSAnY2FwdHVyZScpIHJldHVybjtcbiAgICAgIGNvbnNvbGUubG9nKCdbQUkgQ29tbWVudGF0b3JdIENhcHR1cmUgcG9ydCBjb25uZWN0ZWQnKTtcblxuICAgICAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZykgPT4ge1xuICAgICAgICBpZiAobXNnLnR5cGUgPT09ICdTVEFSVF9DQVBUVVJFJykgc3RhcnRDYXB0dXJlKHBvcnQpO1xuICAgICAgICBpZiAobXNnLnR5cGUgPT09ICdTVE9QX0NBUFRVUkUnKSBzdG9wQ2FwdHVyZSgpO1xuICAgICAgfSk7XG5cbiAgICAgIHBvcnQub25EaXNjb25uZWN0LmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICAgICAgY29uc29sZS5sb2coJ1tBSSBDb21tZW50YXRvcl0gQ2FwdHVyZSBwb3J0IGRpc2Nvbm5lY3RlZCcpO1xuICAgICAgICBzdG9wQ2FwdHVyZSgpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBMZWdhY3kgbWVzc2FnZS1iYXNlZCB2aWRlbyBjb250cm9sXG4gICAgY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBfc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICAgIGNvbnN0IHZpZGVvID0gZmluZFZpZGVvKCk7XG4gICAgICBpZiAoIXZpZGVvKSB7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICdObyB2aWRlbyBlbGVtZW50IGZvdW5kJyB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzd2l0Y2ggKG1lc3NhZ2UudHlwZSkge1xuICAgICAgICBjYXNlICdWSURFT19QTEFZJzpcbiAgICAgICAgICB2aWRlby5wbGF5KCk7XG4gICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ1ZJREVPX1BBVVNFJzpcbiAgICAgICAgICB2aWRlby5wYXVzZSgpO1xuICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdWSURFT19NVVRFJzpcbiAgICAgICAgICB2aWRlby5tdXRlZCA9IHRydWU7XG4gICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ1ZJREVPX1VOTVVURSc6XG4gICAgICAgICAgdmlkZW8ubXV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnVklERU9fU1RBVFVTJzpcbiAgICAgICAgICBzZW5kUmVzcG9uc2Uoe1xuICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICBwYXVzZWQ6IHZpZGVvLnBhdXNlZCxcbiAgICAgICAgICAgIG11dGVkOiB2aWRlby5tdXRlZCxcbiAgICAgICAgICAgIGN1cnJlbnRUaW1lOiB2aWRlby5jdXJyZW50VGltZSxcbiAgICAgICAgICAgIGR1cmF0aW9uOiB2aWRlby5kdXJhdGlvbixcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAnVW5rbm93biBtZXNzYWdlIHR5cGUnIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxufSk7XG4iLCIvLyNyZWdpb24gc3JjL3V0aWxzL2ludGVybmFsL2xvZ2dlci50c1xuZnVuY3Rpb24gcHJpbnQobWV0aG9kLCAuLi5hcmdzKSB7XG5cdGlmIChpbXBvcnQubWV0YS5lbnYuTU9ERSA9PT0gXCJwcm9kdWN0aW9uXCIpIHJldHVybjtcblx0aWYgKHR5cGVvZiBhcmdzWzBdID09PSBcInN0cmluZ1wiKSBtZXRob2QoYFt3eHRdICR7YXJncy5zaGlmdCgpfWAsIC4uLmFyZ3MpO1xuXHRlbHNlIG1ldGhvZChcIlt3eHRdXCIsIC4uLmFyZ3MpO1xufVxuLyoqXG4qIFdyYXBwZXIgYXJvdW5kIGBjb25zb2xlYCB3aXRoIGEgXCJbd3h0XVwiIHByZWZpeFxuKi9cbmNvbnN0IGxvZ2dlciA9IHtcblx0ZGVidWc6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmRlYnVnLCAuLi5hcmdzKSxcblx0bG9nOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5sb2csIC4uLmFyZ3MpLFxuXHR3YXJuOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS53YXJuLCAuLi5hcmdzKSxcblx0ZXJyb3I6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmVycm9yLCAuLi5hcmdzKVxufTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBsb2dnZXIgfTsiLCIvLyAjcmVnaW9uIHNuaXBwZXRcbmV4cG9ydCBjb25zdCBicm93c2VyID0gZ2xvYmFsVGhpcy5icm93c2VyPy5ydW50aW1lPy5pZFxuICA/IGdsb2JhbFRoaXMuYnJvd3NlclxuICA6IGdsb2JhbFRoaXMuY2hyb21lO1xuLy8gI2VuZHJlZ2lvbiBzbmlwcGV0XG4iLCJpbXBvcnQgeyBicm93c2VyIGFzIGJyb3dzZXIkMSB9IGZyb20gXCJAd3h0LWRldi9icm93c2VyXCI7XG5cbi8vI3JlZ2lvbiBzcmMvYnJvd3Nlci50c1xuLyoqXG4qIENvbnRhaW5zIHRoZSBgYnJvd3NlcmAgZXhwb3J0IHdoaWNoIHlvdSBzaG91bGQgdXNlIHRvIGFjY2VzcyB0aGUgZXh0ZW5zaW9uIEFQSXMgaW4geW91ciBwcm9qZWN0OlxuKiBgYGB0c1xuKiBpbXBvcnQgeyBicm93c2VyIH0gZnJvbSAnd3h0L2Jyb3dzZXInO1xuKlxuKiBicm93c2VyLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoKCkgPT4ge1xuKiAgIC8vIC4uLlxuKiB9KVxuKiBgYGBcbiogQG1vZHVsZSB3eHQvYnJvd3NlclxuKi9cbmNvbnN0IGJyb3dzZXIgPSBicm93c2VyJDE7XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgYnJvd3NlciB9OyIsImltcG9ydCB7IGJyb3dzZXIgfSBmcm9tIFwid3h0L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy91dGlscy9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLnRzXG52YXIgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCA9IGNsYXNzIFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG5cdHN0YXRpYyBFVkVOVF9OQU1FID0gZ2V0VW5pcXVlRXZlbnROYW1lKFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpO1xuXHRjb25zdHJ1Y3RvcihuZXdVcmwsIG9sZFVybCkge1xuXHRcdHN1cGVyKFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQuRVZFTlRfTkFNRSwge30pO1xuXHRcdHRoaXMubmV3VXJsID0gbmV3VXJsO1xuXHRcdHRoaXMub2xkVXJsID0gb2xkVXJsO1xuXHR9XG59O1xuLyoqXG4qIFJldHVybnMgYW4gZXZlbnQgbmFtZSB1bmlxdWUgdG8gdGhlIGV4dGVuc2lvbiBhbmQgY29udGVudCBzY3JpcHQgdGhhdCdzIHJ1bm5pbmcuXG4qL1xuZnVuY3Rpb24gZ2V0VW5pcXVlRXZlbnROYW1lKGV2ZW50TmFtZSkge1xuXHRyZXR1cm4gYCR7YnJvd3Nlcj8ucnVudGltZT8uaWR9OiR7aW1wb3J0Lm1ldGEuZW52LkVOVFJZUE9JTlR9OiR7ZXZlbnROYW1lfWA7XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCwgZ2V0VW5pcXVlRXZlbnROYW1lIH07IiwiaW1wb3J0IHsgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCB9IGZyb20gXCIuL2N1c3RvbS1ldmVudHMubWpzXCI7XG5cbi8vI3JlZ2lvbiBzcmMvdXRpbHMvaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci50c1xuLyoqXG4qIENyZWF0ZSBhIHV0aWwgdGhhdCB3YXRjaGVzIGZvciBVUkwgY2hhbmdlcywgZGlzcGF0Y2hpbmcgdGhlIGN1c3RvbSBldmVudCB3aGVuIGRldGVjdGVkLiBTdG9wc1xuKiB3YXRjaGluZyB3aGVuIGNvbnRlbnQgc2NyaXB0IGlzIGludmFsaWRhdGVkLlxuKi9cbmZ1bmN0aW9uIGNyZWF0ZUxvY2F0aW9uV2F0Y2hlcihjdHgpIHtcblx0bGV0IGludGVydmFsO1xuXHRsZXQgb2xkVXJsO1xuXHRyZXR1cm4geyBydW4oKSB7XG5cdFx0aWYgKGludGVydmFsICE9IG51bGwpIHJldHVybjtcblx0XHRvbGRVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuXHRcdGludGVydmFsID0gY3R4LnNldEludGVydmFsKCgpID0+IHtcblx0XHRcdGxldCBuZXdVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuXHRcdFx0aWYgKG5ld1VybC5ocmVmICE9PSBvbGRVcmwuaHJlZikge1xuXHRcdFx0XHR3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgV3h0TG9jYXRpb25DaGFuZ2VFdmVudChuZXdVcmwsIG9sZFVybCkpO1xuXHRcdFx0XHRvbGRVcmwgPSBuZXdVcmw7XG5cdFx0XHR9XG5cdFx0fSwgMWUzKTtcblx0fSB9O1xufVxuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGNyZWF0ZUxvY2F0aW9uV2F0Y2hlciB9OyIsImltcG9ydCB7IGxvZ2dlciB9IGZyb20gXCIuL2ludGVybmFsL2xvZ2dlci5tanNcIjtcbmltcG9ydCB7IGdldFVuaXF1ZUV2ZW50TmFtZSB9IGZyb20gXCIuL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVMb2NhdGlvbldhdGNoZXIgfSBmcm9tIFwiLi9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLm1qc1wiO1xuaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuXG4vLyNyZWdpb24gc3JjL3V0aWxzL2NvbnRlbnQtc2NyaXB0LWNvbnRleHQudHNcbi8qKlxuKiBJbXBsZW1lbnRzIFtgQWJvcnRDb250cm9sbGVyYF0oaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL0Fib3J0Q29udHJvbGxlcikuXG4qIFVzZWQgdG8gZGV0ZWN0IGFuZCBzdG9wIGNvbnRlbnQgc2NyaXB0IGNvZGUgd2hlbiB0aGUgc2NyaXB0IGlzIGludmFsaWRhdGVkLlxuKlxuKiBJdCBhbHNvIHByb3ZpZGVzIHNldmVyYWwgdXRpbGl0aWVzIGxpa2UgYGN0eC5zZXRUaW1lb3V0YCBhbmQgYGN0eC5zZXRJbnRlcnZhbGAgdGhhdCBzaG91bGQgYmUgdXNlZCBpblxuKiBjb250ZW50IHNjcmlwdHMgaW5zdGVhZCBvZiBgd2luZG93LnNldFRpbWVvdXRgIG9yIGB3aW5kb3cuc2V0SW50ZXJ2YWxgLlxuKlxuKiBUbyBjcmVhdGUgY29udGV4dCBmb3IgdGVzdGluZywgeW91IGNhbiB1c2UgdGhlIGNsYXNzJ3MgY29uc3RydWN0b3I6XG4qXG4qIGBgYHRzXG4qIGltcG9ydCB7IENvbnRlbnRTY3JpcHRDb250ZXh0IH0gZnJvbSAnd3h0L3V0aWxzL2NvbnRlbnQtc2NyaXB0cy1jb250ZXh0JztcbipcbiogdGVzdChcInN0b3JhZ2UgbGlzdGVuZXIgc2hvdWxkIGJlIHJlbW92ZWQgd2hlbiBjb250ZXh0IGlzIGludmFsaWRhdGVkXCIsICgpID0+IHtcbiogICBjb25zdCBjdHggPSBuZXcgQ29udGVudFNjcmlwdENvbnRleHQoJ3Rlc3QnKTtcbiogICBjb25zdCBpdGVtID0gc3RvcmFnZS5kZWZpbmVJdGVtKFwibG9jYWw6Y291bnRcIiwgeyBkZWZhdWx0VmFsdWU6IDAgfSk7XG4qICAgY29uc3Qgd2F0Y2hlciA9IHZpLmZuKCk7XG4qXG4qICAgY29uc3QgdW53YXRjaCA9IGl0ZW0ud2F0Y2god2F0Y2hlcik7XG4qICAgY3R4Lm9uSW52YWxpZGF0ZWQodW53YXRjaCk7IC8vIExpc3RlbiBmb3IgaW52YWxpZGF0ZSBoZXJlXG4qXG4qICAgYXdhaXQgaXRlbS5zZXRWYWx1ZSgxKTtcbiogICBleHBlY3Qod2F0Y2hlcikudG9CZUNhbGxlZFRpbWVzKDEpO1xuKiAgIGV4cGVjdCh3YXRjaGVyKS50b0JlQ2FsbGVkV2l0aCgxLCAwKTtcbipcbiogICBjdHgubm90aWZ5SW52YWxpZGF0ZWQoKTsgLy8gVXNlIHRoaXMgZnVuY3Rpb24gdG8gaW52YWxpZGF0ZSB0aGUgY29udGV4dFxuKiAgIGF3YWl0IGl0ZW0uc2V0VmFsdWUoMik7XG4qICAgZXhwZWN0KHdhdGNoZXIpLnRvQmVDYWxsZWRUaW1lcygxKTtcbiogfSk7XG4qIGBgYFxuKi9cbnZhciBDb250ZW50U2NyaXB0Q29udGV4dCA9IGNsYXNzIENvbnRlbnRTY3JpcHRDb250ZXh0IHtcblx0c3RhdGljIFNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSA9IGdldFVuaXF1ZUV2ZW50TmFtZShcInd4dDpjb250ZW50LXNjcmlwdC1zdGFydGVkXCIpO1xuXHRpc1RvcEZyYW1lID0gd2luZG93LnNlbGYgPT09IHdpbmRvdy50b3A7XG5cdGFib3J0Q29udHJvbGxlcjtcblx0bG9jYXRpb25XYXRjaGVyID0gY3JlYXRlTG9jYXRpb25XYXRjaGVyKHRoaXMpO1xuXHRyZWNlaXZlZE1lc3NhZ2VJZHMgPSAvKiBAX19QVVJFX18gKi8gbmV3IFNldCgpO1xuXHRjb25zdHJ1Y3Rvcihjb250ZW50U2NyaXB0TmFtZSwgb3B0aW9ucykge1xuXHRcdHRoaXMuY29udGVudFNjcmlwdE5hbWUgPSBjb250ZW50U2NyaXB0TmFtZTtcblx0XHR0aGlzLm9wdGlvbnMgPSBvcHRpb25zO1xuXHRcdHRoaXMuYWJvcnRDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXHRcdGlmICh0aGlzLmlzVG9wRnJhbWUpIHtcblx0XHRcdHRoaXMubGlzdGVuRm9yTmV3ZXJTY3JpcHRzKHsgaWdub3JlRmlyc3RFdmVudDogdHJ1ZSB9KTtcblx0XHRcdHRoaXMuc3RvcE9sZFNjcmlwdHMoKTtcblx0XHR9IGVsc2UgdGhpcy5saXN0ZW5Gb3JOZXdlclNjcmlwdHMoKTtcblx0fVxuXHRnZXQgc2lnbmFsKCkge1xuXHRcdHJldHVybiB0aGlzLmFib3J0Q29udHJvbGxlci5zaWduYWw7XG5cdH1cblx0YWJvcnQocmVhc29uKSB7XG5cdFx0cmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLmFib3J0KHJlYXNvbik7XG5cdH1cblx0Z2V0IGlzSW52YWxpZCgpIHtcblx0XHRpZiAoYnJvd3Nlci5ydW50aW1lPy5pZCA9PSBudWxsKSB0aGlzLm5vdGlmeUludmFsaWRhdGVkKCk7XG5cdFx0cmV0dXJuIHRoaXMuc2lnbmFsLmFib3J0ZWQ7XG5cdH1cblx0Z2V0IGlzVmFsaWQoKSB7XG5cdFx0cmV0dXJuICF0aGlzLmlzSW52YWxpZDtcblx0fVxuXHQvKipcblx0KiBBZGQgYSBsaXN0ZW5lciB0aGF0IGlzIGNhbGxlZCB3aGVuIHRoZSBjb250ZW50IHNjcmlwdCdzIGNvbnRleHQgaXMgaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBAcmV0dXJucyBBIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG5cdCpcblx0KiBAZXhhbXBsZVxuXHQqIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoY2IpO1xuXHQqIGNvbnN0IHJlbW92ZUludmFsaWRhdGVkTGlzdGVuZXIgPSBjdHgub25JbnZhbGlkYXRlZCgoKSA9PiB7XG5cdCogICBicm93c2VyLnJ1bnRpbWUub25NZXNzYWdlLnJlbW92ZUxpc3RlbmVyKGNiKTtcblx0KiB9KVxuXHQqIC8vIC4uLlxuXHQqIHJlbW92ZUludmFsaWRhdGVkTGlzdGVuZXIoKTtcblx0Ki9cblx0b25JbnZhbGlkYXRlZChjYikge1xuXHRcdHRoaXMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG5cdFx0cmV0dXJuICgpID0+IHRoaXMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG5cdH1cblx0LyoqXG5cdCogUmV0dXJuIGEgcHJvbWlzZSB0aGF0IG5ldmVyIHJlc29sdmVzLiBVc2VmdWwgaWYgeW91IGhhdmUgYW4gYXN5bmMgZnVuY3Rpb24gdGhhdCBzaG91bGRuJ3QgcnVuXG5cdCogYWZ0ZXIgdGhlIGNvbnRleHQgaXMgZXhwaXJlZC5cblx0KlxuXHQqIEBleGFtcGxlXG5cdCogY29uc3QgZ2V0VmFsdWVGcm9tU3RvcmFnZSA9IGFzeW5jICgpID0+IHtcblx0KiAgIGlmIChjdHguaXNJbnZhbGlkKSByZXR1cm4gY3R4LmJsb2NrKCk7XG5cdCpcblx0KiAgIC8vIC4uLlxuXHQqIH1cblx0Ki9cblx0YmxvY2soKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKCgpID0+IHt9KTtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnNldEludGVydmFsYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2xlYXJzIHRoZSBpbnRlcnZhbCB3aGVuIGludmFsaWRhdGVkLlxuXHQqXG5cdCogSW50ZXJ2YWxzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2xlYXJJbnRlcnZhbGAgZnVuY3Rpb24uXG5cdCovXG5cdHNldEludGVydmFsKGhhbmRsZXIsIHRpbWVvdXQpIHtcblx0XHRjb25zdCBpZCA9IHNldEludGVydmFsKCgpID0+IHtcblx0XHRcdGlmICh0aGlzLmlzVmFsaWQpIGhhbmRsZXIoKTtcblx0XHR9LCB0aW1lb3V0KTtcblx0XHR0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2xlYXJJbnRlcnZhbChpZCkpO1xuXHRcdHJldHVybiBpZDtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnNldFRpbWVvdXRgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBUaW1lb3V0cyBjYW4gYmUgY2xlYXJlZCBieSBjYWxsaW5nIHRoZSBub3JtYWwgYHNldFRpbWVvdXRgIGZ1bmN0aW9uLlxuXHQqL1xuXHRzZXRUaW1lb3V0KGhhbmRsZXIsIHRpbWVvdXQpIHtcblx0XHRjb25zdCBpZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuXHRcdH0sIHRpbWVvdXQpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhclRpbWVvdXQoaWQpKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cblx0LyoqXG5cdCogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWVgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cblx0KiBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxBbmltYXRpb25GcmFtZWAgZnVuY3Rpb24uXG5cdCovXG5cdHJlcXVlc3RBbmltYXRpb25GcmFtZShjYWxsYmFjaykge1xuXHRcdGNvbnN0IGlkID0gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCguLi5hcmdzKSA9PiB7XG5cdFx0XHRpZiAodGhpcy5pc1ZhbGlkKSBjYWxsYmFjayguLi5hcmdzKTtcblx0XHR9KTtcblx0XHR0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2FuY2VsQW5pbWF0aW9uRnJhbWUoaWQpKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cblx0LyoqXG5cdCogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0SWRsZUNhbGxiYWNrYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG5cdCogaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsSWRsZUNhbGxiYWNrYCBmdW5jdGlvbi5cblx0Ki9cblx0cmVxdWVzdElkbGVDYWxsYmFjayhjYWxsYmFjaywgb3B0aW9ucykge1xuXHRcdGNvbnN0IGlkID0gcmVxdWVzdElkbGVDYWxsYmFjaygoLi4uYXJncykgPT4ge1xuXHRcdFx0aWYgKCF0aGlzLnNpZ25hbC5hYm9ydGVkKSBjYWxsYmFjayguLi5hcmdzKTtcblx0XHR9LCBvcHRpb25zKTtcblx0XHR0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2FuY2VsSWRsZUNhbGxiYWNrKGlkKSk7XG5cdFx0cmV0dXJuIGlkO1xuXHR9XG5cdGFkZEV2ZW50TGlzdGVuZXIodGFyZ2V0LCB0eXBlLCBoYW5kbGVyLCBvcHRpb25zKSB7XG5cdFx0aWYgKHR5cGUgPT09IFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpIHtcblx0XHRcdGlmICh0aGlzLmlzVmFsaWQpIHRoaXMubG9jYXRpb25XYXRjaGVyLnJ1bigpO1xuXHRcdH1cblx0XHR0YXJnZXQuYWRkRXZlbnRMaXN0ZW5lcj8uKHR5cGUuc3RhcnRzV2l0aChcInd4dDpcIikgPyBnZXRVbmlxdWVFdmVudE5hbWUodHlwZSkgOiB0eXBlLCBoYW5kbGVyLCB7XG5cdFx0XHQuLi5vcHRpb25zLFxuXHRcdFx0c2lnbmFsOiB0aGlzLnNpZ25hbFxuXHRcdH0pO1xuXHR9XG5cdC8qKlxuXHQqIEBpbnRlcm5hbFxuXHQqIEFib3J0IHRoZSBhYm9ydCBjb250cm9sbGVyIGFuZCBleGVjdXRlIGFsbCBgb25JbnZhbGlkYXRlZGAgbGlzdGVuZXJzLlxuXHQqL1xuXHRub3RpZnlJbnZhbGlkYXRlZCgpIHtcblx0XHR0aGlzLmFib3J0KFwiQ29udGVudCBzY3JpcHQgY29udGV4dCBpbnZhbGlkYXRlZFwiKTtcblx0XHRsb2dnZXIuZGVidWcoYENvbnRlbnQgc2NyaXB0IFwiJHt0aGlzLmNvbnRlbnRTY3JpcHROYW1lfVwiIGNvbnRleHQgaW52YWxpZGF0ZWRgKTtcblx0fVxuXHRzdG9wT2xkU2NyaXB0cygpIHtcblx0XHR3aW5kb3cucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFLFxuXHRcdFx0Y29udGVudFNjcmlwdE5hbWU6IHRoaXMuY29udGVudFNjcmlwdE5hbWUsXG5cdFx0XHRtZXNzYWdlSWQ6IE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpXG5cdFx0fSwgXCIqXCIpO1xuXHR9XG5cdHZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkge1xuXHRcdGNvbnN0IGlzU2NyaXB0U3RhcnRlZEV2ZW50ID0gZXZlbnQuZGF0YT8udHlwZSA9PT0gQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFO1xuXHRcdGNvbnN0IGlzU2FtZUNvbnRlbnRTY3JpcHQgPSBldmVudC5kYXRhPy5jb250ZW50U2NyaXB0TmFtZSA9PT0gdGhpcy5jb250ZW50U2NyaXB0TmFtZTtcblx0XHRjb25zdCBpc05vdER1cGxpY2F0ZSA9ICF0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5oYXMoZXZlbnQuZGF0YT8ubWVzc2FnZUlkKTtcblx0XHRyZXR1cm4gaXNTY3JpcHRTdGFydGVkRXZlbnQgJiYgaXNTYW1lQ29udGVudFNjcmlwdCAmJiBpc05vdER1cGxpY2F0ZTtcblx0fVxuXHRsaXN0ZW5Gb3JOZXdlclNjcmlwdHMob3B0aW9ucykge1xuXHRcdGxldCBpc0ZpcnN0ID0gdHJ1ZTtcblx0XHRjb25zdCBjYiA9IChldmVudCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMudmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSkge1xuXHRcdFx0XHR0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5hZGQoZXZlbnQuZGF0YS5tZXNzYWdlSWQpO1xuXHRcdFx0XHRjb25zdCB3YXNGaXJzdCA9IGlzRmlyc3Q7XG5cdFx0XHRcdGlzRmlyc3QgPSBmYWxzZTtcblx0XHRcdFx0aWYgKHdhc0ZpcnN0ICYmIG9wdGlvbnM/Lmlnbm9yZUZpcnN0RXZlbnQpIHJldHVybjtcblx0XHRcdFx0dGhpcy5ub3RpZnlJbnZhbGlkYXRlZCgpO1xuXHRcdFx0fVxuXHRcdH07XG5cdFx0YWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgY2IpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiByZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYikpO1xuXHR9XG59O1xuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IENvbnRlbnRTY3JpcHRDb250ZXh0IH07Il0sIm5hbWVzIjpbImRlZmluaXRpb24iLCJwcmludCIsImxvZ2dlciIsImJyb3dzZXIiLCJXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IiwiQ29udGVudFNjcmlwdENvbnRleHQiXSwibWFwcGluZ3MiOiI7O0FBQ0EsV0FBUyxvQkFBb0JBLGFBQVk7QUFDeEMsV0FBT0E7QUFBQSxFQUNSO0FDVUEsUUFBQSxjQUFBO0FBQ0EsUUFBQSxlQUFBO0FBQ0EsUUFBQSxZQUFBO0FBRUEsTUFBQSxrQkFBQTtBQUNBLE1BQUEsWUFBQTtBQUNBLE1BQUEsV0FBQTtBQUVBLFdBQUEsWUFBQTtBQUNFLFdBQUEsU0FBQSxjQUFBLE9BQUE7QUFBQSxFQUNGO0FBRUEsV0FBQSxhQUFBLE1BQUE7QUFDRSxVQUFBLFFBQUEsVUFBQTtBQUNBLFFBQUEsQ0FBQSxPQUFBO0FBQ0UsV0FBQSxZQUFBLEVBQUEsTUFBQSxTQUFBLFNBQUEsMEJBQUE7QUFDQTtBQUFBLElBQUE7QUFJRixlQUFBLE1BQUE7QUFDQSxVQUFBLFFBQUE7QUFHQSxVQUFBLFNBQUEsU0FBQSxjQUFBLFFBQUE7QUFDQSxV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
content;