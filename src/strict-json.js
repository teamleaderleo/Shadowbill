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
  while (cursor.index < text.length && /[\t\n\r ]/u.test(text[cursor.index])) cursor.index += 1;
}

function parseString(text, cursor, options, path) {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < text.length) {
    const code = text.charCodeAt(cursor.index);
    if (code === 0x22) {
      cursor.index += 1;
      let value;
      try {
        value = JSON.parse(text.slice(start, cursor.index));
      } catch {
        fail(options.prefix, "INVALID_JSON", "Invalid JSON string escape.", path);
      }
      if (value.length > options.maxStringLength) {
        fail(options.prefix, "STRING_TOO_LONG", `JSON string exceeds ${options.maxStringLength} characters.`, path);
      }
      return value;
    }
    if (code < 0x20) fail(options.prefix, "INVALID_JSON", "Unescaped control character in JSON string.", path);
    if (code === 0x5c) {
      cursor.index += 1;
      if (cursor.index >= text.length) fail(options.prefix, "INVALID_JSON", "Incomplete JSON escape.", path);
      if (text[cursor.index] === "u") {
        const hex = text.slice(cursor.index + 1, cursor.index + 5);
        if (!/^[a-fA-F0-9]{4}$/u.test(hex)) fail(options.prefix, "INVALID_JSON", "Invalid Unicode escape.", path);
        cursor.index += 5;
        continue;
      }
      if (!/["\\/bfnrt]/u.test(text[cursor.index])) fail(options.prefix, "INVALID_JSON", "Invalid JSON escape.", path);
    }
    cursor.index += 1;
  }
  fail(options.prefix, "INVALID_JSON", "Unterminated JSON string.", path);
}

function parseNumber(text, cursor, options, path) {
  const match = text.slice(cursor.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
  if (!match) fail(options.prefix, "INVALID_JSON", "Invalid JSON number.", path);
  cursor.index += match[0].length;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) fail(options.prefix, "NON_FINITE_NUMBER", "JSON numbers must be finite.", path);
}

function parseValue(text, cursor, depth, options, path) {
  if (depth > options.maxDepth) fail(options.prefix, "TOO_DEEP", `JSON nesting exceeds ${options.maxDepth}.`, path);
  skipWhitespace(text, cursor);
  const char = text[cursor.index];
  if (char === "{") return parseObject(text, cursor, depth + 1, options, path);
  if (char === "[") return parseArray(text, cursor, depth + 1, options, path);
  if (char === '"') return parseString(text, cursor, options, path);
  if (char === "-" || /\d/u.test(char ?? "")) return parseNumber(text, cursor, options, path);
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
    const key = parseString(text, cursor, options, path);
    if (keys.has(key)) fail(options.prefix, "DUPLICATE_KEY", `Duplicate JSON key: ${key}.`, `${path}.${key}`);
    keys.add(key);
    if (keys.size > options.maxObjectKeys) {
      fail(options.prefix, "OBJECT_TOO_LARGE", `JSON object exceeds ${options.maxObjectKeys} keys.`, path);
    }
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
    if (index >= options.maxArrayLength) {
      fail(options.prefix, "ARRAY_TOO_LARGE", `JSON array exceeds ${options.maxArrayLength} entries.`, path);
    }
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

export function parseStrictJson(text, options = {}) {
  const settings = {
    maxBytes: options.maxBytes ?? 65_536,
    maxDepth: options.maxDepth ?? 16,
    maxStringLength: options.maxStringLength ?? 4_096,
    maxObjectKeys: options.maxObjectKeys ?? 128,
    maxArrayLength: options.maxArrayLength ?? 128,
    prefix: options.prefix ?? "STRICT_JSON",
  };
  if (typeof text !== "string") fail(settings.prefix, "INVALID_JSON", "JSON input must be a string.");
  if (Buffer.byteLength(text, "utf8") > settings.maxBytes) {
    fail(settings.prefix, "TOO_LARGE", `JSON input exceeds ${settings.maxBytes} bytes.`);
  }
  const cursor = { index: 0 };
  parseValue(text, cursor, 0, settings, "$");
  skipWhitespace(text, cursor);
  if (cursor.index !== text.length) fail(settings.prefix, "INVALID_JSON", "Trailing data after JSON value.");
  try {
    return JSON.parse(text);
  } catch {
    fail(settings.prefix, "INVALID_JSON", "Input contains invalid JSON.");
  }
}
