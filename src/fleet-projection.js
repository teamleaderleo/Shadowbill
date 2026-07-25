import { buildRepositoryInventory } from "./repository-inventory.js";
import { buildFleetProjection as buildRawFleetProjection } from "./revision-projection.js";

function configurationAttention(item) {
  const problem = item.problems?.[0];
  return {
    type: "configuration",
    reason: problem?.message ?? item.attentionReason ?? "Repository configuration requires attention.",
    signal: null,
    observation: null,
  };
}

export async function buildFleetProjection(options) {
  const [report, inventory] = await Promise.all([
    buildRawFleetProjection(options),
    buildRepositoryInventory(options),
  ]);
  const inventoryByIdentity = new Map(inventory.repositories.map((item) => [item.repository.identity, item]));

  for (const repository of report.repositories) {
    const item = inventoryByIdentity.get(repository.repository.identity);
    repository.problems = item?.problems ?? [];
    if (!repository.attention && repository.classification === "misconfigured") {
      repository.attention = configurationAttention(item ?? repository);
    }
  }
  return report;
}
