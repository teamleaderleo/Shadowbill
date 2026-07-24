/**
 * Provider-independent approximation for text and source code.
 * Exact model tokenizers can be added behind this interface later.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (text.length === 0) return 0;

  const bytes = Buffer.byteLength(text, "utf8");
  const codeSignals = (text.match(/[{}()[\];=<>]|\b(?:const|let|function|class|def|import|return)\b/g) ?? []).length;
  const divisor = codeSignals > text.length / 40 ? 3.25 : 3.8;
  return Math.max(1, Math.ceil(bytes / divisor));
}
