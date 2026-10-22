"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Reader, MAX_AUTH_FAILURES, formatChargeLogs, convertValue } = require("../../reader");
const { GwmError } = require("../../httpClient");
const { createLogger } = require("../../logger");
const { TEST_VIN, fakePublisher, memoryLog, memoryStore } = require("./helpers");

const LAT = -3.71234;
const LON = -38.54321;

const STATUS = {
  acquisitionTime: 1760000000000,
  updateTime: "1760000005000",
  hyEngSts: "0",
  latitude: String(LAT),
  longitude: String(LON),
  items: [
    { code: "2103010", value: "12345", unit: "km" },
    { code: "2013021", value: "80", unit: "%" },
    { code: "2101001", value: "250", unit: "kPa" },
    { code: "2310001", value: "1", unit: "" },
  ],
};

function fakeClient({ status = STATUS, fail } = {}) {
  const calls = [];
  return {
    calls,
    acquireVehicles: async () => {
      calls.push("acquireVehicles");
      if (fail) throw fail();
      return [{ vin: TEST_VIN, appShowSeriesName: "HAVAL H6", powerType: "PHEV", color: "GRAY", engineType: "GW4B15D", tankCapacity: 55 }];
    },
    getLastStatus: async () => {
      calls.push("getLastStatus");
      if (fail) throw fail();
      return status;
    },
    getChargeLogs: async () => {
      calls.push("getChargeLogs");
      return [{ startTime: "1760000000000", endTime: "1760003600000" }];
    },
  };
}

const noTimers = { setTimeout: () => 1, clearTimeout: () => {} };

function makeReader({ client = fakeClient(), store = memoryStore(), config = {} } = {}) {
  const publisher = fakePublisher("h6");
  const mem = memoryLog();
  const log = createLogger({ level: "DEBUG", write: mem.write });
  const reader = new Reader({
    config: { vehicleId: "h6", vin: TEST_VIN, refreshTimeS: 300, chargingHistoryIntervalS: 21600, deviceTrackerEnabled: false, mode: "fixture", ...config },
    client,
    publisher,
    store,
    log,
    random: () => 0.5,
    timers: noTimers,
  });
  return { reader, publisher, store, mem, client };
}

const all = (p) => p.messages.map((m) => `${m.topic} ${m.payload}`).join("\n");

test("GPS off: no coordinates and no device_tracker discovery anywhere", async () => {
  const { reader, publisher, mem } = makeReader();
  await reader.start();
  assert.ok((await reader.pollStatus()) > 0);
  const out = all(publisher);
  assert.ok(!out.includes(String(LAT)) && !out.includes(String(LON)), "no coordinates");
  assert.ok(!/latitude|longitude/.test(out));
  assert.ok(!out.includes("device_tracker"));
  assert.ok(!JSON.stringify(mem.lines).includes(String(LAT)));
});

test("GPS on: coordinates go only to the location attributes topic", async () => {
  const { reader, publisher } = makeReader({ config: { deviceTrackerEnabled: true } });
  await reader.pollStatus();
  const withCoords = publisher.messages.filter((m) => m.payload.includes(String(LAT)));
  assert.deepEqual(withCoords.map((m) => m.topic), ["gwmbrasil/h6/location/attributes"]);
  assert.ok(publisher.messages.some((m) => m.topic === "homeassistant/device_tracker/gwmbrasil/h6_location/config"));
});

test("no topic or payload carries the VIN; the snapshot has the source timestamps", async () => {
  const { reader, publisher } = makeReader({ config: { deviceTrackerEnabled: true } });
  await reader.pollStatus();
  const out = all(publisher);
  for (const frag of [TEST_VIN, TEST_VIN.toLowerCase(), TEST_VIN.slice(-8), TEST_VIN.slice(0, 11)]) assert.ok(!out.includes(frag), frag);
  const snap = JSON.parse(publisher.messages.find((m) => m.topic === "gwmbrasil/h6/snapshot").payload);
  assert.equal(snap.schema, "kinestra.mygwm.status.v1");
  assert.equal(snap.acquisition_time, 1760000000000);
  assert.equal(snap.update_time, 1760000005000);
  assert.equal(snap.location, undefined);
  assert.ok(!JSON.stringify(snap).includes(String(LAT)));
});

