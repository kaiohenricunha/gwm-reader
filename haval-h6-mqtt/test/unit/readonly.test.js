"use strict";

// Source scan of the production modules: no command, PIN, subscription,
// geocoding, eval or TLS-weakening code exists.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const sources = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") && f !== "eslint.config.js");
const code = (f) =>
  fs
    .readFileSync(path.join(ROOT, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1"); // comments may name what was removed

test("production sources are present", () => {
  for (const f of ["index.js", "carConnector.js", "httpClient.js", "routes.js", "mqtt.js", "reader.js"]) assert.ok(sources.includes(f), f);
});

const FORBIDDEN = [
  [/sendCmd|setChargingPlan|getRemoteCtrlResult|T5\//, "command endpoint"],
  [/securityPassword|\bPIN\b|gwm_pin|GWM_PIN|\bpin\b/i, "PIN handling"],
  [/\.subscribe\s*\(|on\(\s*["']message["']/, "MQTT subscription"],
  [/command_topic|payload_press/, "command entity"],
  [/nominatim|openstreetmap|geocod/i, "reverse geocoding"],
  [/\beval\s*\(|new Function\s*\(/, "eval"],
  [/rejectUnauthorized\s*:\s*false|SECLEVEL|NODE_TLS_REJECT_UNAUTHORIZED/, "TLS weakening"],
  [/require\(["']axios["']\)|require\(["']dotenv["']\)/, "removed dependency"],
];

for (const [re, what] of FORBIDDEN) {
  test(`no ${what} in production code`, () => {
    for (const f of sources) assert.doesNotMatch(code(f), re, `${f}: ${what}`);
  });
}

test("the only non-GET methods in production code are the two allowlisted POSTs", () => {
  const posts = [];
  for (const f of sources) for (const m of code(f).matchAll(/["'](POST|PUT|PATCH|DELETE)["']/g)) posts.push(`${f}:${m[1]}`);
  assert.deepEqual(posts.sort(), ["carConnector.js:POST", "carConnector.js:POST", "routes.js:POST", "routes.js:POST"]);
});
