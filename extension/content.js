const DEFAULTS = {
  enabled: true,
  collectorUrl: "http://127.0.0.1:7337",
  collectorToken: "",
  model: "gpt-5.6-sol",
  reasoningEffort: "high"
};

const observed = new WeakSet();
const emitted = new Set(JSON.parse(sessionStorage.getItem("shadowbill:emitted") || "[]"));

function estimateTokens(text) {
  if (!text) return 0;
  const bytes = new TextEncoder().encode(text).length;
  const codeSignals = (text.match(/[{}()[\];=<>]|\b(?:const|let|function|class|def|import|return)\b/g) || []).length;
  return Math.max(1, Math.ceil(bytes / (codeSignals > text.length / 40 ? 3.25 : 3.8)));
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function roleMessages() {
  return Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function emitAssistant(element) {
  const config = await settings();
  if (!config.enabled || !config.collectorToken) return;

  const messages = roleMessages();
  const index = messages.indexOf(element);
  if (index < 0) return;

  const outputText = element.innerText || element.textContent || "";
  if (!outputText.trim()) return;

  const key = await digest(`${location.pathname}:${index}:${outputText}`);
  if (emitted.has(key)) return;

  const priorText = messages.slice(0, index).map((message) => message.innerText || message.textContent || "").join("\n");
  const conversationHash = await digest(location.pathname);
  const event = {
    type: "chat_turn",
    id: `chat_${key}`,
    timestamp: new Date().toISOString(),
    conversationHash,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    visibleInputTokens: estimateTokens(priorText),
    visibleOutputTokens: estimateTokens(outputText),
    collectorVersion: "0.2.0"
  };

  const response = await fetch(`${config.collectorUrl.replace(/\/$/, "")}/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.collectorToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(event)
  });
  if (!response.ok) throw new Error(`Shadowbill collector returned ${response.status}`);

  emitted.add(key);
  const recent = Array.from(emitted).slice(-500);
  sessionStorage.setItem("shadowbill:emitted", JSON.stringify(recent));
}

function watchAssistant(element) {
  if (observed.has(element)) return;
  observed.add(element);

  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => emitAssistant(element).catch(() => {}), 1800);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  schedule();
}

function scan() {
  document.querySelectorAll('[data-message-author-role="assistant"]').forEach(watchAssistant);
}

new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
scan();
