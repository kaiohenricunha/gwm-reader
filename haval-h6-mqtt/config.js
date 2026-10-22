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

const DEFAULTS = Object.freeze({ REFRESH_TIME: 300, CHARGING_HISTORY_INTERVAL: 21600 });
const MINIMUMS = Object.freeze({ REFRESH_TIME: 60, CHARGING_HISTORY_INTERVAL: 3600 });

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

// Secrets are accepted only from files. A plain environment variable leaks
// through `docker inspect`, /proc/<pid>/environ and crash reports, so the
// program refuses to start when one is set.
const SECRETS = Object.freeze({
  GWM_USERNAME: "gwm_username",
  GWM_PASSWORD: "gwm_password",
  MQTT_PASSWORD: "mqtt_password",
});
const PLAIN_SECRET_VARS = Object.freeze(["GWM_USERNAME", "GWM_PASSWORD", "PASSWORD", "MQTT_PASSWORD", "MQTT_PASS"]);
const SECRETS_DIR = "/run/secrets";

/** refusePlainSecrets throws when a secret is passed as a plain environment variable. */
function refusePlainSecrets(env) {
  const found = PLAIN_SECRET_VARS.filter((n) => env[n] !== undefined && env[n] !== "");
  if (found.length) {
    throw new ConfigError(
      `refusing to start: ${found.join(", ")} set as plain environment variable(s). Secrets are read only from files: ` +
        "use GWM_USERNAME_FILE, GWM_PASSWORD_FILE and MQTT_PASSWORD_FILE (or Docker secrets in /run/secrets).",
    );
  }
}

/**
 * readSecretFile returns the contents of NAME_FILE, or of /run/secrets/<name>
 * when NAME_FILE is not set, with one trailing newline removed. It returns
 * undefined when neither exists.
 */
function readSecretFile(env, name, readFile, secretsDir = SECRETS_DIR) {
  const explicit = env[`${name}_FILE`];
  const file = explicit || `${secretsDir}/${SECRETS[name] || name.toLowerCase()}`;
  let v;
  try {
    v = String(readFile(file, "utf8"));
  } catch (err) {
    if (!explicit && err && err.code === "ENOENT") return undefined;
    throw new ConfigError(`${explicit ? `${name}_FILE` : file} cannot be read`);
  }
  v = v.replace(/\r?\n$/, "");
  if (v === "") throw new ConfigError(`${explicit ? `${name}_FILE` : file} is empty`);
  return v;
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

function loadConfig(env = process.env, { readFile = readFileSync, secretsDir = SECRETS_DIR } = {}) {
  const warnings = [];
  refusePlainSecrets(env);
  const gate = liveGate(env);

  const username = readSecretFile(env, "GWM_USERNAME", readFile, secretsDir);
  const password = readSecretFile(env, "GWM_PASSWORD", readFile, secretsDir);
  if (!username) throw new ConfigError(`GWM_USERNAME_FILE (or ${secretsDir}/gwm_username) is required`);
  if (!password) throw new ConfigError(`GWM_PASSWORD_FILE (or ${secretsDir}/gwm_password) is required`);
  const mqttPassword = readSecretFile(env, "MQTT_PASSWORD", readFile, secretsDir);
  // The VIN only selects the vehicle on a multi-vehicle account. It is not a
  // credential, but it is personal data: keep it in docker-compose.override.yml.
  const vin = env.GWM_VIN_FILE ? readPem("GWM_VIN_FILE", env.GWM_VIN_FILE, readFile).trim() : env.GWM_VIN || undefined;

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
    refreshTimeS: seconds(env, "REFRESH_TIME", DEFAULTS.REFRESH_TIME, MINIMUMS.REFRESH_TIME, warnings),
    chargingHistoryIntervalS: seconds(env, "CHARGING_HISTORY_INTERVAL", DEFAULTS.CHARGING_HISTORY_INTERVAL, MINIMUMS.CHARGING_HISTORY_INTERVAL, warnings),
    deviceTrackerEnabled: bool(env, "DEVICE_TRACKER_ENABLED", false),
    logLevel,
    mqttUrl: env.MQTT_URL || "mqtt://mosquitto:1883",
    mqttUsername: env.MQTT_USERNAME || "gwm_reader",
    mqttPassword,
    dataDir: env.DATA_DIR || "/data",
    tls,
    proxyUrl,
    requestTimeoutMs: 20_000,
  });
}

module.exports = { ConfigError, DEFAULTS, DISABLED_MESSAGE, MINIMUMS, PLAIN_SECRET_VARS, liveGate, loadConfig, readSecretFile, refusePlainSecrets };
