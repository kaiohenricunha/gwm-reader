"use strict";

// Central logger with one redaction filter for every level.
//
// Every log line goes through redact(). Rules:
//   - values under sensitive keys are replaced, whatever their type;
//   - strings are scrubbed of registered secrets (exact values: password,
//     its MD5, tokens, VIN and its fragments, e-mail), JWTs, 32-hex digests,
//     e-mail addresses, VIN-shaped and masked-VIN words, and coordinates;
//   - Error objects become {error_class, message}; their properties (request
//     options, headers, sockets) are never traversed.

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /token|password|passwd|secret|authorization|cookie|session|credential|vin|imsi|iccid|imei|engineno|lat|lon|lng|gps|location|address|account|email|e_mail|phone|mobile|username|user_name|deviceid|device_id|plate|license|cert|private|^key$|_key$/i;

const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const HEX32 = /\b[a-fA-F0-9]{32}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 17 alphanumerics with at least one letter and one digit (a VIN or similar id).
const VIN_LIKE = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{17}\b/g;
// A VIN masked by the API, for example "ABCDE*******12345".
const MASKED_ID = /\b[A-Za-z0-9]{2,}\*{3,}[A-Za-z0-9]{2,}\b/g;
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*[,;/ ]\s*-?\d{1,3}\.\d{3,}/g;
// A single coordinate-like number (5 or more decimals).
const COORD_ONE = /-?\b\d{1,3}\.\d{5,}\b/g;
const COORD_NUMBER = /^-?\d{1,3}\.\d{5,}$/;

const secrets = new Set();
let sorted = [];

function resort() {
  sorted = [...secrets].sort((a, b) => b.length - a.length);
}

/** registerSecret adds an exact value to scrub from every string. */
function registerSecret(value) {
  if (typeof value !== "string" || value.length < 4) return;
  let changed = false;
  for (const v of [value, value.toLowerCase(), value.toUpperCase()]) {
    if (!secrets.has(v)) {
      secrets.add(v);
      changed = true;
    }
  }
  if (changed) resort();
}

/** registerVin adds a VIN and the fragments that identify it (WMI+VDS, serial). */
function registerVin(vin) {
  if (typeof vin !== "string" || vin.length < 11) return;
  const v = vin.trim();
  registerSecret(v);
  registerSecret(v.slice(0, 11));
  registerSecret(v.slice(-8));
}

function unregisterSecret(value) {
  if (typeof value !== "string") return;
  let changed = false;
  for (const v of [value, value.toLowerCase(), value.toUpperCase()]) changed = secrets.delete(v) || changed;
  if (changed) resort();
}

/** For tests only. */
function clearSecrets() {
  secrets.clear();
  resort();
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

function redactString(s) {
  let out = String(s);
  for (const v of sorted) {
    if (out.includes(v)) out = out.split(v).join(REDACTED);
  }
  return out
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(HEX32, REDACTED)
    .replace(MASKED_ID, REDACTED)
    .replace(VIN_LIKE, REDACTED)
    .replace(COORD_PAIR, REDACTED)
    .replace(COORD_ONE, REDACTED);
}

function errorClass(err) {
  if (err && typeof err === "object") {
    if (typeof err.errorClass === "string") return err.errorClass;
    const code = err.code;
    if (code === "ETIMEDOUT" || err.name === "TimeoutError") return "timeout";
    if (typeof code === "string" && /^(E[A-Z]+|ERR_TLS|CERT_|UNABLE_TO|DEPTH_|SELF_SIGNED)/.test(code)) return "network";
    if (err.name === "SyntaxError") return "parse";
  }
  return "internal";
}

function safeError(err) {
  if (err && typeof err === "object" && "message" in err) {
    return { error_class: errorClass(err), message: redactString(err.message ?? "") };
  }
  return { error_class: "internal", message: redactString(String(err)) };
}

function redact(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return COORD_NUMBER.test(String(value)) ? REDACTED : value;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return safeError(value);
  if (Buffer.isBuffer(value)) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return REDACTED;
}

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function parseLevel(raw) {
  const l = String(raw || "INFO").toUpperCase();
  return l === "WARNING" ? "WARN" : l;
}

/**
 * createLogger writes one JSON object per line: {time, level, msg, ...fields}.
 * The message and all fields are redacted at every level.
 */
function createLogger({ level = "INFO", write = (line) => process.stderr.write(line), now = () => new Date() } = {}) {
  const min = LEVELS[parseLevel(level)] ?? LEVELS.INFO;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const rec = { time: now().toISOString(), level: lvl.toLowerCase(), msg: redactString(msg) };
    if (fields !== undefined) {
      const extra = redact(fields instanceof Error ? { error: fields } : fields);
      if (extra && typeof extra === "object") {
        for (const [k, v] of Object.entries(extra)) if (!(k in rec)) rec[k] = v;
      } else {
        rec.detail = extra;
      }
    }
    write(JSON.stringify(rec) + "\n");
  };
  return {
    debug: (msg, fields) => emit("DEBUG", msg, fields),
    info: (msg, fields) => emit("INFO", msg, fields),
    warn: (msg, fields) => emit("WARN", msg, fields),
    error: (msg, fields) => emit("ERROR", msg, fields),
  };
}

module.exports = {
  REDACTED,
  LEVELS,
  clearSecrets,
  createLogger,
  errorClass,
  isSensitiveKey,
  parseLevel,
  redact,
  redactString,
  registerSecret,
  registerVin,
  safeError,
  unregisterSecret,
};
