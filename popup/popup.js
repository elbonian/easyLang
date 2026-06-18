/* easyLang popup logic */

const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const settingsBtn = document.getElementById("open-settings");

let activeTabId = null;

function setStatus(label, modifier) {
  statusEl.textContent = label;
  statusEl.className = `status status--${modifier}`;
}

function setUnsupported(message) {
  toggle.checked = false;
  toggle.disabled = true;
  setStatus("N/A", "off");
  hintEl.textContent = message;
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function init() {
  const tab = await getActiveTab();
  if (!tab || !/^https?:/i.test(tab.url || "")) {
    setUnsupported("easyLang only works on regular web pages.");
    return;
  }

  activeTabId = tab.id;

  try {
    const state = await browser.tabs.sendMessage(activeTabId, { type: "getState" });
    if (!state || !state.ok) {
      setUnsupported("Reload the page, then try again.");
      return;
    }
    applyState(state);
  } catch (_) {
    // Content script not present (e.g., page loaded before install).
    setUnsupported("Reload the page, then try again.");
  }
}

function applyState(state) {
  toggle.disabled = false;
  toggle.checked = state.active || state.translating;
  if (state.translating) {
    setStatus("…", "busy");
    hintEl.textContent = "Translating the page…";
  } else if (state.active) {
    setStatus("ON", "on");
    hintEl.textContent = "Showing JLPT N5 Japanese.";
  } else {
    setStatus("OFF", "off");
    hintEl.textContent = "";
  }
}

toggle.addEventListener("change", async () => {
  if (activeTabId == null) return;
  const active = toggle.checked;

  if (active) {
    setStatus("…", "busy");
    hintEl.textContent = "Translating the page…";
  } else {
    setStatus("OFF", "off");
    hintEl.textContent = "";
  }

  try {
    await browser.tabs.sendMessage(activeTabId, { type: "setState", active });
  } catch (_) {
    setUnsupported("Reload the page, then try again.");
  }
});

settingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
