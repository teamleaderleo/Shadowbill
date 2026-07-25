import { buildRevisionProjection as buildRawRevisionProjection } from "./revision-projection.js";

function compareEvents(left, right) {
  return left.record.observedAt.localeCompare(right.record.observedAt) ||
    left.record.ingestedAt.localeCompare(right.record.ingestedAt) ||
    left.record.source.localeCompare(right.record.source) ||
    left.record.id.localeCompare(right.record.id) ||
    left.signalIndex - right.signalIndex;
}

function passingAt(signal, record, time) {
  if (!record || record.status !== "passed" || record.coverage.state !== "complete") return false;
  if (signal.policy.freshness.mode !== "duration") return true;
  return Date.parse(time) - Date.parse(record.observedAt) <= signal.policy.freshness.hours * 3_600_000;
}

function firstGreenTimeline(report) {
  const required = report.signals.filter((signal) => signal.policy.requirement === "required");
  if (required.length === 0 || required.some((signal) => !signal.selector.available)) {
    return { firstGreenAt: null, timeToGreenMs: null, confidence: "complete" };
  }

  const events = [];
  for (let signalIndex = 0; signalIndex < required.length; signalIndex += 1) {
    for (const record of required[signalIndex].history) events.push({ signalIndex, record });
  }
  events.sort(compareEvents);
  const latest = Array.from({ length: required.length }, () => null);
  let firstGreenAt = null;

  for (let index = 0; index < events.length;) {
    const observedAt = events[index].record.observedAt;
    while (index < events.length && events[index].record.observedAt === observedAt) {
      latest[events[index].signalIndex] = events[index].record;
      index += 1;
    }
    if (required.every((signal, signalIndex) => passingAt(signal, latest[signalIndex], observedAt))) {
      firstGreenAt = observedAt;
      break;
    }
  }

  const confidence = required.some((signal) => signal.historyTruncated) ? "bounded-history" : "complete";
  return {
    firstGreenAt,
    timeToGreenMs: firstGreenAt && report.firstObservationAt
      ? Math.max(0, Date.parse(firstGreenAt) - Date.parse(report.firstObservationAt))
      : null,
    confidence,
  };
}

export async function buildRevisionProjection(options) {
  const report = await buildRawRevisionProjection(options);
  const timeline = firstGreenTimeline(report);
  report.firstGreenAt = timeline.firstGreenAt;
  report.timeToGreenMs = timeline.timeToGreenMs;
  report.timeToGreenConfidence = timeline.confidence;
  return report;
}
