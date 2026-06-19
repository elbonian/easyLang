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

const JOBS_PREFIX = "easylangJob:";
const JOB_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const SYSTEM_PROMPT = [
  "You rewrite web page text into very simple Japanese at the JLPT N5 level, for beginner learners.",
  "You receive a JSON array of strings. Each string is one text segment from a web page.",
  "Return exactly one output string per input string, in the same order.",
  "",
  "PRIORITY: simplicity over sophistication.",
  "- Your goal is the simplest correct Japanese, NOT the most precise or natural adult phrasing.",
  "- You MAY lose nuance to stay simple. A beginner getting the gist beats a polished sentence they cannot read.",
  "- But never change the core meaning, and never drop or flip a negation. 'will not release' must stay negative.",
  "",
  "VOCABULARY (the main thing to get right):",
  "- Use only common everyday words a first-year learner would know.",
  "- When a simpler everyday word exists, ALWAYS use it, even if a more formal or precise word fits better. Make substitutions like:",
  "    安価な→安い, 携帯電話→スマホ, 後継機→次のスマホ, 中止する→やめる/なくなる, 直面する→ある/起こる, 発表する→言う, 確認する→言う, 役員→会社の人, 可能性がある→かもしれない, 予測する→言う, 特徴的→めずらしい, 標準の→ふつうの, 製品→もの.",
  "- If a concept has no simple word, use a short plain phrase or a common katakana loanword (ミュージアム, コンピューター).",
  "",
  "GRAMMAR:",
  "- Use です/ます, past ～ました/でした, negative ～ません, て-form, particles は が を に へ で と も から まで や, possessive の, い/な-adjectives, あります/います, ～たい, ～かもしれません.",
  "- Avoid passive, causative, keigo, ～でしょう, ～そうです (hearsay), and nominalization chains. Prefer plain connectives: そのため→だから, しかし→でも.",
  "- Keep sentences short, one idea each. Split long source sentences into several short N5 sentences.",
  "",
  "NAMES AND PASSTHROUGH:",
  "- Leave product, brand, and company names in their original spelling. Do NOT transliterate. Keep Nothing, CMF Phone 3 Pro, TechRadar as-is.",
  "- Return unchanged: numbers, dates, URLs, emails, code, prices, single symbols or emoji, and whitespace-only strings.",
  "",
  "OUTPUT:",
  "- Normal Japanese with kanji. No furigana, ruby, romaji, HTML, markdown, or explanations.",
  "- Never merge or split segments. Output length MUST equal input length, same order.",
  "- Return ONLY a JSON array of strings.",
  "",
  "Example input:",
  '["The museum is closed on Mondays.","本日は強風のため、当施設を臨時休業いたします。","Nothing’s next budget phone was scrapped.","TEL: 03-1234-5678"]',
  "Example output:",
  '["ミュージアムは月曜日が休みです。","今日は風が強いです。だから、お店は休みです。","Nothingの次の安いスマホはなくなりました。","TEL: 03-1234-5678"]'
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

/** Storage key for a single job. */
function jobKey(jobId) {
  return `${JOBS_PREFIX}${jobId}`;
}

/** Generate a short unique job ID. */
function generateJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Update a job record in storage. */
async function updateJob(jobId, updates) {
  const key = jobKey(jobId);
  const stored = await browser.storage.local.get(key);
  const job = stored[key] || {};
  await browser.storage.local.set({
    [key]: {
      ...job,
      ...updates,
      updatedAt: Date.now()
    }
  });
}

/** Remove old completed jobs to avoid storage bloat. */
async function cleanupOldJobs() {
  const all = await browser.storage.local.get();
  const cutoff = Date.now() - JOB_MAX_AGE_MS;
  const toRemove = [];
  for (const key of Object.keys(all)) {
    if (key.startsWith(JOBS_PREFIX)) {
      const job = all[key];
      if (!job || (job.updatedAt && job.updatedAt < cutoff)) {
        toRemove.push(key);
      }
    }
  }
  if (toRemove.length > 0) {
    await browser.storage.local.remove(toRemove);
  }
}

/** Create a translation job, start it in the background, and return its ID. */
async function createJob(segments) {
  const settings = await getSettings();

  if (!settings.endpoint || !settings.apiKey) {
    return {
      ok: false,
      code: "NO_SETTINGS",
      error: "API endpoint or key is not set. Open Settings to configure easyLang."
    };
  }

  await cleanupOldJobs();

  const jobId = generateJobId();
  await browser.storage.local.set({
    [jobKey(jobId)]: {
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  });

  // Run asynchronously; do not block the message response.
  runJob(jobId, segments).catch((err) => {
    console.error("easyLang job failed:", err);
  });

  return { ok: true, jobId };
}

/** Return the current status of a job. */
async function getJobResult(jobId) {
  const key = jobKey(jobId);
  const stored = await browser.storage.local.get(key);
  const job = stored[key];
  if (!job) {
    return { ok: false, code: "NOT_FOUND", error: "Translation job not found." };
  }
  return { ok: true, ...job };
}

/** Execute the LLM call for one job and store the result. */
async function runJob(jobId, segments) {
  const settings = await getSettings();

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
      await updateJob(jobId, {
        status: "error",
        code: "HTTP_ERROR",
        error: `API request failed (HTTP ${res.status}). ${truncate(detail, 200)}`.trim()
      });
      return;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const translations = parseTranslationArray(content);

    if (translations.length !== segments.length) {
      await updateJob(jobId, {
        status: "error",
        code: "LENGTH_MISMATCH",
        error: `Expected ${segments.length} translations but received ${translations.length}.`
      });
      return;
    }

    await updateJob(jobId, { status: "done", translations });
  } catch (err) {
    const aborted = err?.name === "AbortError";
    await updateJob(jobId, {
      status: "error",
      code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
      error: aborted
        ? `The translation request timed out after ${settings.timeout}s. Try increasing the timeout in Settings.`
        : `Could not reach the API endpoint. ${err?.message || ""}`.trim()
    });
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
    return createJob(Array.isArray(message.segments) ? message.segments : []);
  }

  if (message.type === "getJobResult") {
    return getJobResult(message.jobId);
  }

  if (message.type === "openOptions") {
    return browser.runtime.openOptionsPage().then(() => ({ ok: true }));
  }
});
