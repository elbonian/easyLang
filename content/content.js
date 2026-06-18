/* easyLang content script
 * Extracts visible text, batches it to the background for translation,
 * replaces it inline, and restores the original page on demand.
 * Per-tab state lives here.
 */

(() => {
  // Avoid double-injection on the same document.
  if (window.__easyLangInjected) return;
  window.__easyLangInjected = true;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "CODE", "PRE",
    "TEXTAREA", "INPUT", "CANVAS", "SVG", "RUBY", "RT", "RP"
  ]);

  const WRAPPER_CLASS = "easylang-translated";
  const MAX_BATCH_CHARS = 3000;
  const MAX_BATCH_NODES = 8;           // keep local model requests under Firefox's ~30s message timeout
  const MAX_BATCH_ATTEMPTS = 3;        // initial try + bounded retries per batch
  const RETRY_BACKOFF_MS = 500;        // pause between batch retries
  const MAX_CONSECUTIVE_FAILURES = 3;  // give up early if failures are systemic

  // Text worth translating must contain at least one letter (any script).
  // Pure numbers / punctuation / symbols are skipped: they push the model to
  // merge or drop array items, and aren't useful to a learner anyway.
  const HAS_LETTER = /\p{L}/u;

  const state = {
    active: false,        // translation currently applied
    translating: false,   // a translation pass is in flight
    cancelRequested: false // user toggled off mid-pass
  };

  /** Records of applied translations for exact restoration. */
  const applied = []; // { wrapper: HTMLSpanElement, originalNode: Text }

  // ---- Text extraction -----------------------------------------------------

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") {
      try {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      } catch (_) { /* fall through */ }
    }
    const style = window.getComputedStyle(el);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function shouldSkipNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (!node.nodeValue || !node.nodeValue.trim()) return true;
    if (!HAS_LETTER.test(node.nodeValue)) return true;

    let el = parent;
    while (el && el !== document.documentElement) {
      const tag = el.tagName ? el.tagName.toUpperCase() : "";
      if (SKIP_TAGS.has(tag)) return true;
      if (el.classList && el.classList.contains(WRAPPER_CLASS)) return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }

    if (!isElementVisible(parent)) return true;
    return false;
  }

  function collectTextNodes() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return shouldSkipNode(node)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current);
      current = walker.nextNode();
    }
    return nodes;
  }

  /** Group nodes into batches limited by char count and node count. */
  function buildBatches(nodes) {
    const batches = [];
    let batch = [];
    let chars = 0;

    for (const node of nodes) {
      const len = node.nodeValue.length;
      if (batch.length > 0 && (batch.length >= MAX_BATCH_NODES || chars + len > MAX_BATCH_CHARS)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(node);
      chars += len;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
  }

  // ---- DOM replacement & restoration --------------------------------------

  function applyTranslation(node, translatedHtml) {
    const parent = node.parentNode;
    if (!parent) return;

    const wrapper = document.createElement("span");
    wrapper.className = WRAPPER_CLASS;
    wrapper.dataset.easylangOriginal = node.nodeValue;
    // Trusted, constrained LLM output (ruby furigana markup). See NFR-3.2.
    wrapper.innerHTML = translatedHtml;

    parent.replaceChild(wrapper, node);
    applied.push({ wrapper, originalNode: node });
  }

  function restoreAll() {
    while (applied.length > 0) {
      const { wrapper, originalNode } = applied.pop();
      const parent = wrapper.parentNode;
      if (parent) parent.replaceChild(originalNode, wrapper);
    }
  }

  // ---- UI: loading indicator & error toast --------------------------------

  let loadingEl = null;

  function showLoading(done, total) {
    if (!loadingEl) {
      loadingEl = document.createElement("div");
      loadingEl.className = "easylang-loading";
      (document.body || document.documentElement).appendChild(loadingEl);
    }
    loadingEl.textContent = `easyLang: 翻訳中… ${done}/${total}`;
  }

  function hideLoading() {
    if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
    loadingEl = null;
  }

  function showError(message, withSettingsLink, severity) {
    const toast = document.createElement("div");
    toast.className = severity === "info"
      ? "easylang-toast easylang-toast--info"
      : "easylang-toast";

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    if (withSettingsLink) {
      const link = document.createElement("button");
      link.className = "easylang-toast-link";
      link.textContent = "Open Settings";
      link.addEventListener("click", () => {
        sendToBackground({ type: "openOptions" }).catch(() => {});
      });
      toast.appendChild(link);
    }

    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 6000);
  }

  // ---- Translation orchestration ------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const TRANSIENT_MESSAGE_ERROR =
    /Receiving end does not exist|Could not establish connection|message port closed|disconnected/i;

  /**
   * Send a message to the background, retrying transient errors. Firefox MV3
   * event pages are suspended when idle; the first send wakes the page and a
   * short retry then reaches the freshly-registered listener.
   */
  async function sendToBackground(message, attempts = 5) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await browser.runtime.sendMessage(message);
      } catch (err) {
        lastError = err;
        const text = String((err && err.message) || err);
        if (TRANSIENT_MESSAGE_ERROR.test(text)) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Request one batch with bounded retries. Retries transient failures and
   * length mismatches a few times, then returns the last failing response so
   * the caller can skip the batch. Never loops forever.
   */
  async function requestBatchWithRetry(segments) {
    let response;
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
      try {
        response = await sendToBackground({ type: "translateBatch", segments });
      } catch (err) {
        response = { ok: false, code: "NETWORK_ERROR", error: String(err?.message || err) };
      }

      const ok =
        response && response.ok &&
        Array.isArray(response.translations) &&
        response.translations.length === segments.length;
      if (ok) return response;

      // Missing settings or a user cancel are not worth retrying.
      if ((response && response.code === "NO_SETTINGS") || state.cancelRequested) {
        return response;
      }
      if (attempt < MAX_BATCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
    }
    return response;
  }

  async function translatePage() {
    if (state.translating || state.active) return;

    state.translating = true;
    state.cancelRequested = false;

    const nodes = collectTextNodes();
    if (nodes.length === 0) {
      state.translating = false;
      return;
    }

    const batches = buildBatches(nodes);
    showLoading(0, batches.length);

    let skipped = 0;
    let consecutiveFailures = 0;
    let fatal = null;        // NO_SETTINGS or systemic early-stop
    let lastError = "";

    for (let i = 0; i < batches.length; i++) {
      if (state.cancelRequested) break;

      const batch = batches[i];
      const segments = batch.map((n) => n.nodeValue);
      const response = await requestBatchWithRetry(segments);

      if (state.cancelRequested) break;

      const succeeded =
        response && response.ok &&
        Array.isArray(response.translations) &&
        response.translations.length === batch.length;

      if (succeeded) {
        for (let j = 0; j < batch.length; j++) {
          applyTranslation(batch[j], response.translations[j]);
        }
        consecutiveFailures = 0;
        showLoading(i + 1, batches.length);
        continue;
      }

      lastError = (response && response.error) || "Translation failed.";

      // Missing settings won't fix themselves — stop the pass.
      if (response && response.code === "NO_SETTINGS") {
        fatal = { code: "NO_SETTINGS", error: lastError };
        break;
      }

      // Keep-partial: leave this batch in its original text and move on.
      skipped += 1;
      consecutiveFailures += 1;
      showLoading(i + 1, batches.length);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        fatal = { code: "STOPPED_EARLY", error: lastError };
        break;
      }
    }

    hideLoading();
    state.translating = false;

    if (state.cancelRequested) {
      restoreAll();
      state.active = false;
      state.cancelRequested = false;
      return;
    }

    // Settings missing and nothing was translated: revert and point to Settings.
    if (fatal && fatal.code === "NO_SETTINGS") {
      restoreAll();
      state.active = false;
      showError(fatal.error, true);
      return;
    }

    // Keep whatever we managed to translate; the page stays "active".
    state.active = applied.length > 0;

    if (fatal && fatal.code === "STOPPED_EARLY" && applied.length === 0) {
      showError(lastError || "Translation failed.", false);
    } else if (fatal && fatal.code === "STOPPED_EARLY") {
      showError(
        `Stopped after repeated errors; kept ${applied.length} translated section${applied.length === 1 ? "" : "s"}.`,
        false,
        "info"
      );
    } else if (skipped > 0) {
      showError(
        `Translated the page; skipped ${skipped} section${skipped === 1 ? "" : "s"} that wouldn't translate cleanly.`,
        false,
        "info"
      );
    }
  }

  function deactivate() {
    if (state.translating) {
      state.cancelRequested = true;
      return;
    }
    restoreAll();
    hideLoading();
    state.active = false;
  }

  async function setActive(active) {
    if (active) {
      await translatePage();
    } else {
      deactivate();
    }
  }

  // ---- Messaging from popup ------------------------------------------------

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "getState") {
      return Promise.resolve({
        ok: true,
        supported: true,
        active: state.active,
        translating: state.translating
      });
    }

    if (message.type === "setState") {
      // Resolve immediately so the popup UI stays responsive; the pass
      // continues in the background.
      setActive(Boolean(message.active));
      return Promise.resolve({ ok: true, active: Boolean(message.active) });
    }
  });
})();
