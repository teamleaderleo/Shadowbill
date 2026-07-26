const elements = {
  controls: document.querySelector("#fleet-controls"),
  repositoryFilter: document.querySelector("#repository-filter"),
  statusFilter: document.querySelector("#status-filter"),
  sortOrder: document.querySelector("#sort-order"),
  refreshInterval: document.querySelector("#refresh-interval"),
  refreshButton: document.querySelector("#refresh-button"),
  freshness: document.querySelector("#freshness-text"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionText: document.querySelector("#connection-text"),
  fleetError: document.querySelector("#fleet-error"),
  fleetRows: document.querySelector("#fleet-rows"),
  fleetEmpty: document.querySelector("#fleet-empty"),
  fleetCount: document.querySelector("#fleet-count"),
  summary: {
    total: document.querySelector("#summary-total"),
    red: document.querySelector("#summary-red"),
    yellow: document.querySelector("#summary-yellow"),
    grey: document.querySelector("#summary-grey"),
    green: document.querySelector("#summary-green"),
  },
  repositoryPanel: document.querySelector("#repository-panel"),
  repositoryError: document.querySelector("#repository-error"),
  repositoryHeading: document.querySelector("#repository-heading"),
  repositoryStatus: document.querySelector("#repository-status"),
  repositoryRevision: document.querySelector("#repository-revision"),
  repositoryPolicy: document.querySelector("#repository-policy"),
  repositoryObservations: document.querySelector("#repository-observations"),
  repositoryAttention: document.querySelector("#repository-attention"),
  signalRows: document.querySelector("#signal-rows"),
  evidenceList: document.querySelector("#evidence-list"),
  evidenceEmpty: document.querySelector("#evidence-empty"),
  problemList: document.querySelector("#problem-list"),
  problemsEmpty: document.querySelector("#problems-empty"),
  closeRepository: document.querySelector("#close-repository"),
  projectionVersion: document.querySelector("#projection-version"),
};

const state = {
  fleet: null,
  selectedRepository: null,
  timer: null,
  loadedAt: null,
  requestSequence: 0,
};

function parameters() {
  return new URLSearchParams(window.location.search);
}

function safeStatus(value) {
  return ["red", "yellow", "grey", "green"].includes(value) ? value : "grey";
}

function setConnection(mode, text) {
  elements.connectionDot.className = `status-dot ${mode}`.trim();
  elements.connectionText.textContent = text;
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

function formattedAge(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function shortRevision(value) {
  return typeof value === "string" && value.length >= 12 ? value.slice(0, 12) : "—";
}

function text(value, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function statusPill(status) {
  const span = document.createElement("span");
  const safe = safeStatus(status);
  span.className = `status-pill status-${safe}`;
  span.textContent = safe;
  return span;
}

function signalPill(signal) {
  const span = document.createElement("span");
  const status = signal.state ?? "missing";
  span.className = `signal-pill signal-${status}`;
  span.textContent = `${signal.kind}: ${status}`;
  span.title = signal.latest?.observedAt ? `Latest ${signal.latest.observedAt}` : `No selected evidence for ${signal.kind}`;
  return span;
}

function controlsFromUrl() {
  const params = parameters();
  elements.repositoryFilter.value = params.get("q") ?? "";
  elements.statusFilter.value = ["all", "red", "yellow", "grey", "green"].includes(params.get("status"))
    ? params.get("status")
    : "all";
  elements.sortOrder.value = ["attention", "repository", "age"].includes(params.get("sort"))
    ? params.get("sort")
    : "attention";
  elements.refreshInterval.value = ["0", "30", "60", "300"].includes(params.get("refresh"))
    ? params.get("refresh")
    : "0";
  state.selectedRepository = params.get("repository");
}

function updateUrl({ push = false, repository = state.selectedRepository } = {}) {
  const params = parameters();
  const q = elements.repositoryFilter.value.trim();
  const status = elements.statusFilter.value;
  const sort = elements.sortOrder.value;
  const refresh = elements.refreshInterval.value;

  if (q) params.set("q", q); else params.delete("q");
  if (status !== "all") params.set("status", status); else params.delete("status");
  if (sort !== "attention") params.set("sort", sort); else params.delete("sort");
  if (refresh !== "0") params.set("refresh", refresh); else params.delete("refresh");
  if (repository) params.set("repository", repository); else params.delete("repository");

  const url = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
  window.history[push ? "pushState" : "replaceState"]({}, "", url);
}

function attentionRank(status) {
  return { red: 0, yellow: 1, grey: 2, green: 3 }[status] ?? 4;
}

function visibleRepositories() {
  const q = elements.repositoryFilter.value.trim().toLowerCase();
  const status = elements.statusFilter.value;
  const order = elements.sortOrder.value;
  const repositories = [...(state.fleet?.repositories ?? [])].filter((repository) => {
    const identity = repository.repository?.identity ?? repository.repository?.label ?? "";
    return (!q || identity.toLowerCase().includes(q)) && (status === "all" || repository.status === status);
  });
  repositories.sort((left, right) => {
    const identity = (item) => item.repository?.identity ?? "";
    if (order === "repository") return identity(left).localeCompare(identity(right));
    if (order === "age") {
      const leftAge = left.revision?.ageMs ?? -1;
      const rightAge = right.revision?.ageMs ?? -1;
      return rightAge - leftAge || identity(left).localeCompare(identity(right));
    }
    return attentionRank(left.status) - attentionRank(right.status) || identity(left).localeCompare(identity(right));
  });
  return repositories;
}

function recoveryText(recovery) {
  if (!recovery) return "—";
  const type = recovery.type === "descendant-correction" ? "descendant correction" : "same-revision rerun";
  const when = recovery.to?.observedAt ? new Date(recovery.to.observedAt).toLocaleString() : "unknown time";
  return `${type} · ${when}`;
}

function renderFleetRows() {
  const repositories = visibleRepositories();
  elements.fleetRows.replaceChildren();
  elements.fleetEmpty.hidden = repositories.length > 0;
  elements.fleetCount.textContent = `${repositories.length} of ${state.fleet?.summary?.total ?? 0} repositories shown`;

  for (const repository of repositories) {
    const row = document.createElement("tr");

    const statusCell = document.createElement("td");
    statusCell.append(statusPill(repository.status));

    const repositoryCell = document.createElement("td");
    const link = document.createElement("a");
    link.className = "repository-link";
    link.href = `?${new URLSearchParams({ ...Object.fromEntries(parameters()), repository: repository.repository.identity }).toString()}`;
    link.textContent = repository.repository.label ?? repository.repository.identity;
    link.dataset.repository = repository.repository.identity;
    repositoryCell.append(link);

    const revisionCell = document.createElement("td");
    revisionCell.className = "revision";
    revisionCell.textContent = shortRevision(repository.selectedRevision);
    revisionCell.title = text(repository.selectedRevision, "Selected revision unavailable");

    const ageCell = document.createElement("td");
    ageCell.textContent = formattedAge(repository.revision?.ageMs);
    ageCell.title = repository.revision?.timestamp ? `Revision time ${repository.revision.timestamp}` : "Revision time unavailable";

    const classificationCell = document.createElement("td");
    classificationCell.textContent = repository.classification ?? "unknown";

    const signalsCell = document.createElement("td");
    const signalList = document.createElement("div");
    signalList.className = "signal-list";
    if ((repository.requiredSignals ?? []).length === 0) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "No required signal projection";
      signalList.append(empty);
    } else {
      for (const signal of repository.requiredSignals) signalList.append(signalPill(signal));
    }
    signalsCell.append(signalList);

    const attentionCell = document.createElement("td");
    attentionCell.className = "attention-text";
    attentionCell.textContent = repository.attention?.reason ?? "—";

    const recoveryCell = document.createElement("td");
    recoveryCell.className = repository.recentRecovery ? "recovery-text" : "muted";
    recoveryCell.textContent = recoveryText(repository.recentRecovery);

    row.append(statusCell, repositoryCell, revisionCell, ageCell, classificationCell, signalsCell, attentionCell, recoveryCell);
    elements.fleetRows.append(row);
  }
}

function renderSummary() {
  const summary = state.fleet?.summary ?? {};
  for (const [name, element] of Object.entries(elements.summary)) element.textContent = text(summary[name], "0");
  elements.projectionVersion.textContent = `Projection v${state.fleet?.projectionVersion ?? "—"} · ${state.fleet?.sourceCursor?.slice(0, 19) ?? "cursor unavailable"}`;
}

function renderFreshness() {
  if (!state.fleet?.generatedAt) {
    elements.freshness.textContent = "Fleet has not loaded yet.";
    return;
  }
  const generated = new Date(state.fleet.generatedAt);
  const age = Date.now() - generated.getTime();
  const refresh = Number(elements.refreshInterval.value);
  elements.freshness.textContent = `Projection generated ${generated.toLocaleString()} · ${formattedAge(age)} old${refresh ? ` · refresh every ${refresh}s` : " · automatic refresh off"}`;
}

function evidenceKey(evidence) {
  return `${evidence.digest ?? ""}\u0000${evidence.uri ?? ""}`;
}

function renderRepository(report) {
  elements.repositoryPanel.hidden = false;
  clearError(elements.repositoryError);
  elements.repositoryHeading.textContent = report.repository?.label ?? report.repository?.identity ?? "Repository evidence";
  elements.repositoryStatus.replaceChildren(statusPill(report.status));
  elements.repositoryRevision.textContent = shortRevision(report.selectedRevision);
  elements.repositoryRevision.title = text(report.selectedRevision, "Selected revision unavailable");
  elements.repositoryPolicy.textContent = `${text(report.configuration?.source)}${report.configuration?.changedSinceEnrolment ? " · changed" : ""}`;
  elements.repositoryObservations.textContent = text(report.observationCount, "0");
  elements.repositoryAttention.textContent = report.attention?.reason ?? "Every required signal currently passes.";

  elements.signalRows.replaceChildren();
  const evidence = new Map();
  for (const signal of report.signals ?? []) {
    const row = document.createElement("tr");
    const signalCell = document.createElement("td");
    signalCell.textContent = signal.policy?.kind ?? "unknown";
    const requirementCell = document.createElement("td");
    requirementCell.textContent = signal.policy?.requirement ?? "unknown";
    const stateCell = document.createElement("td");
    stateCell.append(signalPill({ kind: signal.policy?.kind ?? "signal", state: signal.state, latest: signal.latest }));
    const attemptsCell = document.createElement("td");
    attemptsCell.textContent = `${signal.attempts ?? 0}${signal.reruns ? ` (${signal.reruns} reruns)` : ""}`;
    const latestCell = document.createElement("td");
    latestCell.textContent = signal.latest
      ? `${signal.latest.source}#${signal.latest.id} · ${new Date(signal.latest.observedAt).toLocaleString()}`
      : signal.reason ?? "No selected evidence";
    row.append(signalCell, requirementCell, stateCell, attemptsCell, latestCell);
    elements.signalRows.append(row);
    for (const reference of signal.latest?.evidence ?? []) evidence.set(evidenceKey(reference), reference);
  }

  elements.evidenceList.replaceChildren();
  elements.evidenceEmpty.hidden = evidence.size > 0;
  for (const reference of evidence.values()) {
    const item = document.createElement("li");
    const identity = document.createElement("code");
    identity.textContent = reference.digest ?? reference.uri ?? "evidence reference";
    const meta = document.createElement("span");
    meta.className = "evidence-meta";
    meta.textContent = [reference.producer, reference.schema, reference.mediaType, reference.disclosure, reference.state]
      .filter(Boolean)
      .join(" · ");
    item.append(identity, meta);
    elements.evidenceList.append(item);
  }

  const problems = report.configuration?.problems ?? [];
  elements.problemList.replaceChildren();
  elements.problemsEmpty.hidden = problems.length > 0;
  for (const problem of problems) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = problem.code ?? "PROJECTION_PROBLEM";
    item.append(code, document.createTextNode(` — ${problem.message ?? "Repository configuration requires attention."}`));
    elements.problemList.append(item);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Collector returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) throw new Error(body.error?.message ?? body.error ?? `Collector request failed (${response.status}).`);
  return body;
}

async function loadRepository(identity, { scroll = false } = {}) {
  if (!identity) {
    elements.repositoryPanel.hidden = true;
    return;
  }
  elements.repositoryPanel.hidden = false;
  clearError(elements.repositoryError);
  elements.repositoryHeading.textContent = identity;
  elements.repositoryAttention.textContent = "Loading repository evidence…";
  try {
    const report = await fetchJson(`/v1/revision-evidence?repository=${encodeURIComponent(identity)}`);
    if (state.selectedRepository !== identity) return;
    renderRepository(report);
    if (scroll) elements.repositoryPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (state.selectedRepository !== identity) return;
    showError(elements.repositoryError, error instanceof Error ? error.message : String(error));
    elements.repositoryAttention.textContent = "Repository projection is unavailable. Fleet data remains visible above.";
  }
}

async function loadFleet({ manual = false } = {}) {
  const sequence = ++state.requestSequence;
  clearError(elements.fleetError);
  setConnection("", manual ? "Refreshing fleet" : "Loading fleet");
  elements.refreshButton.disabled = true;
  try {
    const report = await fetchJson("/v1/fleet");
    if (sequence !== state.requestSequence) return;
    state.fleet = report;
    state.loadedAt = Date.now();
    renderSummary();
    renderFleetRows();
    renderFreshness();
    setConnection("connected", "Fleet connected");
    if (state.selectedRepository) await loadRepository(state.selectedRepository);
  } catch (error) {
    if (sequence !== state.requestSequence) return;
    showError(elements.fleetError, error instanceof Error ? error.message : String(error));
    setConnection("error", "Fleet unavailable");
    elements.fleetCount.textContent = "Fleet projection unavailable";
  } finally {
    if (sequence === state.requestSequence) elements.refreshButton.disabled = false;
  }
}

function configureTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
  const seconds = Number(elements.refreshInterval.value);
  if (seconds > 0) state.timer = window.setInterval(() => loadFleet(), seconds * 1000);
  renderFreshness();
}

function applyControls({ push = false, load = false } = {}) {
  updateUrl({ push });
  renderFleetRows();
  configureTimer();
  if (load) loadFleet({ manual: true });
}

elements.controls.addEventListener("submit", (event) => {
  event.preventDefault();
  applyControls({ push: true, load: true });
});
for (const element of [elements.repositoryFilter, elements.statusFilter, elements.sortOrder]) {
  element.addEventListener(element === elements.repositoryFilter ? "input" : "change", () => {
    updateUrl();
    renderFleetRows();
  });
}
elements.refreshInterval.addEventListener("change", () => {
  updateUrl();
  configureTimer();
});
elements.fleetRows.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-repository]");
  if (!link) return;
  event.preventDefault();
  state.selectedRepository = link.dataset.repository;
  updateUrl({ push: true });
  loadRepository(state.selectedRepository, { scroll: true });
});
elements.closeRepository.addEventListener("click", () => {
  state.selectedRepository = null;
  updateUrl({ push: true, repository: null });
  elements.repositoryPanel.hidden = true;
});
window.addEventListener("popstate", () => {
  controlsFromUrl();
  renderFleetRows();
  configureTimer();
  loadRepository(state.selectedRepository);
});
window.setInterval(renderFreshness, 1000);

controlsFromUrl();
configureTimer();
loadFleet();
