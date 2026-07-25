const {
  DEFAULTS,
  collectorPermissionPattern,
  normalizeCollectorToken,
  normalizeCollectorUrl,
  normalizeModel,
} = globalThis.ShadowbillConfig;

const DELIVERY_DEFAULTS = {
  lastDeliveryAt: "",
  lastDeliveryError: "",
  lastDeliveryErrorAt: "",
};

function setStatus(kind, message) {
  const status = document.getElementById("status");
  status.className = kind;
  status.textContent = message;
}

function updateDashboardLink(collectorUrl) {
  const link = document.getElementById("dashboard-link");
  try {
    link.href = `${normalizeCollectorUrl(collectorUrl)}/dashboard`;
    link.removeAttribute("aria-disabled");
  } catch {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
  }
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderDeliveryHealth(value) {
  const status = document.getElementById("delivery-status");
  const detail = document.getElementById("delivery-detail");
  const deliveredAt = Date.parse(value.lastDeliveryAt || "") || 0;
  const failedAt = Date.parse(value.lastDeliveryErrorAt || "") || 0;

  if (!value.enabled) {
    status.textContent = "Capture is disabled.";
    detail.textContent = value.lastDeliveryAt ? `Last successful delivery: ${formatTimestamp(value.lastDeliveryAt)}` : "Enable capture and save when ready.";
    return;
  }

  if (failedAt > deliveredAt) {
    status.textContent = "The latest delivery failed.";
    detail.textContent = `${formatTimestamp(value.lastDeliveryErrorAt)} · ${value.lastDeliveryError || "Collector unavailable."}`;
    return;
  }

  if (deliveredAt > 0) {
    status.textContent = "Recent capture delivered.";
    detail.textContent = formatTimestamp(value.lastDeliveryAt);
    return;
  }

  status.textContent = "No capture has been delivered yet.";
  detail.textContent = "Save and test, then complete a ChatGPT response.";
}

async function load() {
  const config = await chrome.storage.local.get({ ...DEFAULTS, ...DELIVERY_DEFAULTS });
  for (const [key, value] of Object.entries(config)) {
    const input = document.getElementById(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
  }
  updateDashboardLink(config.collectorUrl);
  renderDeliveryHealth(config);
}

async function ensureCollectorPermission(pattern) {
  const request = { origins: [pattern] };
  if (await chrome.permissions.contains(request)) return true;
  return chrome.permissions.request(request);
}

document.getElementById("save").addEventListener("click", async () => {
  const saveButton = document.getElementById("save");
  saveButton.disabled = true;
  setStatus("pending", "Validating settings…");

  try {
    const collectorUrl = normalizeCollectorUrl(document.getElementById("collectorUrl").value);
    const collectorToken = normalizeCollectorToken(document.getElementById("collectorToken").value);
    const model = normalizeModel(document.getElementById("model").value);
    const permissionPattern = collectorPermissionPattern(collectorUrl);
    const permissionGranted = await ensureCollectorPermission(permissionPattern);
    if (!permissionGranted) throw new Error("Browser access to the collector URL was declined.");

    const config = {
      enabled: document.getElementById("enabled").checked,
      collectorUrl,
      collectorToken,
      model,
      reasoningEffort: document.getElementById("reasoningEffort").value,
    };
    await chrome.storage.local.set(config);
    updateDashboardLink(collectorUrl);

    const response = await fetch(`${collectorUrl}/v1/auth/check`, {
      headers: { authorization: `Bearer ${collectorToken}` },
      cache: "no-store",
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) throw new Error(body.error || `Collector returned ${response.status}.`);

    setStatus("success", config.enabled ? "Ready. Collector authenticated and capture enabled." : "Saved. Collector authenticated; capture remains disabled.");
    renderDeliveryHealth({ ...config, ...(await chrome.storage.local.get(DELIVERY_DEFAULTS)) });
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    saveButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!["enabled", "lastDeliveryAt", "lastDeliveryError", "lastDeliveryErrorAt"].some((key) => key in changes)) return;
  chrome.storage.local.get({ ...DEFAULTS, ...DELIVERY_DEFAULTS }).then(renderDeliveryHealth);
});

load().catch((error) => setStatus("error", error instanceof Error ? error.message : String(error)));
