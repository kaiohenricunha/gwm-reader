"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ConfigError, DEFAULTS, MINIMUMS, PLAIN_SECRET_VARS, liveGate, loadConfig } = require("../../config");
const { API_BASE, LOGIN_URL, TEST_EMAIL, TEST_PASSWORD, tmpDir } = require("./helpers");

function secretFiles() {
  const dir = tmpDir("gwm-reader-secrets-");
  const write = (n, v) => (fs.writeFileSync(path.join(dir, n), v), path.join(dir, n));
  return { dir, user: write("gwm_username", `${TEST_EMAIL}\n`), pass: write("gwm_password", TEST_PASSWORD), mqtt: write("mqtt_password", "mqtt-test-pass\n") };
}

const fixtureEnv = (f, extra = {}) => ({
  GWM_LOGIN_URL: LOGIN_URL,
  GWM_API_BASE: API_BASE,
  GWM_USERNAME_FILE: f.user,
  GWM_PASSWORD_FILE: f.pass,
  MQTT_PASSWORD_FILE: f.mqtt,
  ...extra,
});
const noSecretsDir = tmpDir("gwm-reader-empty-");

test("secrets are read from *_FILE, one trailing newline removed", () => {
  const f = secretFiles();
  const c = loadConfig(fixtureEnv(f), { secretsDir: noSecretsDir });
  assert.equal(c.username, TEST_EMAIL);
  assert.equal(c.password, TEST_PASSWORD);
  assert.equal(c.mqttPassword, "mqtt-test-pass");
  assert.equal(c.mode, "fixture");
});

test("secrets fall back to /run/secrets/<name> (Docker Compose secrets)", () => {
  const f = secretFiles();
  const c = loadConfig({ GWM_LOGIN_URL: LOGIN_URL, GWM_API_BASE: API_BASE }, { secretsDir: f.dir });
  assert.equal(c.username, TEST_EMAIL);
  assert.equal(c.mqttPassword, "mqtt-test-pass");
});

for (const name of PLAIN_SECRET_VARS) {
  test(`a plain ${name} environment variable is refused`, () => {
    const f = secretFiles();
    assert.throws(() => loadConfig(fixtureEnv(f, { [name]: "plain-value" }), { secretsDir: noSecretsDir }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /refusing to start/);
      assert.match(e.message, /_FILE/);
      assert.ok(!e.message.includes("plain-value"), "the value is never echoed");
      return true;
    });
  });
}

test("missing, empty or unreadable secret files are errors without file contents", () => {
  const f = secretFiles();
  assert.throws(() => loadConfig({ GWM_LOGIN_URL: LOGIN_URL, GWM_API_BASE: API_BASE }, { secretsDir: noSecretsDir }), /GWM_USERNAME_FILE/);
  fs.writeFileSync(f.pass, "\n");
  assert.throws(() => loadConfig(fixtureEnv(f), { secretsDir: noSecretsDir }), /GWM_PASSWORD_FILE is empty/);
  assert.throws(() => loadConfig(fixtureEnv(f, { GWM_PASSWORD_FILE: "/nonexistent/x" }), { secretsDir: noSecretsDir }), /GWM_PASSWORD_FILE cannot be read/);
});

test("new defaults: 300 s status, 6 h charge history, GPS off, INFO, /data", () => {
  const c = loadConfig(fixtureEnv(secretFiles()), { secretsDir: noSecretsDir });
  assert.equal(c.refreshTimeS, 300);
  assert.equal(c.chargingHistoryIntervalS, 21600);
  assert.equal(c.deviceTrackerEnabled, false);
  assert.equal(c.logLevel, "INFO");
  assert.equal(c.dataDir, "/data");
  assert.equal(c.mqttUsername, "gwm_reader");
  assert.deepEqual(DEFAULTS, { REFRESH_TIME: 300, CHARGING_HISTORY_INTERVAL: 21600 });
});

test("intervals below the minimum are clamped with a warning; invalid ones are errors", () => {
  const f = secretFiles();
  const c = loadConfig(fixtureEnv(f, { REFRESH_TIME: "30", CHARGING_HISTORY_INTERVAL: "60" }), { secretsDir: noSecretsDir });
  assert.equal(c.refreshTimeS, MINIMUMS.REFRESH_TIME);
  assert.equal(c.refreshTimeS, 60);
  assert.equal(c.chargingHistoryIntervalS, 3600);
  assert.equal(c.warnings.length, 2);
  assert.equal(loadConfig(fixtureEnv(f, { REFRESH_TIME: "60" }), { secretsDir: noSecretsDir }).refreshTimeS, 60);
  for (const bad of ["0", "-5", "abc"]) assert.throws(() => loadConfig(fixtureEnv(f, { REFRESH_TIME: bad }), { secretsDir: noSecretsDir }), ConfigError);
});

test("the live gate: GWM is refused unless GWM_LIVE_ENABLED is exactly true", () => {
  assert.equal(liveGate({}).run, false);
  assert.equal(liveGate({ GWM_LIVE_ENABLED: "1" }).run, false);
  assert.equal(liveGate({ GWM_LIVE_ENABLED: "TRUE" }).run, false);
  assert.deepEqual({ ...liveGate({ GWM_LIVE_ENABLED: "true" }), reason: undefined }, { run: true, mode: "live", liveAllowed: true, reason: undefined });
  assert.equal(liveGate({ GWM_LOGIN_URL: LOGIN_URL, GWM_API_BASE: API_BASE }).mode, "fixture");
  assert.equal(liveGate({ GWM_LOGIN_URL: LOGIN_URL, GWM_API_BASE: API_BASE }).liveAllowed, false);
  // One mock URL plus the real GWM default is not fixture mode.
  assert.equal(liveGate({ GWM_API_BASE: API_BASE }).run, false);
});

test("other settings are validated", () => {
  const f = secretFiles();
  const env = (x) => fixtureEnv(f, x);
  assert.throws(() => loadConfig(env({ VEHICLE_ID: "My Car!" }), { secretsDir: noSecretsDir }), /VEHICLE_ID/);
  assert.throws(() => loadConfig(env({ LOG_LEVEL: "TRACE" }), { secretsDir: noSecretsDir }), /LOG_LEVEL/);
  assert.throws(() => loadConfig(env({ DEVICE_TRACKER_ENABLED: "yes" }), { secretsDir: noSecretsDir }), /DEVICE_TRACKER_ENABLED/);
  assert.throws(() => loadConfig(env({ GWM_CLIENT_CERT_FILE: "/x" }), { secretsDir: noSecretsDir }), /both/);
  assert.throws(() => loadConfig(env({ HTTPS_PROXY: "https://proxy:3128" }), { secretsDir: noSecretsDir }), /http:\/\//);
  assert.throws(() => loadConfig(env({ GWM_API_BASE: "http://br-app-gateway.gwmcloud.com/x" }), { secretsDir: noSecretsDir }), /http/);
  assert.equal(loadConfig(env({ HTTPS_PROXY: "http://squid:3128" }), { secretsDir: noSecretsDir }).proxyUrl, "http://squid:3128/");
});
