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
  "You are a translation engine that rewrites text into very simple Japanese at the JLPT N5 level.",
  "You will receive a JSON array of strings. Each string is one text segment from a web page.",
  "For EACH input string, produce one output string following these rules:",
  "1. Translate the meaning into natural JLPT N5-level Japanese.",
  "2. If the input is already Japanese, rewrite it into JLPT N5-level Japanese.",
  "3. Use simple vocabulary and grammar that a JLPT N5 learner can understand.",
  "4. Keep the segment count and order identical to the input.",
  "5. Do not add explanations, numbering, or extra punctuation that was not implied by the source.",
  "Return ONLY a JSON array of strings, the same length as the input array, in the same order.",
  "Do not wrap the JSON in markdown fences or any other text.",
  "Example input:",
  '["Welcome to our store.","今日は良い天気です。"]',
  "Example output:",
  '["私たちの店へようこそ。","今日は良い天気です。"]'
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