test("only state, attribute, snapshot, availability and discovery topics are used", async () => {
  const { reader, publisher } = makeReader({ config: { deviceTrackerEnabled: true } });
  await reader.start();
  await reader.pollStatus();
  await reader.pollCharge();
  for (const { topic } of publisher.messages) {
    assert.match(topic, /^(gwmbrasil\/h6\/|homeassistant\/(sensor|binary_sensor|device_tracker)\/gwmbrasil\/h6_)/, topic);
    assert.doesNotMatch(topic, /\/(set|command|press)$/);
  }
  const configs = publisher.messages.filter((m) => m.topic.endsWith("/config"));
  assert.ok(configs.length > 40);
  for (const c of configs) {
    assert.equal(c.retain, true);
    const p = JSON.parse(c.payload);
    assert.equal(p.command_topic, undefined);
  }
});

test("kPa is converted without eval", () => {
  assert.equal(convertValue({ convert: "kpa_to_psi" }, "250"), 36);
  assert.equal(convertValue({ convert: "kpa_to_psi" }, "process.exit()"), "process.exit()");
  assert.equal(convertValue({}, "7"), "7");
});

test(`auth failures back off exponentially, then halt after ${MAX_AUTH_FAILURES} and stay halted`, async () => {
  const store = memoryStore();
  const client = fakeClient({ fail: () => new GwmError("auth", "loginAccount: login rejected", { auth: true }) });
  const { reader, publisher, mem } = makeReader({ client, store });
  const d1 = await reader.pollStatus();
  const d2 = await reader.pollStatus();
  assert.ok(d1 >= 48_000 && d2 > d1, `${d1} < ${d2}`);
  assert.equal(await reader.pollStatus(), null, "halted");
  assert.equal(store.get("halted").reason, "auth_failed");
  const states = publisher.messages.filter((m) => m.topic === "gwmbrasil/h6/reader_error/state").map((m) => m.payload);
  assert.deepEqual(states, ["retrying", "retrying", "halted"]);
  assert.ok(mem.lines.some((l) => l.level === "error" && /halted/.test(l.msg)));

  const callsBefore = client.calls.length;
  assert.equal(await reader.pollStatus(), null);
  assert.equal(client.calls.length, callsBefore, "no request after the halt");

  // A restart with the same store does not poll.
  const again = makeReader({ client, store });
  await again.reader.start();
  assert.equal(again.reader.stopped, true);
  assert.equal(client.calls.length, callsBefore);
  assert.ok(again.publisher.messages.some((m) => m.topic === "gwmbrasil/h6/reader_error/state" && m.payload === "halted"));
});

test("non-auth failures back off but never halt; rate limits wait at least 15 min", async () => {
  const client = fakeClient({ fail: () => new GwmError("http_429", "rate limited", { rateLimited: true }) });
  const { reader } = makeReader({ client });
  for (let i = 0; i < 6; i++) assert.ok((await reader.pollStatus()) >= 15 * 60 * 1000);
  assert.equal(reader.stopped, false);
});

test("a login cap waits until the next slot", async () => {
  const client = fakeClient({ fail: () => new GwmError("login_capped", "capped", { retryAfterMs: 40 * 60 * 1000 }) });
  const { reader } = makeReader({ client });
  assert.ok((await reader.pollStatus()) >= 40 * 60 * 1000);
  assert.equal(reader.authFailures, 0);
});

test("a success after failures clears the error sensor", async () => {
  let failing = true;
  const base = fakeClient();
  const client = { ...base, getLastStatus: async () => { if (failing) throw new GwmError("network", "down"); return STATUS; } };
  const { reader, publisher } = makeReader({ client });
  await reader.pollStatus();
  failing = false;
  await reader.pollStatus();
  const states = publisher.messages.filter((m) => m.topic === "gwmbrasil/h6/reader_error/state").map((m) => m.payload);
  assert.deepEqual(states, ["retrying", "ok"]);
});

test("charge history runs on its own timer at CHARGING_HISTORY_INTERVAL", async () => {
  const scheduled = [];
  const { reader, client, publisher } = makeReader();
  reader.timers = { setTimeout: (fn, ms) => (scheduled.push(ms), scheduled.length), clearTimeout: () => {} };
  await reader.pollStatus();
  assert.deepEqual(scheduled, [30_000], "first charge read is scheduled 30 s after the first status");
  assert.equal(await reader.pollCharge(), 21600 * 1000);
  assert.ok(client.calls.includes("getChargeLogs"));
  const attrs = JSON.parse(publisher.messages.find((m) => m.topic === "gwmbrasil/h6/charging_history/attributes").payload);
  assert.equal(attrs.charging_logs.length, 1);
  assert.match(attrs.charging_logs[0], /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} ~ /);
});

test("formatChargeLogs skips malformed entries", () => {
  assert.deepEqual(formatChargeLogs([null, {}, { startTime: "1" }]), []);
  assert.deepEqual(formatChargeLogs(undefined), []);
});
