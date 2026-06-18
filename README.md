# easyLang

A Firefox (Manifest V3) browser extension that translates the visible text of any web page into **JLPT N5-level Japanese with furigana**, using a user-configurable OpenAI-compliant LLM endpoint.

## Features

- One-click toggle from the toolbar popup to translate / restore the active page.
- Visible text extraction via `TreeWalker`, skipping code, inputs, SVG, existing ruby, etc.
- Sequential batch translation (max ~3,000 chars or 20 nodes per request) to a configurable chat-completions API.
- Furigana rendered with HTML `<ruby>` tags.
- Exact restore of the original page when toggled off.
- On-page loading indicator and auto-dismissing error toast.
- Settings page for endpoint, API key (masked), model, temperature, and request timeout.

## Project structure

```
easyLang/
├── manifest.json          # MV3 manifest (Firefox / browser.* namespace)
├── background/background.js# LLM API calls, JSON parsing/validation, configurable timeout
├── content/content.js      # Extraction, batching, replacement, restore, per-tab state
├── content/content.css     # Styles for translated spans, loading badge, error toast
├── popup/                  # Toolbar popup (toggle + status + settings link)
├── options/                # Full-tab settings page
└── icons/icon.svg          # Extension / toolbar icon
```

## Install (temporary, for development)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file in this folder.
4. The easyLang icon appears in the toolbar.

> Temporary add-ons are removed when Firefox restarts. For a persistent install, package and sign the extension via [AMO](https://addons.mozilla.org/).

## Configure

1. Click the easyLang toolbar icon, then **Settings** (or open the add-on's options).
2. Fill in:
   - **API Endpoint URL** (required) — full chat-completions URL.
   - **API Key** (required) — sent as a `Bearer` token; stored only in `browser.storage.local`.
   - **Model Name** (optional) — defaults to `deepseek-ai/deepseek-v4-flash`.
   - **Temperature** (optional) — `0`–`2`, default `0.2`.
   - **Request Timeout** (optional) — seconds to wait per API call, `5`–`180`, default `60`. Increase if free endpoints time out.
3. Click **Save**.

## Usage

1. Open any regular `http(s)` web page.
2. Click the toolbar icon and flip the **Translate page** switch ON.
3. The page text is replaced with JLPT N5 Japanese (with furigana). Flip OFF to restore.

## Notes & limitations

- API requests time out after a configurable interval (**default 60s**, set in Settings). Each batch is retried a few times on transient errors or length mismatches; batches that still fail are skipped (left in the original language) so the rest of the page stays translated. A blocking failure (e.g. missing settings) shows an error toast.
- Translation runs once over the current DOM. Dynamically loaded / SPA content added after toggling is **not** re-translated (out of scope for v1).
- The API key is never hardcoded; it lives in `browser.storage.local`.
- Translated HTML is injected only to render trusted `<ruby>` furigana markup from the model output.

## Security

- Requires `<all_urls>` host permission so the background script can call your chosen API endpoint and content scripts can run on the pages you translate.
- No data is sent anywhere except the endpoint you configure.
