/* easyLang background script
 * Handles OpenAI-compliant batch translation requests and options page opening.
 */

const DEFAULTS = {
  endpoint: "",
  apiKey: "",
  model: "deepseek-ai/deepseek-v4-flash",
  temperature: 0.2,
  timeout: 60
};

const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 180;

const SYSTEM_PROMPT = [
  "You are a translation engine that rewrites text into very simple Japanese at the JLPT N5 level.",
  "You will receive a JSON array of strings. Each string is one text segment from a web page.",
  "For EACH input string, produce one output string following these rules:",
  "1. Translate the meaning into natural JLPT N5-level Japanese.",
  "2. If the input is already Japanese, rewrite it into JLPT N5-level Japanese.",
  "3. Furigana is MANDATORY: wrap EVERY kanji in HTML ruby tags with its hiragana reading, e.g. <ruby>漢字<rt>かんじ</rt></ruby>.",
  "4. This applies to ALL kanji without exception, including common words such as 私(わたし), 続(つづ)ける, 今日(きょう), 天気(てんき), 店(みせ).",
  "5. Never leave any kanji outside a <ruby> tag. Put ONLY the kana reading inside <rt>; kana and punctuation that follow a kanji stay OUTSIDE the <ruby> tag.",
  "6. Keep the segment count and order identical to the input.",
  "7. Do not add explanations, numbering, or extra punctuation that was not implied by the source.",
  "Return ONLY a JSON array of strings, the same length as the input array, in the same order.",
  "Do not wrap the JSON in markdown fences or any other text.",
  "Example input:",
  '["Welcome to our store.","今日は良い天気です。"]',
  "Example output:",
  '["<ruby>私<rt>わたし</rt></ruby>たちの<ruby>店<rt>みせ</rt></ruby>へようこそ。","<ruby>今日<rt>きょう</rt></ruby>は<ruby>良<rt>よ</rt></ruby>い<ruby>天気<rt>てんき</rt></ruby>です。"]'
].join("\n");

/** Read and normalize settings from storage. */
async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULTS);
  return {
    endpoint: (stored.endpoint || "").trim(),
    apiKey: (stored.apiKey || "").trim(),
    model: (stored.model || DEFAULTS.model).trim() || DEFAULTS.model,
    temperature: clampTemperature(stored.temperature),
    timeout: clampTimeout(stored.timeout)
  };
}

function clampTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.temperature;
  return Math.min(2, Math.max(0, n));
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.timeout;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(n)));
}

/** Extract a JSON array of strings from raw model output. */
function parseTranslationArray(raw) {
  if (typeof raw !== "string") {
    throw new Error("Empty response from model.");
  }
  let text = raw.trim();

  // Strip markdown code fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  }

  // Fall back to the first bracketed array if extra prose surrounds it.
  let candidate = text;
  if (!candidate.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      candidate = text.slice(start, end + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error("Model did not return valid JSON.");
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Model response was not a JSON array of strings.");
  }
  return parsed;
}

/** Call the configured LLM endpoint for one batch of segments. */
async function translateBatch(segments) {
  const settings = await getSettings();

  if (!settings.endpoint || !settings.apiKey) {
    return {
      ok: false,
      code: "NO_SETTINGS",
      error: "API endpoint or key is not set. Open Settings to configure easyLang."
    };
  }

  const body = {
    model: settings.model,
    temperature: settings.temperature,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(segments) }
    ]
  };

  const timeoutMs = settings.timeout * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        code: "HTTP_ERROR",
        error: `API request failed (HTTP ${res.status}). ${truncate(detail, 200)}`.trim()
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const translations = parseTranslationArray(content);

    if (translations.length !== segments.length) {
      return {
        ok: false,
        code: "LENGTH_MISMATCH",
        error: `Expected ${segments.length} translations but received ${translations.length}.`
      };
    }

    return { ok: true, translations };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
      error: aborted
        ? `The translation request timed out after ${settings.timeout}s. Try increasing the timeout in Settings.`
        : `Could not reach the API endpoint. ${err?.message || ""}`.trim()
    };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(str, max) {
  if (typeof str !== "string") return "";
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "translateBatch") {
    return translateBatch(Array.isArray(message.segments) ? message.segments : []);
  }

  if (message.type === "openOptions") {
    return browser.runtime.openOptionsPage().then(() => ({ ok: true }));
  }
});
