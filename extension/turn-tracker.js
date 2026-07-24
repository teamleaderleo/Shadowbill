(function attachShadowbillTurnTracker(root) {
  function shouldEmit({
    hasFollowingMessage,
    hasCompletionControls,
    isGenerating,
    quietForMs,
    minimumQuietMs = 5_000,
  }) {
    if (hasFollowingMessage) return true;
    if (isGenerating) return false;
    if (hasCompletionControls) return true;
    return quietForMs >= minimumQuietMs;
  }

  function assistantOrdinal(messages, element) {
    let ordinal = -1;
    for (const message of messages) {
      if (message.getAttribute?.("data-message-author-role") === "assistant") ordinal += 1;
      if (message === element) return ordinal;
    }
    return -1;
  }

  function turnSource({ conversationPath, messageId, ordinal }) {
    const stableMessagePart = messageId && messageId.trim() ? `message:${messageId.trim()}` : `assistant:${ordinal}`;
    return `${conversationPath}:${stableMessagePart}`;
  }

  root.ShadowbillTurnTracker = Object.freeze({
    assistantOrdinal,
    shouldEmit,
    turnSource,
  });
})(globalThis);
