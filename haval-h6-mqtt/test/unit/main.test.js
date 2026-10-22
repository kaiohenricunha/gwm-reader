"use strict";

// Runs the real entry point as a child process.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { tmpDir } = require("./helpers");

const INDEX = path.join(__dirname, "..", "..", "index.js");
const run = (env, args = []) => spawnSync(process.execPath, [INDEX, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 10_000 });

test("a plain GWM_PASSWORD stops the boot with exit 78, even with live mode off", () => {
  const r = run({ GWM_PASSWORD: "plain-value" });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /refusing to start: GWM_PASSWORD/);
  assert.ok(!r.stderr.includes("plain-value"));
});

test("without GWM_LIVE_ENABLED the program exits 0 and contacts nothing", () => {
  const r = run({});
  assert.equal(r.status, 0);
  assert.match(r.stderr, /live mode is disabled/);
});

test("--reset-halt clears the halt flag, even with live mode off, and keeps the login cap", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ halted: { reason: "auth_failed" }, loginAttempts: [1, 2, 3] }));
  const r = run({ DATA_DIR: dir }, ["--reset-halt"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /halt flag cleared/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.halted, undefined);
  assert.deepEqual(state.loginAttempts, [1, 2, 3]);
});
