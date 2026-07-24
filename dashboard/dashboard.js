const state = {
  days: 30,
  endDate: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
};

const number = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-CA", { style: "percent", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const moneyPrecise = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const dateLabel = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });

const byId = (id) => document.getElementById(id);
const setText = (id, value) => { byId(id).textContent = value; };

function formatMoney(value, precise = false) {
  return value === null || value === undefined ? "—" : (precise ? moneyPrecise : money).format(value);
}

function formatPercentage(value) {
  return value === null || value === undefined ? "—" : percent.format(value);
}

function formatDate(value) {
  if (!value) return "—";
  return dateLabel.format(new Date(`${value}T00:00:00.000Z`));
}

function reportUrl(group = "") {
  const params = new URLSearchParams({ days: String(state.days), timezone: state.timezone });
  if (state.endDate) params.set("date", state.endDate);
  if (group) params.set("group", group);
  return `/v1/report?${params}`;
}

async function fetchReport(group = "") {
  const response = await fetch(reportUrl(group), { headers: { accept: "application/json" }, cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Collector returned ${response.status}`);
  return value;
}

function normalizeReport(value) {
  if (value.calendarDays !== undefined) return value;
  const active = value.chatTurns > 0 || value.commits > 0 || value.pushes > 0 ||
    value.pullRequestEvents > 0 || value.workflowRunEvents > 0 || value.deploymentStatusEvents > 0;
  return {
    ...value,
    startDate: value.date,
    endDate: value.date,
    calendarDays: 1,
    activeDays: active ? 1 : 0,
    timeZone: state.timezone,
    averageWorkingCostPerCalendarDay: value.workingEstimate,
    averageWorkingCostPerActiveDay: active ? value.workingEstimate : 0,
    peakChatTurnDay: value.chatTurns > 0 ? { date: value.date, value: value.chatTurns } : null,
    peakWorkingCostDay: value.workingEstimate > 0 ? { date: value.date, value: value.workingEstimate } : null,
    daily: [value],
  };
}

function setStatus(kind, text) {
  const dot = byId("status-dot");
  dot.className = `status-dot ${kind}`;
  setText("status-text", text);
}

function renderMetrics(report) {
  setText("working-estimate", formatMoney(report.workingEstimate));
  setText("average-cost", `${formatMoney(report.averageWorkingCostPerActiveDay)} per active day`);
  setText("chat-turns", integer.format(report.chatTurns));
  setText("capture-detail", `${integer.format(report.chatRevisionEvents)} captures · ${integer.format(report.supersededChatRevisions)} superseded`);
  setText("visible-tokens", compact.format(report.visibleInputTokens + report.visibleOutputTokens));
  setText("token-split", `${compact.format(report.visibleInputTokens)} input · ${compact.format(report.visibleOutputTokens)} output`);
  setText("code-tokens", compact.format(report.addedCodeTokens));
  setText("code-floor", `${formatMoney(report.deliveredCodeFloor)} delivered-code floor`);
  setText("active-days", `${integer.format(report.activeDays)} / ${integer.format(report.calendarDays)}`);
  setText("calendar-days", `${integer.format(report.calendarDays)} calendar days`);
  setText("conversations", integer.format(report.conversations));
  setText("repositories", `${integer.format(report.repositories)} repositories`);

  setText("commits", integer.format(report.commits));
  setText("cost-per-commit", `${formatMoney(report.costPerCommit, true)} per commit`);
  setText("merged-prs", integer.format(report.mergedPullRequests));
  setText("cost-per-pr", `${formatMoney(report.costPerMergedPullRequest, true)} per merged PR`);
  setText("ci-successes", integer.format(report.successfulWorkflowRuns));
  setText("cost-per-ci", `${formatMoney(report.costPerSuccessfulWorkflowRun, true)} per success`);
  setText("deployments", integer.format(report.successfulDeployments));
  setText("cost-per-deployment", `${formatMoney(report.costPerSuccessfulDeployment, true)} per deployment`);

  setText("peak-chat-day", report.peakChatTurnDay ? formatDate(report.peakChatTurnDay.date) : "—");
  setText("peak-chat-detail", report.peakChatTurnDay ? `${integer.format(report.peakChatTurnDay.value)} turns` : "No chat activity");
  setText("peak-cost-day", report.peakWorkingCostDay ? formatDate(report.peakWorkingCostDay.date) : "—");
  setText("peak-cost-detail", report.peakWorkingCostDay ? formatMoney(report.peakWorkingCostDay.value) : "No estimated cost");
  setText("range-caption", `${report.startDate} through ${report.endDate} · ${report.timeZone}`);
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function renderChart(report) {
  const svg = byId("daily-chart");
  const empty = byId("chart-empty");
  svg.replaceChildren();
  const title = svgElement("title", { id: "chart-title" });
  title.textContent = "Daily Shadowbill usage";
  const description = svgElement("desc", { id: "chart-description" });
  description.textContent = "Bars show daily working cost. The line shows chat-turn volume.";
  svg.append(title, description);
  const daily = report.daily ?? [];
  const maxCost = Math.max(0, ...daily.map((day) => day.workingEstimate));
  const maxTurns = Math.max(0, ...daily.map((day) => day.chatTurns));
  const hasActivity = maxCost > 0 || maxTurns > 0;
  empty.hidden = hasActivity;
  svg.hidden = !hasActivity;
  if (!hasActivity) return;

  const width = 1200;
  const height = 360;
  const margin = { top: 20, right: 24, bottom: 54, left: 58 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const step = chartWidth / Math.max(daily.length, 1);
  const barWidth = Math.max(2, Math.min(24, step * 0.62));

  for (let index = 0; index <= 4; index += 1) {
    const y = margin.top + (chartHeight * index / 4);
    svg.append(svgElement("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "grid-line" }));
    const costValue = maxCost * (1 - index / 4);
    const label = svgElement("text", { x: margin.left - 10, y: y + 6, "text-anchor": "end" });
    label.textContent = costValue === 0 ? "$0" : money.format(costValue);
    svg.append(label);
  }

  const points = [];
  daily.forEach((day, index) => {
    const x = margin.left + step * index + step / 2;
    const costHeight = maxCost === 0 ? 0 : chartHeight * day.workingEstimate / maxCost;
    const bar = svgElement("rect", {
      x: x - barWidth / 2,
      y: margin.top + chartHeight - costHeight,
      width: barWidth,
      height: Math.max(costHeight, day.workingEstimate > 0 ? 1 : 0),
      rx: Math.min(5, barWidth / 3),
      class: "cost-bar",
    });
    const barTitle = svgElement("title");
    barTitle.textContent = `${day.date}: ${formatMoney(day.workingEstimate)}, ${day.chatTurns} turns`;
    bar.append(barTitle);
    svg.append(bar);

    const turnY = margin.top + chartHeight - (maxTurns === 0 ? 0 : chartHeight * day.chatTurns / maxTurns);
    points.push([x, turnY, day]);
  });

  if (points.length > 1) {
    const path = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    svg.append(svgElement("path", { d: path, class: "turn-line" }));
  }
  for (const [x, y, day] of points) {
    const dot = svgElement("circle", { cx: x, cy: y, r: 4.5, class: "turn-dot" });
    const dotTitle = svgElement("title");
    dotTitle.textContent = `${day.date}: ${day.chatTurns} turns`;
    dot.append(dotTitle);
    svg.append(dot);
  }

  const labelCount = Math.min(7, daily.length);
  const interval = Math.max(1, Math.ceil(daily.length / labelCount));
  daily.forEach((day, index) => {
    if (index % interval !== 0 && index !== daily.length - 1) return;
    const x = margin.left + step * index + step / 2;
    const label = svgElement("text", { x, y: height - 18, "text-anchor": "middle" });
    label.textContent = formatDate(day.date);
    svg.append(label);
  });
}

function tableCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function renderTable(report) {
  const body = byId("daily-rows");
  body.replaceChildren();
  for (const day of [...(report.daily ?? [])].reverse()) {
    const row = document.createElement("tr");
    row.append(
      tableCell(day.date),
      tableCell(formatMoney(day.workingEstimate)),
      tableCell(integer.format(day.chatTurns)),
      tableCell(number.format(day.visibleInputTokens)),
      tableCell(number.format(day.visibleOutputTokens)),
      tableCell(integer.format(day.commits)),
      tableCell(integer.format(day.mergedPullRequests)),
      tableCell(integer.format(day.successfulWorkflowRuns)),
      tableCell(integer.format(day.successfulDeployments)),
    );
    body.append(row);
  }
}

function renderRepositories(report) {
  setText("allocated-cost", formatMoney(report.allocatedWorkingEstimate));
  setText("unallocated-cost", formatMoney(report.unallocatedWorkingEstimate));
  setText("allocation-coverage", formatPercentage(report.allocationCoverage));
  setText("allocated-days", `${integer.format(report.allocationDays)} allocation days`);
  setText("unallocated-days", `${integer.format(report.unallocatedDays)} days without retained-code evidence`);
  setText("allocation-repositories", `${integer.format(report.repositoryCount)} repositories`);
  setText("repository-basis", report.allocationBasis);
  setText("allocation-note", report.interpretation);

  const repositories = [...(report.repositories ?? [])].sort((left, right) =>
    right.allocatedWorkingEstimate - left.allocatedWorkingEstimate || left.repository.localeCompare(right.repository));
  const body = byId("repository-rows");
  const empty = byId("repository-empty");
  const table = byId("repository-table-wrap");
  body.replaceChildren();
  empty.hidden = repositories.length > 0;
  table.hidden = repositories.length === 0;

  for (const repository of repositories) {
    const row = document.createElement("tr");
    row.append(
      tableCell(repository.repository),
      tableCell(formatMoney(repository.allocatedWorkingEstimate)),
      tableCell(integer.format(repository.addedCodeTokens)),
      tableCell(integer.format(repository.commits)),
      tableCell(integer.format(repository.mergedPullRequests)),
      tableCell(integer.format(repository.successfulWorkflowRuns)),
      tableCell(integer.format(repository.successfulDeployments)),
      tableCell(formatMoney(repository.costPerCommit, true)),
    );
    body.append(row);
  }
}

function syncControls(report) {
  byId("days-input").value = String(report.calendarDays);
  byId("end-date-input").value = report.endDate;
  byId("timezone-input").value = report.timeZone;
  document.querySelectorAll("[data-days]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.days) === report.calendarDays);
  });
}

async function loadReport() {
  const errorPanel = byId("error-panel");
  errorPanel.hidden = true;
  setStatus("", "Refreshing");
  try {
    const [rawReport, repositoryReport] = await Promise.all([
      fetchReport(),
      fetchReport("repository"),
    ]);
    const report = normalizeReport(rawReport);
    renderMetrics(report);
    renderChart(report);
    renderTable(report);
    renderRepositories(repositoryReport);
    syncControls(report);
    setStatus("online", "Collector online");
    setText("updated-at", `Updated ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorPanel.textContent = message;
    errorPanel.hidden = false;
    setStatus("error", "Report unavailable");
  }
}

for (const button of document.querySelectorAll("[data-days]")) {
  button.addEventListener("click", () => {
    state.days = Number(button.dataset.days);
    byId("days-input").value = String(state.days);
    loadReport();
  });
}

byId("custom-range").addEventListener("submit", (event) => {
  event.preventDefault();
  const days = Number(byId("days-input").value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    byId("error-panel").textContent = "Days must be an integer between 1 and 365.";
    byId("error-panel").hidden = false;
    return;
  }
  state.days = days;
  state.endDate = byId("end-date-input").value;
  state.timezone = byId("timezone-input").value.trim() || state.timezone;
  loadReport();
});

byId("timezone-input").value = state.timezone;
loadReport();
