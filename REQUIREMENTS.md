# easyLang v1 Requirements Document

## Overview
A Firefox browser extension that translates visible web page text into JLPT N5-level Japanese with furigana, using a user-configurable OpenAI-compliant LLM endpoint.

---

## 1. Functional Requirements

### FR-1: Toggle Translation On/Off
- **FR-1.1**: The extension shall provide a toolbar popup with a toggle switch.
- **FR-1.2**: When toggled ON, the extension shall translate all visible text on the active page into JLPT N5 Japanese.
- **FR-1.3**: When toggled OFF, the extension shall restore the original page text exactly as it was before translation.
- **FR-1.4**: The popup shall display the current translation state (ON / OFF) for the active tab.

### FR-2: Text Extraction & Scope
- **FR-2.1**: The extension shall extract visible text nodes from the active page’s DOM.
- **FR-2.2**: The extension shall skip the following elements and their descendants:
  - `<script>`, `<style>`, `<noscript>`, `<iframe>`, `<code>`, `<pre>`, `<textarea>`, `<input>`, `<canvas>`, `<svg>`, `<ruby>`, `<rt>`, `<rp>`
- **FR-2.3**: The extension shall skip empty or whitespace-only text nodes.
- **FR-2.4**: The extension shall skip text already inside a translation wrapper to avoid double-translation.

### FR-3: Batch Translation via LLM
- **FR-3.1**: The extension shall group extracted text nodes into batches (max ~3,000 characters or 20 nodes per batch).
- **FR-3.2**: The extension shall send each batch to a background script that calls a configurable LLM API.
- **FR-3.3**: The API request shall use an OpenAI-compliant chat completions endpoint.
- **FR-3.4**: The prompt shall instruct the LLM to:
  - Translate each segment into JLPT N5-level Japanese
  - If text is already Japanese, rewrite it to N5 level
  - Add furigana to **all kanji** using HTML `<ruby>` tags (e.g., `<ruby>漢字<rt>かんじ</rt></ruby>`)
  - Return results **only** as a JSON array of strings, preserving input order
- **FR-3.5**: The extension shall parse the LLM response, validate array length matches input count, and apply translations.

### FR-4: Inline Replacement
- **FR-4.1**: Each translated text node shall replace its original text inline in the DOM.
- **FR-4.2**: The original text shall be stored in a `data` attribute on the wrapper element for restoration.
- **FR-4.3**: Translated content shall be injected as HTML (to render `<ruby>` tags), wrapped in a `<span class="easylang-translated">`.

### FR-5: Error Handling
- **FR-5.1**: If the API call fails (network error, HTTP error, or timeout), the extension shall display a fixed-position toast on the page.
- **FR-5.2**: The toast shall auto-dismiss after 6 seconds.
- **FR-5.3**: Each batch shall be retried up to a bounded number of attempts (default 3) on transient errors or response length mismatches, with a short backoff. Retries shall never be unbounded.
- **FR-5.4**: Translation shall be resilient and partial: batches that succeed are applied; a batch that still fails after its retries is skipped (its segments remain in the original language) and processing continues. A skipped-section count shall be surfaced via an informational toast.
- **FR-5.5**: If failures are systemic (default: 3 consecutive failed batches), the pass shall stop early while keeping any already-translated content.
- **FR-5.6**: If API settings (endpoint or key) are missing, nothing is translated, the page is left in its original state, and the toast shall direct the user to the Settings page.
- **FR-5.7**: Pure non-letter segments (numbers, punctuation, symbols, whitespace) shall be excluded from translation requests.

### FR-6: Settings / Configuration
- **FR-6.1**: The extension shall provide an Options page accessible from the popup.
- **FR-6.2**: The user shall configure:
  - API Endpoint URL (string, required)
  - API Key (string, required, masked)
  - Model Name (string, optional, default: `deepseek-ai/deepseek-v4-flash`)
  - Temperature (number, 0–2, step 0.1, default: 0.2)
  - Request Timeout in seconds (number, 5–180, step 5, default: 60)
- **FR-6.3**: Settings shall persist in `browser.storage.local`.
- **FR-6.4**: The Options page shall pre-fill saved values on load.

---

## 2. Non-Functional Requirements

### NFR-1: Browser Compatibility
- **NFR-1.1**: The extension shall target Firefox Manifest V3.
- **NFR-1.2**: The extension shall use the `browser.*` namespace (WebExtension API) for Firefox compatibility.

### NFR-2: Performance
- **NFR-2.1**: Text extraction shall use `TreeWalker` for efficient DOM traversal.
- **NFR-2.2**: Large pages shall be processed in sequential batches to avoid oversized API payloads.
- **NFR-2.3**: Translation state shall be per-tab (content script scoped).

### NFR-3: Security
- **NFR-3.1**: The API key shall be stored only in `browser.storage.local` (not hardcoded).
- **NFR-3.2**: Content script shall not execute untrusted scripts from LLM responses (innerHTML is acceptable only for `<ruby>` tags from a trusted LLM output).

### NFR-4: UX
- **NFR-4.1**: Popup UI shall be clean, minimal, and responsive (260px width).
- **NFR-4.2**: Toggle switch shall provide immediate visual feedback (color change + status text).
- **NFR-4.3**: Settings page shall be a full tab for comfortable form entry.

---

## 3. Out of Scope (Future Versions)
- Sidebar glossary panel
- Hover-to-see-original text
- SPA / dynamic content mutation observer
- Per-site allow/block lists
- Caching translations to reduce API calls
- Furigana toggle (show/hide)
- JLPT N4–N1 level selection
