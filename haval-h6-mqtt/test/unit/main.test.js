"use strict";

// Runs the real entry point as a child process.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const INDEX = path.join(__dirname, "..", "..", "index.js");
const run = (env) => spawnSync(process.execPath, [INDEX], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 10_000 });

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
