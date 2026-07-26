import { createProofwakeProjectionMcp } from "./projection-mcp.js";
import { discloseProofwakeProjection } from "./projection-mcp-disclosure.js";

function disclosedResult(result) {
  if (result === null || result.isError === true) return result;
  const structuredContent = discloseProofwakeProjection(result.structuredContent);
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

/**
 * Adds the MCP privacy boundary after the shared projection adapter has built
 * its response from the immutable registry and ledger snapshots.
 */
export function createDisclosedProofwakeProjectionMcp(options) {
  const projections = createProofwakeProjectionMcp(options);
  return {
    tools: projections.tools,
    async callTool(name, args) {
      return disclosedResult(await projections.callTool(name, args));
    },
  };
}
