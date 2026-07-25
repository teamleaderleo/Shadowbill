export class StrictJsonError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.path = path;
  }
}

function fail(prefix, suffix, message, path = "$") {
  throw new StrictJsonError(`${prefix}_${suffix}`, message, path);
}

function skipWhitespace(text, cursor) {
  while (cursor.index < text.length && /\s/.test(text[cursor.index])) cursor.index += 1;
}

function parseString(text, cursor, prefix, path) {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < text.length) {
    const code = text.charCodeAt(cursor.index);
    if (code === 0x22) {
      cursor.index += 1;
      try {
        return JSON.parse(text.slice(start, cursor.index));
      } catch {
        fail(prefix, "INVALID_JSON", "Invalid JSON string escape.", path);
      }
    }
    if (code < 0x20) fail(prefix, "INVALID_JSON", "Unescaped control character in JSON string.", path);
    if (code === 0x5c) {
      cursor.index += 1;
      if (cursor.index >= text.length) fail(prefix, "INVALID_JSON", "Incomplete JSON escape.", path);
      if (text[cursor.index] === "u") {
        const hex = text.slice(cursor.index + 1, cursor.index + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex)) fail(prefix, "INVALID_JSON", "Invalid Unicode escape.", path);
        cursor.index += 5;
        continue;
      }
      if (!/["\\/bfnrt]/.test(text[cursor.index])) fail(prefix, "INVALID_JSON", "Invalid JSON escape.", path);
    }
    cursor.index += 1;
  }
  fail(prefix, "INVALID_JSON", "Unterminated JSON string.", path);
}

function parseNumber(text, cursor, prefix, path) {
  const match = text.slice(cursor.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) fail(prefix, "INVALID_JSON", "Invalid JSON number.", path);
  cursor.index += match[0].length;
}

function parseValue(text, cursor, depth, options, path) {
  if (depth > options.maxDepth) fail(options.prefix, "TOO_DEEP", `JSON nesting exceeds ${options.maxDepth}.`, path);
  skipWhitespace(text, cursor);
  const char = text[cursor.index];
  if (char === "{") return parseObject(text, cursor, depth + 1, options, path);
  if (char === "[") return parseArray(text, cursor, depth + 1, options, path);
  if (char === '"') return parseString(text, cursor, options.prefix, path);
  if (char === "-" || /\d/.test(char ?? "")) return parseNumber(text, cursor, options.prefix, path);
  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, cursor.index)) {
      cursor.index += literal.length;
      return;
    }
  }
  fail(options.prefix, "INVALID_JSON", "Unexpected JSON token.", path);
}

function parseObject(text, cursor, depth, options, path) {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "}") {
    cursor.index += 1;
    return;
  }
  const keys = new Set();
  while (cursor.index < text.length) {
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== '"') fail(options.prefix, "INVALID_JSON", "Object keys must be strings.", path);
    const key = parseString(text, cursor, options.prefix, path);
    if (keys.has(key)) fail(options.prefix, "DUPLICATE_KEY", `Duplicate JSON key: ${key}.`, `${path}.${key}`);
    keys.add(key);
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== ":") fail(options.prefix, "INVALID_JSON", "Expected colon after object key.", `${path}.${key}`);
    cursor.index += 1;
    parseValue(text, cursor, depth, options, `${path}.${key}`);
    skipWhitespace(text, cursor);
    if (text[cursor.index] === "}") {
      cursor.index += 1;
      return;
    }
    if (text[cursor.index] !== ",") fail(options.prefix, "INVALID_JSON", "Expected comma between object entries.", path);
    cursor.index += 1;
  }
  fail(options.prefix, "INVALID_JSON", "Unterminated JSON object.", path);
}

function parseArray(text, cursor, depth, options, path) {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "]") {
    cursor.index += 1;
    return;
  }
  let index = 0;
  while (cursor.index < text.length) {
    parseValue(text, cursor, depth, options, `${path}[${index}]`);
    skipWhitespace(text, cursor);
    if (text[cursor.index] === "]") {
      cursor.index += 1;
      return;
    }
    if (text[cursor.index] !== ",") fail(options.prefix, "INVALID_JSON", "Expected comma between array entries.", path);
    cursor.index += 1;
    index += 1;
  }
  fail(options.prefix, "INVALID_JSON", "Unterminated JSON array.", path);
}

export function parseStrictJson(text, { maxBytes = 65_536, maxDepth = 16, prefix = "STRICT_JSON" } = {}) {
  if (typeof text !== "string") fail(prefix, "INVALID_JSON", "JSON input must be a string.");
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail(prefix, "TOO_LARGE", `JSON input exceeds ${maxBytes} bytes.`);
  const cursor = { index: 0 };
  parseValue(text, cursor, 0, { maxDepth, prefix }, "$");
  skipWhitespace(text, cursor);
  if (cursor.index !== text.length) fail(prefix, "INVALID_JSON", "Trailing data after JSON value.");
  try {
    return JSON.parse(text);
  } catch {
    fail(prefix, "INVALID_JSON", "Input contains invalid JSON.");
  }
}
