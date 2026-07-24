const DEFAULTS = {
  enabled: true,
  collectorUrl: "http://127.0.0.1:7337",
  collectorToken: "",
  model: "gpt-5.6-sol",
  reasoningEffort: "high"
};

async function load() {
  const config = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  for (const [key, value] of Object.entries(config)) {
    const input = document.getElementById(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const config = {
    enabled: document.getElementById("enabled").checked,
    collectorUrl: document.getElementById("collectorUrl").value.trim().replace(/\/$/, ""),
    collectorToken: document.getElementById("collectorToken").value.trim(),
    model: document.getElementById("model").value.trim(),
    reasoningEffort: document.getElementById("reasoningEffort").value
  };
  await chrome.storage.local.set(config);
  const status = document.getElementById("status");
  if (!config.collectorToken) {
    status.textContent = "Collector token required.";
    return;
  }

  try {
    const response = await fetch(`${config.collectorUrl}/v1/auth/check`, {
      headers: { authorization: `Bearer ${config.collectorToken}` }
    });
    status.textContent = response.ok ? "Collector authenticated." : `Collector returned ${response.status}.`;
  } catch {
    status.textContent = "Collector unavailable.";
  }
});

load();
