const configHelpers = globalThis.ShadowbillConfig;
const DEFAULTS = configHelpers.DEFAULTS;

const tracked = new Map();
const emitted = new Set(JSON.parse(sessionStorage.getItem("shadowbill:emitted") || "[]"));
const firstSeenByTurn = JSON.parse(sessionStorage.getItem("shadowbill:first-seen") || "{}");
const tracker = globalThis.ShadowbillTurnTracker;
const MINIMUM_QUIET_MS = 5_000;
let lastFailureRecordedAt = 0;

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

async function recordDeliverySuccess(capturedAt) {
  lastFailureRecordedAt = 0;
  try {
    await chrome.storage.local.set({
      lastDeliveryAt: capturedAt,
      lastDeliveryError: "",
      lastDeliveryErrorAt: "",
    });
  } catch {
    // Delivery already succeeded; health metadata is best-effort.
  }
}

async function recordDeliveryFailure(error) {
  const now = Date.now();
  if (now - lastFailureRecordedAt < 30_000) return;
  lastFailureRecordedAt = now;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await chrome.storage.local.set({
      lastDeliveryError: message.slice(0, 160) || "Collector unavailable.",
      lastDeliveryErrorAt: new Date(now).toISOString(),
    });
  } catch {
    // Capture retries continue even when health metadata cannot be stored.
  }
}

function hasCompletionControls(element) {
  const scope = element.closest("article") || element.parentElement?.parentElement || element.parentElement;
  if (!scope) return false;
  return Array.from(scope.querySelectorAll("button, [role=button]")).some((control) => {
    const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("data-testid") || ""}`.toLowerCase();
    return label.includes("copy") || label.includes("regenerate") || label.includes("retry");
  });
}

function isGenerating() {
  return Array.from(document.querySelectorAll("button, [role=button]")).some((control) => {
    const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("data-testid") || ""}`.toLowerCase();
    return label.includes("stop generating") || label.includes("stop response") || label === "stop";
  });
}

function messageId(element) {
  const container = element.closest("[data-message-id]");
  return container?.getAttribute("data-message-id") || element.getAttribute("data-message-id") || "";
}

function previousUserText(messages, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].getAttribute("data-message-author-role") === "user") {
      return messages[cursor].innerText || messages[cursor].textContent || "";
    }
  }
  return "";
}

function rememberFirstSeen(logicalTurnHash, fallback) {
  if (!firstSeenByTurn[logicalTurnHash]) {
    firstSeenByTurn[logicalTurnHash] = fallback;
    const recent = Object.entries(firstSeenByTurn).slice(-500);
    sessionStorage.setItem("shadowbill:first-seen", JSON.stringify(Object.fromEntries(recent)));
  }
  return firstSeenByTurn[logicalTurnHash];
}

async function emitAssistant(element, state) {
  if (state.inFlight || !element.isConnected) return;
  state.inFlight = true;
  try {
    const messages = roleMessages();
    const index = messages.indexOf(element);
    if (index < 0) return;

    const outputText = element.innerText || element.textContent || "";
    if (!outputText.trim()) return;

    const complete = tracker.shouldEmit({
      hasFollowingMessage: messages.slice(index + 1).length > 0,
      hasCompletionControls: hasCompletionControls(element),
      isGenerating: isGenerating(),
      quietForMs: Date.now() - state.lastMutationAt,
      minimumQuietMs: MINIMUM_QUIET_MS
    });
    if (!complete) return;

    const priorText = messages.slice(0, index).map((message) => message.innerText || message.textContent || "").join("\n");
    const ordinal = tracker.assistantOrdinal(messages, element);
    if (ordinal < 0) return;
    const fallbackAnchor = await digest(previousUserText(messages, index));
    const logicalSource = tracker.turnSource({
      conversationPath: location.pathname,
      messageId: messageId(element),
      ordinal,
      fallbackAnchor
    });
    const logicalTurnHash = await digest(logicalSource);
    const captureHash = await digest(`${priorText}\u0000${outputText}`);
    if (state.lastEmittedCaptureHash === captureHash) {
      state.dirty = false;
      return;
    }

    const revisionHash = await digest(`${logicalTurnHash}:${captureHash}`);
    const eventId = `chat_${revisionHash}`;
    if (emitted.has(eventId)) {
      state.lastEmittedCaptureHash = captureHash;
      state.dirty = false;
      return;
    }

    const config = await settings();
    if (!config.enabled || !config.collectorToken) return;

    const conversationHash = await digest(location.pathname);
    const capturedAt = new Date().toISOString();
    const timestamp = rememberFirstSeen(logicalTurnHash, state.firstSeenAt);
    const event = {
      type: "chat_turn",
      id: eventId,
      timestamp,
      capturedAt,
      logicalTurnHash,
      conversationHash,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      visibleInputTokens: estimateTokens(priorText),
      visibleOutputTokens: estimateTokens(outputText),
      collectorVersion: "0.3.0"
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

    await recordDeliverySuccess(capturedAt);
    emitted.add(eventId);
    const recent = Array.from(emitted).slice(-500);
    sessionStorage.setItem("shadowbill:emitted", JSON.stringify(recent));
    state.lastEmittedCaptureHash = captureHash;
    state.dirty = false;
  } catch (error) {
    await recordDeliveryFailure(error);
    throw error;
  } finally {
    state.inFlight = false;
  }
}

function schedule(element, state, delay = MINIMUM_QUIET_MS) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => emitAssistant(element, state).catch(() => {}), delay);
}

function watchAssistant(element) {
  if (tracked.has(element)) return;
  const state = {
    firstSeenAt: new Date().toISOString(),
    lastMutationAt: Date.now(),
    lastEmittedCaptureHash: "",
    dirty: true,
    inFlight: false,
    timer: undefined
  };
  tracked.set(element, state);

  const observer = new MutationObserver(() => {
    state.lastMutationAt = Date.now();
    state.dirty = true;
    schedule(element, state);
  });
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  state.observer = observer;
  schedule(element, state);
}

function scan() {
  const messages = roleMessages();
  messages.filter((message) => message.getAttribute("data-message-author-role") === "assistant").forEach(watchAssistant);

  for (const [element, state] of tracked) {
    if (!element.isConnected) {
      clearTimeout(state.timer);
      state.observer?.disconnect();
      tracked.delete(element);
      continue;
    }
    const index = messages.indexOf(element);
    const hasFollowingMessage = index >= 0 && messages.slice(index + 1).length > 0;
    if (state.dirty || !hasFollowingMessage) emitAssistant(element, state).catch(() => {});
  }
}

new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
setInterval(scan, 1_000);
scan();
