"use strict";

// The real reader in fixture mode: mock GWM -> squid -> gwm-reader ->
// mosquitto, observed as Home Assistant and as the Kinestra bridge.

const test = require("node:test");
const assert = require("node:assert/strict");

const { connect, end, nextMessage, subscribe, subscribeAndCollect } = require("./mqtt-helpers");

const VIN = "TESTVIN9XK2PQ7RZ4";
const FORBIDDEN = [VIN, VIN.toLowerCase(), VIN.slice(-8), VIN.slice(0, 11), "TESTV*******7RZ4", "000000000000000", "owner@example.invalid", "-10.123456", "-30.654321"];

let ha;
let retained;

test.before(async () => {
  ha = await connect("homeassistant");
  retained = await subscribeAndCollect(ha, ["gwmbrasil/h6/#", "homeassistant/+/gwmbrasil/#"], 3000);
});
test.after(() => end(ha));

const state = (key) => retained.find((m) => m.topic === `gwmbrasil/h6/${key}/state`)?.payload;

test("the reader is online and published retained discovery without command entities", () => {
  assert.equal(retained.find((m) => m.topic === "gwmbrasil/h6/availability")?.payload, "online");
  const configs = retained.filter((m) => m.topic.endsWith("/config"));
  assert.ok(configs.length >= 48, `discovery configs: ${configs.length}`);
  for (const c of configs) {
    assert.match(c.topic, /^homeassistant\/(sensor|binary_sensor)\/gwmbrasil\/h6_[a-z0-9_]+\/config$/, c.topic);
    const p = JSON.parse(c.payload);
    assert.equal(p.command_topic, undefined, c.topic);
    assert.equal(p.availability_topic, "gwmbrasil/h6/availability");
  }
  assert.ok(!configs.some((c) => c.topic.includes("device_tracker")), "GPS is off by default");
});

test("vehicle states match the mock", () => {
  assert.equal(state("2103010"), "12345");
  assert.equal(state("2013021"), "80");
  assert.equal(state("2101001"), "36", "kPa converted to psi");
  assert.equal(state("model"), "HAVAL H6 PHEV");
  assert.ok(state("status_message"));
});

test("no VIN, IMSI, e-mail or coordinates reach the broker", () => {
  const all = retained.map((m) => `${m.topic} ${m.payload}`).join("\n");
  for (const f of FORBIDDEN) assert.ok(!all.includes(f), f);
  assert.ok(!/latitude|longitude/.test(all));
});

test("the bridge receives a snapshot with source timestamps and no identifiers", { timeout: 120_000 }, async () => {
  const b = await connect("kinestra_bridge");
  const next = nextMessage(b, 100_000); // REFRESH_TIME=60 s plus jitter
  await subscribe(b, "gwmbrasil/+/snapshot");
  const snap = await next.finally(() => end(b));
  assert.equal(snap.topic, "gwmbrasil/h6/snapshot");
  const s = JSON.parse(snap.payload);
  assert.equal(s.schema, "kinestra.mygwm.status.v1");
  assert.equal(s.device, "h6");
  assert.equal(s.fixture, true);
  assert.ok(Number.isInteger(s.acquisition_time) && s.acquisition_time > 0);
  assert.equal(s.items.length, 10);
  for (const f of FORBIDDEN) assert.ok(!snap.payload.includes(f), f);
});

test("charge history arrives on its own timer", { timeout: 60_000 }, async () => {
  const c = await connect("homeassistant");
  let got = await subscribeAndCollect(c, ["gwmbrasil/h6/charging_history/#"], 2000);
  for (let i = 0; i < 20 && !got.some((m) => m.topic.endsWith("/state")); i++) got = got.concat(await subscribeAndCollect(c, [], 2000));
  await end(c);
  assert.equal(got.find((m) => m.topic.endsWith("/state"))?.payload, "2");
  const attrs = JSON.parse(got.find((m) => m.topic.endsWith("/attributes")).payload);
  assert.equal(attrs.charging_logs.length, 2);
});
