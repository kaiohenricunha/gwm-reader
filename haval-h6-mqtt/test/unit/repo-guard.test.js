"use strict";

// Guards for the upstream merge procedure (README "Update from upstream",
// audit run-1 upstream-sync lead): an upstream merge must not bring back a
// workflow, write permissions, or the HA add-on packaging, and no other
// module may open network connections around the route allowlist.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..", "..");
const APP = path.join(REPO, "haval-h6-mqtt");

test("the only workflow is ci.yml, and it is read-only", () => {
  const workflows = fs.readdirSync(path.join(REPO, ".github", "workflows")).sort();
  assert.deepEqual(workflows, ["ci.yml"], "an upstream merge added or kept a workflow: review and delete it");
  const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /^permissions:\n {2}contents: read\n/m, "top-level permissions must be contents: read");
  assert.equal((ci.match(/^\s*permissions:/gm) || []).length, 1, "no job may widen permissions");
  assert.doesNotMatch(ci, /: *write\b/, "no write scope anywhere in ci.yml");
  assert.doesNotMatch(ci, /\$\{\{\s*secrets\.|pull_request_target|docker\/login-action|build-push-action/);
});

test("the HA add-on packaging and the upstream certificates stay deleted", () => {
  for (const p of ["repository.json", "haval-h6-mqtt/config.json", "haval-h6-mqtt/build.yaml", "haval-h6-mqtt/run.sh", "haval-h6-mqtt/Dockerfile", "haval-h6-mqtt/translations", "haval-h6-mqtt/certs"]) {
    assert.equal(fs.existsSync(path.join(REPO, p)), false, `${p} is back after an upstream merge: delete it again`);
  }
});

test("only httpClient.js opens network connections, and nothing uses fetch", () => {
  const offenders = [];
  for (const f of fs.readdirSync(APP).filter((x) => x.endsWith(".js") && x !== "eslint.config.js")) {
    const src = fs.readFileSync(path.join(APP, f), "utf8");
    if (f !== "httpClient.js" && /require\(["'](node:)?(http|https|tls|net|http2|dgram)["']\)/.test(src)) offenders.push(`${f}: network module`);
    if (/\bfetch\s*\(|undici|XMLHttpRequest|WebSocket\(/.test(src)) offenders.push(`${f}: fetch-like API`);
  }
  assert.deepEqual(offenders, []);
});
