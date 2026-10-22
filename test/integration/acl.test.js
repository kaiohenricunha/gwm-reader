"use strict";

// Mosquitto ACL against the real broker configuration (mosquitto/acl).

const test = require("node:test");
const assert = require("node:assert/strict");

const { collect, connect, end, endAll, publish, subscribe } = require("./mqtt-helpers");

const REFUSED = (code) => code >= 128;

test.afterEach(() => endAll());

// Mosquitto 2.1.2's acl_file accepts every SUBSCRIBE
// (plugins/acl-file/acl_check.c:42-45, "FIXME - implement ACL subscription
// strings") and enforces read access when it delivers. So the guarantee
// tested here is: gwm_reader receives NOTHING, whatever it subscribes to.

test("anonymous clients are refused", async () => {
  const mqtt = require("mqtt");
  const c = mqtt.connect(process.env.MQTT_URL || "mqtt://mosquitto:1883", { reconnectPeriod: 0, connectTimeout: 5000 });
  const result = await new Promise((r) => {
    c.once("connect", () => r("connected"));
    c.once("error", (e) => r(e.code ?? e.message));
  });
  c.end(true);
  assert.notEqual(result, "connected");
});

test("gwm_reader receives nothing on any topic, retained or live, even after subscribing", async () => {
  // Seed retained messages first (HA must see them), so an empty result for
  // gwm_reader proves the read rule, not an empty broker.
  const seed = await connect("gwm_reader");
  for (const t of ["gwmbrasil/it_probe/acl/state", "homeassistant/sensor/gwmbrasil/it_probe_acl/config"]) {
    assert.equal(await publish(seed, t, "retained-probe", { retain: true }), "ok");
  }
  await end(seed);
  const ha = await connect("homeassistant");
  const seen = collect(ha, 1500);
  await subscribe(ha, "gwmbrasil/it_probe/#");
  await subscribe(ha, "homeassistant/+/gwmbrasil/#");
  assert.ok((await seen).filter((m) => m.retain && m.payload === "retained-probe").length >= 2, "HA sees the retained probes");
  await end(ha);

  const r = await connect("gwm_reader");
  const pending = collect(r, 3000);
  for (const t of ["#", "gwmbrasil/#", "gwmbrasil/+/+/set", "homeassistant/#", "homeassistant/status", "homeassistant/+/gwmbrasil/#"]) {
    await subscribe(r, t);
  }
  assert.equal(await publish(r, "gwmbrasil/it_probe/acl/state", "x"), "ok");
  assert.equal(await publish(r, "gwmbrasil/h6/2208001/set", "1"), "ok");
  const got = await pending;
  assert.deepEqual(got, [], `delivered to gwm_reader: ${got.map((m) => m.topic).join(", ")}`);
  for (const t of ["gwmbrasil/it_probe/acl/state", "homeassistant/sensor/gwmbrasil/it_probe_acl/config", "gwmbrasil/h6/2208001/set"]) {
    await publish(r, t, "", { retain: true });
  }
  await end(r);
});

test("the broker binds the client id to the username (no session takeover)", async () => {
  const victim = await connect("gwm_reader");
  let victimClosed = false;
  victim.on("close", () => (victimClosed = true));
  // A read-only user presents the reader's id; the broker renames it to its username.
  const mqtt = require("mqtt");
  const fs = require("node:fs");
  const attacker = await new Promise((resolve, reject) => {
    const c = mqtt.connect(process.env.MQTT_URL || "mqtt://mosquitto:1883", {
      username: "kinestra_bridge",
      password: fs.readFileSync(`${process.env.IT_SECRETS || "/it-secrets"}/mqtt_kinestra_bridge_password`, "utf8").trim(),
      clientId: "gwm-reader-h6",
      protocolVersion: 5,
      reconnectPeriod: 0,
    });
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(victimClosed, false, "the gwm_reader session must survive a foreign CONNECT with its id");
  await end(attacker, victim);
});

test("gwm_reader may publish only gwmbrasil/# and homeassistant/+/gwmbrasil/#", async () => {
  const r = await connect("gwm_reader");
  const ha = await connect("homeassistant");
  const pending = collect(ha, 2500);
  assert.equal(REFUSED(await subscribe(ha, "homeassistant/#")), false);
  assert.equal(REFUSED(await subscribe(ha, "gwmbrasil/#")), false);
  assert.equal(await publish(r, "gwmbrasil/it_probe/acl/state", "allowed-state"), "ok");
  assert.equal(await publish(r, "homeassistant/sensor/gwmbrasil/it_probe_acl/config", "allowed-config"), "ok");
  assert.match(await publish(r, "homeassistant/status", "denied-status"), /refused/);
  assert.match(await publish(r, "homeassistant/sensor/other/x/config", "denied-config"), /refused/);
  assert.match(await publish(r, "other/topic", "denied-other"), /refused/);
  const got = (await pending).map((m) => m.payload);
  assert.ok(got.includes("allowed-state") && got.includes("allowed-config"), JSON.stringify(got));
  for (const p of ["denied-status", "denied-config", "denied-other"]) assert.ok(!got.includes(p), `${p} must not be delivered`);
  // Clean the retained probe config, if any.
  await publish(r, "homeassistant/sensor/gwmbrasil/it_probe_acl/config", "", { retain: true });
  await end(r, ha);
});

test("homeassistant can read but never publish", async () => {
  const ha = await connect("homeassistant");
  const pending = collect(ha, 2000);
  await subscribe(ha, "gwmbrasil/#");
  await subscribe(ha, "homeassistant/#");
  for (const t of ["gwmbrasil/it_probe/acl/state", "gwmbrasil/h6/2208001/set", "homeassistant/button/gwmbrasil/h6_x/config"]) {
    assert.match(await publish(ha, t, "from-ha"), /refused/, t);
  }
  assert.ok(!(await pending).some((m) => m.payload === "from-ha"));
  await end(ha);
});

test("kinestra_bridge receives only gwmbrasil/+/snapshot and cannot publish", async () => {
  const r = await connect("gwm_reader");
  const b = await connect("kinestra_bridge");
  const pending = collect(b, 2500);
  assert.equal(REFUSED(await subscribe(b, "gwmbrasil/+/snapshot")), false);
  await subscribe(b, "gwmbrasil/#").catch(() => 128);
  await publish(r, "gwmbrasil/it_probe/snapshot", "snap");
  await publish(r, "gwmbrasil/it_probe/acl/state", "state");
  assert.match(await publish(b, "gwmbrasil/it_probe/snapshot", "from-bridge"), /refused/);
  const got = await pending;
  assert.deepEqual([...new Set(got.map((m) => `${m.topic} ${m.payload}`))], ["gwmbrasil/it_probe/snapshot snap"]);
  await end(r, b);
});
