"use strict";

// Configuration from the environment. Pure: takes env and a file reader,
// returns a frozen config plus warnings, or throws ConfigError. Messages
// never contain secret values or file contents.

const { readFileSync } = require("node:fs");

const { DEFAULT_API_BASE, DEFAULT_LOGIN_URL } = require("./carConnector");
const { isGwmCloudHost } = require("./httpClient");
const { VEHICLE_ID } = require("./mqtt");

const DISABLED_MESSAGE =
  "live mode is disabled: gwm-reader does not contact GWM until the owner sets GWM_LIVE_ENABLED=true (see docs/RUNBOOK.md). Exiting.";

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.errorClass = "config";
  }
}

function parseUrl(name, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError(`${name} must use https://`);
  if (u.username || u.password) throw new ConfigError(`${name} must not embed credentials`);
  const gwm = isGwmCloudHost(u.hostname);
  if (gwm && u.protocol !== "https:") throw new ConfigError(`${name}: plain http:// is allowed only for a local mock`);
  return { url: u, gwm };
}

/**
 * liveGate decides whether the reader may run at all.
 *   fixture mode: GWM_LOGIN_URL and GWM_API_BASE both point to non-gwmcloud hosts (a mock);
 *   live mode:    GWM_LIVE_ENABLED is exactly "true".
 */
function liveGate(env) {
  const login = parseUrl("GWM_LOGIN_URL", env.GWM_LOGIN_URL || DEFAULT_LOGIN_URL);
  const api = parseUrl("GWM_API_BASE", env.GWM_API_BASE || DEFAULT_API_BASE);
  if (!login.gwm && !api.gwm && env.GWM_LOGIN_URL && env.GWM_API_BASE) return { run: true, mode: "fixture", liveAllowed: false };
  if (env.GWM_LIVE_ENABLED === "true") return { run: true, mode: "live", liveAllowed: true };
  return { run: false, mode: "disabled", liveAllowed: false, reason: DISABLED_MESSAGE };
}

/** readSecret returns NAME or the contents of NAME_FILE (one trailing newline removed). */
function readSecret(env, name, readFile) {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) throw new ConfigError(`set only one of ${name} and ${name}_FILE`);
  if (file) {
    try {
      return String(readFile(file, "utf8")).replace(/\r?\n$/, "");
    } catch {
      throw new ConfigError(`${name}_FILE cannot be read`);
    }
  }
  return direct || undefined;
}

function readPem(name, file, readFile) {
  try {
    return String(readFile(file, "utf8"));
  } catch {
    throw new ConfigError(`${name} cannot be read`);
  }
}

function seconds(env, name, def, min, warnings) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number of seconds`);
  if (n < min) {
    warnings.push(`${name}=${n} is below the minimum; using ${min} s`);
    return min;
  }
  return Math.round(n);
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function loadConfig(env = process.env, { readFile = readFileSync } = {}) {
  const warnings = [];
  const gate = liveGate(env);

  const username = readSecret(env, "GWM_USERNAME", readFile);
  const password = readSecret(env, "GWM_PASSWORD", readFile);
  if (!username) throw new ConfigError("GWM_USERNAME is required");
  if (!password) throw new ConfigError("GWM_PASSWORD is required");
  const vin = readSecret(env, "GWM_VIN", readFile);

  const vehicleId = env.VEHICLE_ID || "h6";
  if (!VEHICLE_ID.test(vehicleId)) throw new ConfigError("VEHICLE_ID must match ^[a-z0-9][a-z0-9_]{0,31}$");

  const logLevel = String(env.LOG_LEVEL || "INFO").toUpperCase();
  if (!["INFO", "ERROR", "DEBUG"].includes(logLevel)) throw new ConfigError("LOG_LEVEL must be INFO, ERROR or DEBUG");

  const tls = {};
  if (env.GWM_EXTRA_CA_FILE) tls.ca = readPem("GWM_EXTRA_CA_FILE", env.GWM_EXTRA_CA_FILE, readFile);
  const certFile = env.GWM_CLIENT_CERT_FILE;
  const keyFile = env.GWM_CLIENT_KEY_FILE;
  if (Boolean(certFile) !== Boolean(keyFile)) throw new ConfigError("set both GWM_CLIENT_CERT_FILE and GWM_CLIENT_KEY_FILE, or neither");
  if (certFile) {
    tls.cert = readPem("GWM_CLIENT_CERT_FILE", certFile, readFile);
    tls.key = readPem("GWM_CLIENT_KEY_FILE", keyFile, readFile);
  }

  let proxyUrl = env.HTTPS_PROXY || env.https_proxy || undefined;
  if (proxyUrl) {
    const p = parseUrl("HTTPS_PROXY", proxyUrl).url;
    if (p.protocol !== "http:") throw new ConfigError("HTTPS_PROXY must be an http:// CONNECT proxy");
    proxyUrl = p.toString();
  }

  return Object.freeze({
    ...gate,
    warnings,
    loginUrl: (env.GWM_LOGIN_URL || DEFAULT_LOGIN_URL).trim(),
    apiBase: (env.GWM_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, ""),
    username,
    password,
    vin,
    vehicleId,
    refreshTimeS: seconds(env, "REFRESH_TIME", 30, 5, warnings),
    chargingHistoryIntervalS: seconds(env, "CHARGING_HISTORY_INTERVAL", 21600, 300, warnings),
    deviceTrackerEnabled: bool(env, "DEVICE_TRACKER_ENABLED", true),
    logLevel,
    mqttUrl: env.MQTT_HOST || "mqtt://mosquitto:1883",
    mqttUsername: env.MQTT_USER || undefined,
    mqttPassword: env.MQTT_PASS || undefined,
    dataDir: env.DATA_DIR || "./storage",
    tls,
    proxyUrl,
    requestTimeoutMs: 20_000,
  });
}

module.exports = { ConfigError, DISABLED_MESSAGE, liveGate, loadConfig, readSecret };
