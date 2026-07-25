(function attachShadowbillConfig(root) {
  const DEFAULTS = Object.freeze({
    enabled: true,
    collectorUrl: "http://127.0.0.1:7337",
    collectorToken: "",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });

  const MODEL_SLUG = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;

  function normalizeCollectorUrl(value) {
    const input = String(value ?? "").trim();
    if (!input) throw new Error("Collector URL required.");

    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Collector URL must be a valid http or https URL.");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Collector URL must use http or https.");
    }
    if (url.username || url.password) {
      throw new Error("Collector URL cannot include a username or password.");
    }
    if (!url.hostname) throw new Error("Collector URL must include a host.");

    return url.origin;
  }

  function collectorPermissionPattern(value) {
    const url = new URL(normalizeCollectorUrl(value));
    return `${url.protocol}//${url.hostname}/*`;
  }

  function normalizeCollectorToken(value) {
    const token = String(value ?? "").trim();
    if (token.length < 32) throw new Error("Collector token must contain at least 32 characters.");
    return token;
  }

  function normalizeModel(value) {
    const model = String(value ?? "").trim();
    if (!MODEL_SLUG.test(model)) {
      throw new Error("Model must use letters, numbers, dots, underscores, colons, or hyphens.");
    }
    return model;
  }

  root.ShadowbillConfig = Object.freeze({
    DEFAULTS,
    collectorPermissionPattern,
    normalizeCollectorToken,
    normalizeCollectorUrl,
    normalizeModel,
  });
})(globalThis);
