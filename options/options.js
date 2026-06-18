/* easyLang options page logic */

const DEFAULTS = {
  endpoint: "",
  apiKey: "",
  model: "deepseek-ai/deepseek-v4-flash",
  temperature: 0.2,
  timeout: 60
};

const endpointEl = document.getElementById("endpoint");
const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const temperatureEl = document.getElementById("temperature");
const timeoutEl = document.getElementById("timeout");
const form = document.getElementById("settings-form");
const statusEl = document.getElementById("save-status");
const toggleKeyBtn = document.getElementById("toggle-key");

function setStatus(message, modifier) {
  statusEl.textContent = message;
  statusEl.className = `save-status save-status--${modifier}`;
  if (message) {
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "save-status";
    }, 3000);
  }
}

async function load() {
  const stored = await browser.storage.local.get(DEFAULTS);
  endpointEl.value = stored.endpoint || "";
  apiKeyEl.value = stored.apiKey || "";
  modelEl.value = stored.model || DEFAULTS.model;
  temperatureEl.value =
    stored.temperature === undefined || stored.temperature === null
      ? DEFAULTS.temperature
      : stored.temperature;
  timeoutEl.value =
    stored.timeout === undefined || stored.timeout === null
      ? DEFAULTS.timeout
      : stored.timeout;
}

toggleKeyBtn.addEventListener("click", () => {
  const showing = apiKeyEl.type === "text";
  apiKeyEl.type = showing ? "password" : "text";
  toggleKeyBtn.textContent = showing ? "Show" : "Hide";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const endpoint = endpointEl.value.trim();
  const apiKey = apiKeyEl.value.trim();

  if (!endpoint || !apiKey) {
    setStatus("Endpoint and API key are required.", "err");
    return;
  }

  let temperature = parseFloat(temperatureEl.value);
  if (!Number.isFinite(temperature)) temperature = DEFAULTS.temperature;
  temperature = Math.min(2, Math.max(0, temperature));

  let timeout = parseInt(timeoutEl.value, 10);
  if (!Number.isFinite(timeout)) timeout = DEFAULTS.timeout;
  timeout = Math.min(180, Math.max(5, timeout));

  const settings = {
    endpoint,
    apiKey,
    model: modelEl.value.trim() || DEFAULTS.model,
    temperature,
    timeout
  };

  try {
    await browser.storage.local.set(settings);
    // Reflect any normalization back into the form.
    modelEl.value = settings.model;
    temperatureEl.value = settings.temperature;
    timeoutEl.value = settings.timeout;
    setStatus("Saved.", "ok");
  } catch (err) {
    setStatus(`Could not save: ${err?.message || err}`, "err");
  }
});

load();
