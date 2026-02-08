var content = (function() {
  "use strict";
  function defineContentScript(definition2) {
    return definition2;
  }
  const CAPTURE_FPS = 5;
  const JPEG_QUALITY = 0.7;
  const MAX_WIDTH = 1280;
  let captureInterval = null;
  let capturePort = null;
  let captureCanvas = null;
  let captureCtx = null;
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
    capturePort = port;
    wasMuted = video.muted;
    video.muted = true;
    captureCanvas = document.createElement("canvas");
    captureCtx = captureCanvas.getContext("2d");
    showOverlay();
    startCaptureLoop();
    port.postMessage({ type: "CAPTURE_ACTIVE" });
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
      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      const base64 = dataUrl.split(",")[1];
      port.postMessage({ type: "FRAME", data: base64, ts: Date.now() });
    }, 1e3 / CAPTURE_FPS);
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
    hideOverlay();
    const video = findVideo();
    if (video) video.muted = wasMuted;
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
          switch (msg.type) {
            case "START_CAPTURE":
              startCapture(port);
              break;
            case "STOP_CAPTURE":
              stopCapture();
              break;
            case "PAUSE_CAPTURE":
              pauseCapture();
              break;
            case "RESUME_CAPTURE":
              resumeCapture();
              break;
          }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9lbnRyeXBvaW50cy9jb250ZW50LnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvY2F0aW9uLXdhdGNoZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2NvbnRlbnQtc2NyaXB0LWNvbnRleHQubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vI3JlZ2lvbiBzcmMvdXRpbHMvZGVmaW5lLWNvbnRlbnQtc2NyaXB0LnRzXG5mdW5jdGlvbiBkZWZpbmVDb250ZW50U2NyaXB0KGRlZmluaXRpb24pIHtcblx0cmV0dXJuIGRlZmluaXRpb247XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQ29udGVudFNjcmlwdCB9OyIsIi8qKlxuICogQ29udGVudCBzY3JpcHQgaW5qZWN0ZWQgaW50byBZb3VUdWJlIHBhZ2VzLlxuICpcbiAqIFdoZW4gdGhlIHNpZGUgcGFuZWwgY29ubmVjdHMgdmlhIGEgcG9ydCBuYW1lZCBcImNhcHR1cmVcIjpcbiAqIDEuIERyYXdzIHRoZSBwYWdlJ3MgPHZpZGVvPiBlbGVtZW50IHRvIGFuIG9mZnNjcmVlbiBjYW52YXMgYXQgNSBGUFMuXG4gKiAyLiBTZW5kcyBKUEVHIGZyYW1lcyAoYmFzZTY0KSB0byB0aGUgc2lkZSBwYW5lbCB2aWEgdGhlIHBvcnQuXG4gKiAzLiBPdmVybGF5cyB0aGUgWW91VHViZSB2aWRlbyBwbGF5ZXIgd2l0aCBhIFwiV2F0Y2ggaW4gc2lkZWJhclwiIGJhbm5lci5cbiAqIDQuIE11dGVzIHRoZSB2aWRlbyAoYXVkaW8gY29tZXMgZnJvbSBUVFMgaW4gdGhlIHNpZGViYXIpLlxuICpcbiAqIFN1cHBvcnRzIFBBVVNFX0NBUFRVUkUgLyBSRVNVTUVfQ0FQVFVSRSB0byBmcmVlemUvcmVzdW1lIHRoZSBZb3VUdWJlXG4gKiB2aWRlbyBhbmQgZnJhbWUgY2FwdHVyZSBpbiBzeW5jIHdpdGggdGhlIHNpZGViYXIncyBwbGF5L3BhdXNlIGNvbnRyb2xzLlxuICovXG5cbmNvbnN0IENBUFRVUkVfRlBTID0gNTtcbmNvbnN0IEpQRUdfUVVBTElUWSA9IDAuNztcbmNvbnN0IE1BWF9XSURUSCA9IDEyODA7XG5cbmxldCBjYXB0dXJlSW50ZXJ2YWw6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xubGV0IGNhcHR1cmVQb3J0OiBjaHJvbWUucnVudGltZS5Qb3J0IHwgbnVsbCA9IG51bGw7XG5sZXQgY2FwdHVyZUNhbnZhczogSFRNTENhbnZhc0VsZW1lbnQgfCBudWxsID0gbnVsbDtcbmxldCBjYXB0dXJlQ3R4OiBDYW52YXNSZW5kZXJpbmdDb250ZXh0MkQgfCBudWxsID0gbnVsbDtcbmxldCBvdmVybGF5RWw6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgd2FzTXV0ZWQgPSBmYWxzZTtcblxuZnVuY3Rpb24gZmluZFZpZGVvKCk6IEhUTUxWaWRlb0VsZW1lbnQgfCBudWxsIHtcbiAgcmV0dXJuIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ3ZpZGVvJyk7XG59XG5cbi8vIC0tLS0gQ2FwdHVyZSBsaWZlY3ljbGUgLS0tLVxuXG5mdW5jdGlvbiBzdGFydENhcHR1cmUocG9ydDogY2hyb21lLnJ1bnRpbWUuUG9ydCkge1xuICBjb25zdCB2aWRlbyA9IGZpbmRWaWRlbygpO1xuICBpZiAoIXZpZGVvKSB7XG4gICAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6ICdFUlJPUicsIG1lc3NhZ2U6ICdObyB2aWRlbyBlbGVtZW50IGZvdW5kJyB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjYXB0dXJlUG9ydCA9IHBvcnQ7XG5cbiAgLy8gUmVtZW1iZXIgbXV0ZSBzdGF0ZSBhbmQgbXV0ZSAoYXVkaW8gY29tZXMgZnJvbSBUVFMpXG4gIHdhc011dGVkID0gdmlkZW8ubXV0ZWQ7XG4gIHZpZGVvLm11dGVkID0gdHJ1ZTtcblxuICAvLyBDcmVhdGUgb2Zmc2NyZWVuIGNhbnZhc1xuICBjYXB0dXJlQ2FudmFzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gIGNhcHR1cmVDdHggPSBjYXB0dXJlQ2FudmFzLmdldENvbnRleHQoJzJkJykhO1xuXG4gIHNob3dPdmVybGF5KCk7XG4gIHN0YXJ0Q2FwdHVyZUxvb3AoKTtcbiAgcG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6ICdDQVBUVVJFX0FDVElWRScgfSk7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0Q2FwdHVyZUxvb3AoKSB7XG4gIHN0b3BDYXB0dXJlTG9vcCgpO1xuICBjb25zdCB2aWRlbyA9IGZpbmRWaWRlbygpO1xuICBpZiAoIXZpZGVvIHx8ICFjYXB0dXJlQ3R4IHx8ICFjYXB0dXJlQ2FudmFzIHx8ICFjYXB0dXJlUG9ydCkgcmV0dXJuO1xuXG4gIGNvbnN0IGNhbnZhcyA9IGNhcHR1cmVDYW52YXM7XG4gIGNvbnN0IGN0eCA9IGNhcHR1cmVDdHg7XG4gIGNvbnN0IHBvcnQgPSBjYXB0dXJlUG9ydDtcblxuICBjYXB0dXJlSW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgaWYgKCF2aWRlbyB8fCB2aWRlby5yZWFkeVN0YXRlIDwgdmlkZW8uSEFWRV9DVVJSRU5UX0RBVEEpIHJldHVybjtcblxuICAgIGxldCB3ID0gdmlkZW8udmlkZW9XaWR0aDtcbiAgICBsZXQgaCA9IHZpZGVvLnZpZGVvSGVpZ2h0O1xuICAgIGlmICh3ID09PSAwIHx8IGggPT09IDApIHJldHVybjtcblxuICAgIGlmICh3ID4gTUFYX1dJRFRIKSB7XG4gICAgICBjb25zdCBzY2FsZSA9IE1BWF9XSURUSCAvIHc7XG4gICAgICB3ID0gTUFYX1dJRFRIO1xuICAgICAgaCA9IE1hdGgucm91bmQoaCAqIHNjYWxlKTtcbiAgICB9XG5cbiAgICBpZiAoY2FudmFzLndpZHRoICE9PSB3IHx8IGNhbnZhcy5oZWlnaHQgIT09IGgpIHtcbiAgICAgIGNhbnZhcy53aWR0aCA9IHc7XG4gICAgICBjYW52YXMuaGVpZ2h0ID0gaDtcbiAgICB9XG5cbiAgICBjdHguZHJhd0ltYWdlKHZpZGVvLCAwLCAwLCB3LCBoKTtcbiAgICBjb25zdCBkYXRhVXJsID0gY2FudmFzLnRvRGF0YVVSTCgnaW1hZ2UvanBlZycsIEpQRUdfUVVBTElUWSk7XG4gICAgY29uc3QgYmFzZTY0ID0gZGF0YVVybC5zcGxpdCgnLCcpWzFdO1xuICAgIHBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiAnRlJBTUUnLCBkYXRhOiBiYXNlNjQsIHRzOiBEYXRlLm5vdygpIH0pO1xuICB9LCAxMDAwIC8gQ0FQVFVSRV9GUFMpO1xufVxuXG5mdW5jdGlvbiBzdG9wQ2FwdHVyZUxvb3AoKSB7XG4gIGlmIChjYXB0dXJlSW50ZXJ2YWwpIHtcbiAgICBjbGVhckludGVydmFsKGNhcHR1cmVJbnRlcnZhbCk7XG4gICAgY2FwdHVyZUludGVydmFsID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBzdG9wQ2FwdHVyZSgpIHtcbiAgc3RvcENhcHR1cmVMb29wKCk7XG4gIGNhcHR1cmVQb3J0ID0gbnVsbDtcbiAgY2FwdHVyZUNhbnZhcyA9IG51bGw7XG4gIGNhcHR1cmVDdHggPSBudWxsO1xuICBoaWRlT3ZlcmxheSgpO1xuICBjb25zdCB2aWRlbyA9IGZpbmRWaWRlbygpO1xuICBpZiAodmlkZW8pIHZpZGVvLm11dGVkID0gd2FzTXV0ZWQ7XG59XG5cbmZ1bmN0aW9uIHBhdXNlQ2FwdHVyZSgpIHtcbiAgc3RvcENhcHR1cmVMb29wKCk7XG4gIGNvbnN0IHZpZGVvID0gZmluZFZpZGVvKCk7XG4gIGlmICh2aWRlbykgdmlkZW8ucGF1c2UoKTtcbn1cblxuZnVuY3Rpb24gcmVzdW1lQ2FwdHVyZSgpIHtcbiAgY29uc3QgdmlkZW8gPSBmaW5kVmlkZW8oKTtcbiAgaWYgKHZpZGVvKSB2aWRlby5wbGF5KCk7XG4gIHN0YXJ0Q2FwdHVyZUxvb3AoKTtcbn1cblxuLy8gLS0tLSBPdmVybGF5IG9uIFlvdVR1YmUgcGxheWVyIC0tLS1cblxuZnVuY3Rpb24gc2hvd092ZXJsYXkoKSB7XG4gIGhpZGVPdmVybGF5KCk7XG4gIGNvbnN0IHZpZGVvID0gZmluZFZpZGVvKCk7XG4gIGlmICghdmlkZW8pIHJldHVybjtcblxuICBjb25zdCBwbGF5ZXIgPSB2aWRlby5jbG9zZXN0KCcuaHRtbDUtdmlkZW8tcGxheWVyJykgfHwgdmlkZW8ucGFyZW50RWxlbWVudDtcbiAgaWYgKCFwbGF5ZXIgfHwgIShwbGF5ZXIgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIHJldHVybjtcblxuICBjb25zdCBwb3MgPSBnZXRDb21wdXRlZFN0eWxlKHBsYXllcikucG9zaXRpb247XG4gIGlmIChwb3MgPT09ICdzdGF0aWMnKSBwbGF5ZXIuc3R5bGUucG9zaXRpb24gPSAncmVsYXRpdmUnO1xuXG4gIG92ZXJsYXlFbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICBvdmVybGF5RWwuaWQgPSAnYWktY29tbWVudGF0b3Itb3ZlcmxheSc7XG4gIG92ZXJsYXlFbC5zdHlsZS5jc3NUZXh0ID0gYFxuICAgIHBvc2l0aW9uOiBhYnNvbHV0ZTtcbiAgICB0b3A6IDA7IGxlZnQ6IDA7IHJpZ2h0OiAwOyBib3R0b206IDA7XG4gICAgYmFja2dyb3VuZDogcmdiYSgxNSwgMjMsIDQyLCAwLjkyKTtcbiAgICBkaXNwbGF5OiBmbGV4O1xuICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcbiAgICB6LWluZGV4OiA5OTk5O1xuICAgIHBvaW50ZXItZXZlbnRzOiBub25lO1xuICAgIGZvbnQtZmFtaWx5OiBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIHNhbnMtc2VyaWY7XG4gIGA7XG4gIG92ZXJsYXlFbC5pbm5lckhUTUwgPSBgXG4gICAgPGRpdiBzdHlsZT1cInRleHQtYWxpZ246IGNlbnRlcjsgY29sb3I6IHdoaXRlO1wiPlxuICAgICAgPGRpdiBzdHlsZT1cImZvbnQtc2l6ZTogNDhweDsgbWFyZ2luLWJvdHRvbTogMTJweDtcIj4mIzEyNzkwODs8L2Rpdj5cbiAgICAgIDxkaXYgc3R5bGU9XCJmb250LXNpemU6IDE4cHg7IGZvbnQtd2VpZ2h0OiA3MDA7IG1hcmdpbi1ib3R0b206IDZweDtcIj5BSSBDb21tZW50YXJ5IEFjdGl2ZTwvZGl2PlxuICAgICAgPGRpdiBzdHlsZT1cImZvbnQtc2l6ZTogMTRweDsgY29sb3I6ICM5NGEzYjg7XCI+V2F0Y2ggdGhlIHN5bmNlZCBicm9hZGNhc3QgaW4gdGhlIHNpZGViYXI8L2Rpdj5cbiAgICA8L2Rpdj5cbiAgYDtcbiAgcGxheWVyLmFwcGVuZENoaWxkKG92ZXJsYXlFbCk7XG59XG5cbmZ1bmN0aW9uIGhpZGVPdmVybGF5KCkge1xuICBpZiAob3ZlcmxheUVsKSB7XG4gICAgb3ZlcmxheUVsLnJlbW92ZSgpO1xuICAgIG92ZXJsYXlFbCA9IG51bGw7XG4gIH1cbn1cblxuLy8gLS0tLSBFbnRyeSBwb2ludCAtLS0tXG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbnRlbnRTY3JpcHQoe1xuICBtYXRjaGVzOiBbJyo6Ly8qLnlvdXR1YmUuY29tLyonXSxcbiAgcnVuQXQ6ICdkb2N1bWVudF9pZGxlJyxcbiAgbWFpbigpIHtcbiAgICBjb25zb2xlLmxvZygnW0FJIENvbW1lbnRhdG9yXSBDb250ZW50IHNjcmlwdCBsb2FkZWQgb24gWW91VHViZSBwYWdlJyk7XG5cbiAgICBjaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIoKHBvcnQpID0+IHtcbiAgICAgIGlmIChwb3J0Lm5hbWUgIT09ICdjYXB0dXJlJykgcmV0dXJuO1xuICAgICAgY29uc29sZS5sb2coJ1tBSSBDb21tZW50YXRvcl0gQ2FwdHVyZSBwb3J0IGNvbm5lY3RlZCcpO1xuXG4gICAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobXNnKSA9PiB7XG4gICAgICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgICAgICBjYXNlICdTVEFSVF9DQVBUVVJFJzpcbiAgICAgICAgICAgIHN0YXJ0Q2FwdHVyZShwb3J0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ1NUT1BfQ0FQVFVSRSc6XG4gICAgICAgICAgICBzdG9wQ2FwdHVyZSgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnUEFVU0VfQ0FQVFVSRSc6XG4gICAgICAgICAgICBwYXVzZUNhcHR1cmUoKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ1JFU1VNRV9DQVBUVVJFJzpcbiAgICAgICAgICAgIHJlc3VtZUNhcHR1cmUoKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgICAgICBjb25zb2xlLmxvZygnW0FJIENvbW1lbnRhdG9yXSBDYXB0dXJlIHBvcnQgZGlzY29ubmVjdGVkJyk7XG4gICAgICAgIHN0b3BDYXB0dXJlKCk7XG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIC8vIExlZ2FjeSBtZXNzYWdlLWJhc2VkIHZpZGVvIGNvbnRyb2xcbiAgICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIF9zZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgICAgY29uc3QgdmlkZW8gPSBmaW5kVmlkZW8oKTtcbiAgICAgIGlmICghdmlkZW8pIHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ05vIHZpZGVvIGVsZW1lbnQgZm91bmQnIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHN3aXRjaCAobWVzc2FnZS50eXBlKSB7XG4gICAgICAgIGNhc2UgJ1ZJREVPX1BMQVknOlxuICAgICAgICAgIHZpZGVvLnBsYXkoKTtcbiAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnVklERU9fUEFVU0UnOlxuICAgICAgICAgIHZpZGVvLnBhdXNlKCk7XG4gICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ1ZJREVPX01VVEUnOlxuICAgICAgICAgIHZpZGVvLm11dGVkID0gdHJ1ZTtcbiAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnVklERU9fVU5NVVRFJzpcbiAgICAgICAgICB2aWRlby5tdXRlZCA9IGZhbHNlO1xuICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdWSURFT19TVEFUVVMnOlxuICAgICAgICAgIHNlbmRSZXNwb25zZSh7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIHBhdXNlZDogdmlkZW8ucGF1c2VkLFxuICAgICAgICAgICAgbXV0ZWQ6IHZpZGVvLm11dGVkLFxuICAgICAgICAgICAgY3VycmVudFRpbWU6IHZpZGVvLmN1cnJlbnRUaW1lLFxuICAgICAgICAgICAgZHVyYXRpb246IHZpZGVvLmR1cmF0aW9uLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICdVbmtub3duIG1lc3NhZ2UgdHlwZScgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG59KTtcbiIsIi8vI3JlZ2lvbiBzcmMvdXRpbHMvaW50ZXJuYWwvbG9nZ2VyLnRzXG5mdW5jdGlvbiBwcmludChtZXRob2QsIC4uLmFyZ3MpIHtcblx0aWYgKGltcG9ydC5tZXRhLmVudi5NT0RFID09PSBcInByb2R1Y3Rpb25cIikgcmV0dXJuO1xuXHRpZiAodHlwZW9mIGFyZ3NbMF0gPT09IFwic3RyaW5nXCIpIG1ldGhvZChgW3d4dF0gJHthcmdzLnNoaWZ0KCl9YCwgLi4uYXJncyk7XG5cdGVsc2UgbWV0aG9kKFwiW3d4dF1cIiwgLi4uYXJncyk7XG59XG4vKipcbiogV3JhcHBlciBhcm91bmQgYGNvbnNvbGVgIHdpdGggYSBcIlt3eHRdXCIgcHJlZml4XG4qL1xuY29uc3QgbG9nZ2VyID0ge1xuXHRkZWJ1ZzogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUuZGVidWcsIC4uLmFyZ3MpLFxuXHRsb2c6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmxvZywgLi4uYXJncyksXG5cdHdhcm46ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLndhcm4sIC4uLmFyZ3MpLFxuXHRlcnJvcjogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUuZXJyb3IsIC4uLmFyZ3MpXG59O1xuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGxvZ2dlciB9OyIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb24gQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pXG4qIGBgYFxuKiBAbW9kdWxlIHd4dC9icm93c2VyXG4qL1xuY29uc3QgYnJvd3NlciA9IGJyb3dzZXIkMTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07IiwiaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuXG4vLyNyZWdpb24gc3JjL3V0aWxzL2ludGVybmFsL2N1c3RvbS1ldmVudHMudHNcbnZhciBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50ID0gY2xhc3MgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCBleHRlbmRzIEV2ZW50IHtcblx0c3RhdGljIEVWRU5UX05BTUUgPSBnZXRVbmlxdWVFdmVudE5hbWUoXCJ3eHQ6bG9jYXRpb25jaGFuZ2VcIik7XG5cdGNvbnN0cnVjdG9yKG5ld1VybCwgb2xkVXJsKSB7XG5cdFx0c3VwZXIoV3h0TG9jYXRpb25DaGFuZ2VFdmVudC5FVkVOVF9OQU1FLCB7fSk7XG5cdFx0dGhpcy5uZXdVcmwgPSBuZXdVcmw7XG5cdFx0dGhpcy5vbGRVcmwgPSBvbGRVcmw7XG5cdH1cbn07XG4vKipcbiogUmV0dXJucyBhbiBldmVudCBuYW1lIHVuaXF1ZSB0byB0aGUgZXh0ZW5zaW9uIGFuZCBjb250ZW50IHNjcmlwdCB0aGF0J3MgcnVubmluZy5cbiovXG5mdW5jdGlvbiBnZXRVbmlxdWVFdmVudE5hbWUoZXZlbnROYW1lKSB7XG5cdHJldHVybiBgJHticm93c2VyPy5ydW50aW1lPy5pZH06JHtpbXBvcnQubWV0YS5lbnYuRU5UUllQT0lOVH06JHtldmVudE5hbWV9YDtcbn1cblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50LCBnZXRVbmlxdWVFdmVudE5hbWUgfTsiLCJpbXBvcnQgeyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IH0gZnJvbSBcIi4vY3VzdG9tLWV2ZW50cy5tanNcIjtcblxuLy8jcmVnaW9uIHNyYy91dGlscy9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLnRzXG4vKipcbiogQ3JlYXRlIGEgdXRpbCB0aGF0IHdhdGNoZXMgZm9yIFVSTCBjaGFuZ2VzLCBkaXNwYXRjaGluZyB0aGUgY3VzdG9tIGV2ZW50IHdoZW4gZGV0ZWN0ZWQuIFN0b3BzXG4qIHdhdGNoaW5nIHdoZW4gY29udGVudCBzY3JpcHQgaXMgaW52YWxpZGF0ZWQuXG4qL1xuZnVuY3Rpb24gY3JlYXRlTG9jYXRpb25XYXRjaGVyKGN0eCkge1xuXHRsZXQgaW50ZXJ2YWw7XG5cdGxldCBvbGRVcmw7XG5cdHJldHVybiB7IHJ1bigpIHtcblx0XHRpZiAoaW50ZXJ2YWwgIT0gbnVsbCkgcmV0dXJuO1xuXHRcdG9sZFVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG5cdFx0aW50ZXJ2YWwgPSBjdHguc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0bGV0IG5ld1VybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG5cdFx0XHRpZiAobmV3VXJsLmhyZWYgIT09IG9sZFVybC5ocmVmKSB7XG5cdFx0XHRcdHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50KG5ld1VybCwgb2xkVXJsKSk7XG5cdFx0XHRcdG9sZFVybCA9IG5ld1VybDtcblx0XHRcdH1cblx0XHR9LCAxZTMpO1xuXHR9IH07XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgY3JlYXRlTG9jYXRpb25XYXRjaGVyIH07IiwiaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSBcIi4vaW50ZXJuYWwvbG9nZ2VyLm1qc1wiO1xuaW1wb3J0IHsgZ2V0VW5pcXVlRXZlbnROYW1lIH0gZnJvbSBcIi4vaW50ZXJuYWwvY3VzdG9tLWV2ZW50cy5tanNcIjtcbmltcG9ydCB7IGNyZWF0ZUxvY2F0aW9uV2F0Y2hlciB9IGZyb20gXCIuL2ludGVybmFsL2xvY2F0aW9uLXdhdGNoZXIubWpzXCI7XG5pbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5cbi8vI3JlZ2lvbiBzcmMvdXRpbHMvY29udGVudC1zY3JpcHQtY29udGV4dC50c1xuLyoqXG4qIEltcGxlbWVudHMgW2BBYm9ydENvbnRyb2xsZXJgXShodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvQWJvcnRDb250cm9sbGVyKS5cbiogVXNlZCB0byBkZXRlY3QgYW5kIHN0b3AgY29udGVudCBzY3JpcHQgY29kZSB3aGVuIHRoZSBzY3JpcHQgaXMgaW52YWxpZGF0ZWQuXG4qXG4qIEl0IGFsc28gcHJvdmlkZXMgc2V2ZXJhbCB1dGlsaXRpZXMgbGlrZSBgY3R4LnNldFRpbWVvdXRgIGFuZCBgY3R4LnNldEludGVydmFsYCB0aGF0IHNob3VsZCBiZSB1c2VkIGluXG4qIGNvbnRlbnQgc2NyaXB0cyBpbnN0ZWFkIG9mIGB3aW5kb3cuc2V0VGltZW91dGAgb3IgYHdpbmRvdy5zZXRJbnRlcnZhbGAuXG4qXG4qIFRvIGNyZWF0ZSBjb250ZXh0IGZvciB0ZXN0aW5nLCB5b3UgY2FuIHVzZSB0aGUgY2xhc3MncyBjb25zdHJ1Y3RvcjpcbipcbiogYGBgdHNcbiogaW1wb3J0IHsgQ29udGVudFNjcmlwdENvbnRleHQgfSBmcm9tICd3eHQvdXRpbHMvY29udGVudC1zY3JpcHRzLWNvbnRleHQnO1xuKlxuKiB0ZXN0KFwic3RvcmFnZSBsaXN0ZW5lciBzaG91bGQgYmUgcmVtb3ZlZCB3aGVuIGNvbnRleHQgaXMgaW52YWxpZGF0ZWRcIiwgKCkgPT4ge1xuKiAgIGNvbnN0IGN0eCA9IG5ldyBDb250ZW50U2NyaXB0Q29udGV4dCgndGVzdCcpO1xuKiAgIGNvbnN0IGl0ZW0gPSBzdG9yYWdlLmRlZmluZUl0ZW0oXCJsb2NhbDpjb3VudFwiLCB7IGRlZmF1bHRWYWx1ZTogMCB9KTtcbiogICBjb25zdCB3YXRjaGVyID0gdmkuZm4oKTtcbipcbiogICBjb25zdCB1bndhdGNoID0gaXRlbS53YXRjaCh3YXRjaGVyKTtcbiogICBjdHgub25JbnZhbGlkYXRlZCh1bndhdGNoKTsgLy8gTGlzdGVuIGZvciBpbnZhbGlkYXRlIGhlcmVcbipcbiogICBhd2FpdCBpdGVtLnNldFZhbHVlKDEpO1xuKiAgIGV4cGVjdCh3YXRjaGVyKS50b0JlQ2FsbGVkVGltZXMoMSk7XG4qICAgZXhwZWN0KHdhdGNoZXIpLnRvQmVDYWxsZWRXaXRoKDEsIDApO1xuKlxuKiAgIGN0eC5ub3RpZnlJbnZhbGlkYXRlZCgpOyAvLyBVc2UgdGhpcyBmdW5jdGlvbiB0byBpbnZhbGlkYXRlIHRoZSBjb250ZXh0XG4qICAgYXdhaXQgaXRlbS5zZXRWYWx1ZSgyKTtcbiogICBleHBlY3Qod2F0Y2hlcikudG9CZUNhbGxlZFRpbWVzKDEpO1xuKiB9KTtcbiogYGBgXG4qL1xudmFyIENvbnRlbnRTY3JpcHRDb250ZXh0ID0gY2xhc3MgQ29udGVudFNjcmlwdENvbnRleHQge1xuXHRzdGF0aWMgU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFID0gZ2V0VW5pcXVlRXZlbnROYW1lKFwid3h0OmNvbnRlbnQtc2NyaXB0LXN0YXJ0ZWRcIik7XG5cdGlzVG9wRnJhbWUgPSB3aW5kb3cuc2VsZiA9PT0gd2luZG93LnRvcDtcblx0YWJvcnRDb250cm9sbGVyO1xuXHRsb2NhdGlvbldhdGNoZXIgPSBjcmVhdGVMb2NhdGlvbldhdGNoZXIodGhpcyk7XG5cdHJlY2VpdmVkTWVzc2FnZUlkcyA9IC8qIEBfX1BVUkVfXyAqLyBuZXcgU2V0KCk7XG5cdGNvbnN0cnVjdG9yKGNvbnRlbnRTY3JpcHROYW1lLCBvcHRpb25zKSB7XG5cdFx0dGhpcy5jb250ZW50U2NyaXB0TmFtZSA9IGNvbnRlbnRTY3JpcHROYW1lO1xuXHRcdHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG5cdFx0dGhpcy5hYm9ydENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG5cdFx0aWYgKHRoaXMuaXNUb3BGcmFtZSkge1xuXHRcdFx0dGhpcy5saXN0ZW5Gb3JOZXdlclNjcmlwdHMoeyBpZ25vcmVGaXJzdEV2ZW50OiB0cnVlIH0pO1xuXHRcdFx0dGhpcy5zdG9wT2xkU2NyaXB0cygpO1xuXHRcdH0gZWxzZSB0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cygpO1xuXHR9XG5cdGdldCBzaWduYWwoKSB7XG5cdFx0cmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLnNpZ25hbDtcblx0fVxuXHRhYm9ydChyZWFzb24pIHtcblx0XHRyZXR1cm4gdGhpcy5hYm9ydENvbnRyb2xsZXIuYWJvcnQocmVhc29uKTtcblx0fVxuXHRnZXQgaXNJbnZhbGlkKCkge1xuXHRcdGlmIChicm93c2VyLnJ1bnRpbWU/LmlkID09IG51bGwpIHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcblx0XHRyZXR1cm4gdGhpcy5zaWduYWwuYWJvcnRlZDtcblx0fVxuXHRnZXQgaXNWYWxpZCgpIHtcblx0XHRyZXR1cm4gIXRoaXMuaXNJbnZhbGlkO1xuXHR9XG5cdC8qKlxuXHQqIEFkZCBhIGxpc3RlbmVyIHRoYXQgaXMgY2FsbGVkIHdoZW4gdGhlIGNvbnRlbnQgc2NyaXB0J3MgY29udGV4dCBpcyBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIEByZXR1cm5zIEEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cblx0KlxuXHQqIEBleGFtcGxlXG5cdCogYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihjYik7XG5cdCogY29uc3QgcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lciA9IGN0eC5vbkludmFsaWRhdGVkKCgpID0+IHtcblx0KiAgIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIoY2IpO1xuXHQqIH0pXG5cdCogLy8gLi4uXG5cdCogcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lcigpO1xuXHQqL1xuXHRvbkludmFsaWRhdGVkKGNiKSB7XG5cdFx0dGhpcy5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcblx0XHRyZXR1cm4gKCkgPT4gdGhpcy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcblx0fVxuXHQvKipcblx0KiBSZXR1cm4gYSBwcm9taXNlIHRoYXQgbmV2ZXIgcmVzb2x2ZXMuIFVzZWZ1bCBpZiB5b3UgaGF2ZSBhbiBhc3luYyBmdW5jdGlvbiB0aGF0IHNob3VsZG4ndCBydW5cblx0KiBhZnRlciB0aGUgY29udGV4dCBpcyBleHBpcmVkLlxuXHQqXG5cdCogQGV4YW1wbGVcblx0KiBjb25zdCBnZXRWYWx1ZUZyb21TdG9yYWdlID0gYXN5bmMgKCkgPT4ge1xuXHQqICAgaWYgKGN0eC5pc0ludmFsaWQpIHJldHVybiBjdHguYmxvY2soKTtcblx0KlxuXHQqICAgLy8gLi4uXG5cdCogfVxuXHQqL1xuXHRibG9jaygpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKCkgPT4ge30pO1xuXHR9XG5cdC8qKlxuXHQqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0SW50ZXJ2YWxgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBJbnRlcnZhbHMgY2FuIGJlIGNsZWFyZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjbGVhckludGVydmFsYCBmdW5jdGlvbi5cblx0Ki9cblx0c2V0SW50ZXJ2YWwoaGFuZGxlciwgdGltZW91dCkge1xuXHRcdGNvbnN0IGlkID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuXHRcdH0sIHRpbWVvdXQpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhckludGVydmFsKGlkKSk7XG5cdFx0cmV0dXJuIGlkO1xuXHR9XG5cdC8qKlxuXHQqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0VGltZW91dGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWwgd2hlbiBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIFRpbWVvdXRzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgc2V0VGltZW91dGAgZnVuY3Rpb24uXG5cdCovXG5cdHNldFRpbWVvdXQoaGFuZGxlciwgdGltZW91dCkge1xuXHRcdGNvbnN0IGlkID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRpZiAodGhpcy5pc1ZhbGlkKSBoYW5kbGVyKCk7XG5cdFx0fSwgdGltZW91dCk7XG5cdFx0dGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNsZWFyVGltZW91dChpZCkpO1xuXHRcdHJldHVybiBpZDtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnJlcXVlc3RBbmltYXRpb25GcmFtZWAgdGhhdCBhdXRvbWF0aWNhbGx5IGNhbmNlbHMgdGhlIHJlcXVlc3Qgd2hlblxuXHQqIGludmFsaWRhdGVkLlxuXHQqXG5cdCogQ2FsbGJhY2tzIGNhbiBiZSBjYW5jZWxlZCBieSBjYWxsaW5nIHRoZSBub3JtYWwgYGNhbmNlbEFuaW1hdGlvbkZyYW1lYCBmdW5jdGlvbi5cblx0Ki9cblx0cmVxdWVzdEFuaW1hdGlvbkZyYW1lKGNhbGxiYWNrKSB7XG5cdFx0Y29uc3QgaWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKC4uLmFyZ3MpID0+IHtcblx0XHRcdGlmICh0aGlzLmlzVmFsaWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuXHRcdH0pO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxBbmltYXRpb25GcmFtZShpZCkpO1xuXHRcdHJldHVybiBpZDtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnJlcXVlc3RJZGxlQ2FsbGJhY2tgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cblx0KiBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxJZGxlQ2FsbGJhY2tgIGZ1bmN0aW9uLlxuXHQqL1xuXHRyZXF1ZXN0SWRsZUNhbGxiYWNrKGNhbGxiYWNrLCBvcHRpb25zKSB7XG5cdFx0Y29uc3QgaWQgPSByZXF1ZXN0SWRsZUNhbGxiYWNrKCguLi5hcmdzKSA9PiB7XG5cdFx0XHRpZiAoIXRoaXMuc2lnbmFsLmFib3J0ZWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuXHRcdH0sIG9wdGlvbnMpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxJZGxlQ2FsbGJhY2soaWQpKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cblx0YWRkRXZlbnRMaXN0ZW5lcih0YXJnZXQsIHR5cGUsIGhhbmRsZXIsIG9wdGlvbnMpIHtcblx0XHRpZiAodHlwZSA9PT0gXCJ3eHQ6bG9jYXRpb25jaGFuZ2VcIikge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgdGhpcy5sb2NhdGlvbldhdGNoZXIucnVuKCk7XG5cdFx0fVxuXHRcdHRhcmdldC5hZGRFdmVudExpc3RlbmVyPy4odHlwZS5zdGFydHNXaXRoKFwid3h0OlwiKSA/IGdldFVuaXF1ZUV2ZW50TmFtZSh0eXBlKSA6IHR5cGUsIGhhbmRsZXIsIHtcblx0XHRcdC4uLm9wdGlvbnMsXG5cdFx0XHRzaWduYWw6IHRoaXMuc2lnbmFsXG5cdFx0fSk7XG5cdH1cblx0LyoqXG5cdCogQGludGVybmFsXG5cdCogQWJvcnQgdGhlIGFib3J0IGNvbnRyb2xsZXIgYW5kIGV4ZWN1dGUgYWxsIGBvbkludmFsaWRhdGVkYCBsaXN0ZW5lcnMuXG5cdCovXG5cdG5vdGlmeUludmFsaWRhdGVkKCkge1xuXHRcdHRoaXMuYWJvcnQoXCJDb250ZW50IHNjcmlwdCBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xuXHRcdGxvZ2dlci5kZWJ1ZyhgQ29udGVudCBzY3JpcHQgXCIke3RoaXMuY29udGVudFNjcmlwdE5hbWV9XCIgY29udGV4dCBpbnZhbGlkYXRlZGApO1xuXHR9XG5cdHN0b3BPbGRTY3JpcHRzKCkge1xuXHRcdHdpbmRvdy5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUsXG5cdFx0XHRjb250ZW50U2NyaXB0TmFtZTogdGhpcy5jb250ZW50U2NyaXB0TmFtZSxcblx0XHRcdG1lc3NhZ2VJZDogTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMilcblx0XHR9LCBcIipcIik7XG5cdH1cblx0dmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSB7XG5cdFx0Y29uc3QgaXNTY3JpcHRTdGFydGVkRXZlbnQgPSBldmVudC5kYXRhPy50eXBlID09PSBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEU7XG5cdFx0Y29uc3QgaXNTYW1lQ29udGVudFNjcmlwdCA9IGV2ZW50LmRhdGE/LmNvbnRlbnRTY3JpcHROYW1lID09PSB0aGlzLmNvbnRlbnRTY3JpcHROYW1lO1xuXHRcdGNvbnN0IGlzTm90RHVwbGljYXRlID0gIXRoaXMucmVjZWl2ZWRNZXNzYWdlSWRzLmhhcyhldmVudC5kYXRhPy5tZXNzYWdlSWQpO1xuXHRcdHJldHVybiBpc1NjcmlwdFN0YXJ0ZWRFdmVudCAmJiBpc1NhbWVDb250ZW50U2NyaXB0ICYmIGlzTm90RHVwbGljYXRlO1xuXHR9XG5cdGxpc3RlbkZvck5ld2VyU2NyaXB0cyhvcHRpb25zKSB7XG5cdFx0bGV0IGlzRmlyc3QgPSB0cnVlO1xuXHRcdGNvbnN0IGNiID0gKGV2ZW50KSA9PiB7XG5cdFx0XHRpZiAodGhpcy52ZXJpZnlTY3JpcHRTdGFydGVkRXZlbnQoZXZlbnQpKSB7XG5cdFx0XHRcdHRoaXMucmVjZWl2ZWRNZXNzYWdlSWRzLmFkZChldmVudC5kYXRhLm1lc3NhZ2VJZCk7XG5cdFx0XHRcdGNvbnN0IHdhc0ZpcnN0ID0gaXNGaXJzdDtcblx0XHRcdFx0aXNGaXJzdCA9IGZhbHNlO1xuXHRcdFx0XHRpZiAod2FzRmlyc3QgJiYgb3B0aW9ucz8uaWdub3JlRmlyc3RFdmVudCkgcmV0dXJuO1xuXHRcdFx0XHR0aGlzLm5vdGlmeUludmFsaWRhdGVkKCk7XG5cdFx0XHR9XG5cdFx0fTtcblx0XHRhZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYik7XG5cdFx0dGhpcy5vbkludmFsaWRhdGVkKCgpID0+IHJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIGNiKSk7XG5cdH1cbn07XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgQ29udGVudFNjcmlwdENvbnRleHQgfTsiXSwibmFtZXMiOlsiZGVmaW5pdGlvbiIsInByaW50IiwibG9nZ2VyIiwiYnJvd3NlciIsIld4dExvY2F0aW9uQ2hhbmdlRXZlbnQiLCJDb250ZW50U2NyaXB0Q29udGV4dCJdLCJtYXBwaW5ncyI6Ijs7QUFDQSxXQUFTLG9CQUFvQkEsYUFBWTtBQUN4QyxXQUFPQTtBQUFBLEVBQ1I7QUNVQSxRQUFBLGNBQUE7QUFDQSxRQUFBLGVBQUE7QUFDQSxRQUFBLFlBQUE7QUFFQSxNQUFBLGtCQUFBO0FBQ0EsTUFBQSxjQUFBO0FBQ0EsTUFBQSxnQkFBQTtBQUNBLE1BQUEsYUFBQTtBQUNBLE1BQUEsWUFBQTtBQUNBLE1BQUEsV0FBQTtBQUVBLFdBQUEsWUFBQTtBQUNFLFdBQUEsU0FBQSxjQUFBLE9BQUE7QUFBQSxFQUNGO0FBSUEsV0FBQSxhQUFBLE1BQUE7QUFDRSxVQUFBLFFBQUEsVUFBQTtBQUNBLFFBQUEsQ0FBQSxPQUFBO0FBQ0UsV0FBQSxZQUFBLEVBQUEsTUFBQSxTQUFBLFNBQUEsMEJBQUE7QUFDQTtBQUFBLElBQUE7QUFHRixrQkFBQTtBQUdB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QyxLQUFLLE9BQU8sUUFBUyxVQUFTLEdBQUcsSUFBSTtBQUFBLE1BQzNDLEdBQUcsT0FBTztBQUNWLFdBQUssY0FBYyxNQUFNLG1CQUFtQixFQUFFLENBQUM7QUFDL0MsYUFBTztBQUFBLElBQ1I7QUFBQSxJQUNBLGlCQUFpQixRQUFRLE1BQU0sU0FBUyxTQUFTO0FBQ2hELFVBQUksU0FBUyxzQkFBc0I7QUFDbEMsWUFBSSxLQUFLLFFBQVMsTUFBSyxnQkFBZ0IsSUFBRztBQUFBLE1BQzNDO0FBQ0EsYUFBTyxtQkFBbUIsS0FBSyxXQUFXLE1BQU0sSUFBSSxtQkFBbUIsSUFBSSxJQUFJLE1BQU0sU0FBUztBQUFBLFFBQzdGLEdBQUc7QUFBQSxRQUNILFFBQVEsS0FBSztBQUFBLE1BQ2hCLENBQUc7QUFBQSxJQUNGO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtBLG9CQUFvQjtBQUNuQixXQUFLLE1BQU0sb0NBQW9DO0FBQy9DSCxlQUFPLE1BQU0sbUJBQW1CLEtBQUssaUJBQWlCLHVCQUF1QjtBQUFBLElBQzlFO0FBQUEsSUFDQSxpQkFBaUI7QUFDaEIsYUFBTyxZQUFZO0FBQUEsUUFDbEIsTUFBTUcsc0JBQXFCO0FBQUEsUUFDM0IsbUJBQW1CLEtBQUs7QUFBQSxRQUN4QixXQUFXLEtBQUssT0FBTSxFQUFHLFNBQVMsRUFBRSxFQUFFLE1BQU0sQ0FBQztBQUFBLE1BQ2hELEdBQUssR0FBRztBQUFBLElBQ1A7QUFBQSxJQUNBLHlCQUF5QixPQUFPO0FBQy9CLFlBQU0sdUJBQXVCLE1BQU0sTUFBTSxTQUFTQSxzQkFBcUI7QUFDdkUsWUFBTSxzQkFBc0IsTUFBTSxNQUFNLHNCQUFzQixLQUFLO0FBQ25FLFlBQU0saUJBQWlCLENBQUMsS0FBSyxtQkFBbUIsSUFBSSxNQUFNLE1BQU0sU0FBUztBQUN6RSxhQUFPLHdCQUF3Qix1QkFBdUI7QUFBQSxJQUN2RDtBQUFBLElBQ0Esc0JBQXNCLFNBQVM7QUFDOUIsVUFBSSxVQUFVO0FBQ2QsWUFBTSxLQUFLLENBQUMsVUFBVTtBQUNyQixZQUFJLEtBQUsseUJBQXlCLEtBQUssR0FBRztBQUN6QyxlQUFLLG1CQUFtQixJQUFJLE1BQU0sS0FBSyxTQUFTO0FBQ2hELGdCQUFNLFdBQVc7QUFDakIsb0JBQVU7QUFDVixjQUFJLFlBQVksU0FBUyxpQkFBa0I7QUFDM0MsZUFBSyxrQkFBaUI7QUFBQSxRQUN2QjtBQUFBLE1BQ0Q7QUFDQSx1QkFBaUIsV0FBVyxFQUFFO0FBQzlCLFdBQUssY0FBYyxNQUFNLG9CQUFvQixXQUFXLEVBQUUsQ0FBQztBQUFBLElBQzVEO0FBQUEsRUFDRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OzsiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMCwyLDMsNCw1LDYsN119
content;