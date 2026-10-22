"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPublisher, discoveryMessages, entitySlug, slug } = require("../../mqtt");

test("entity ids match the upstream Home Assistant ids, with VEHICLE_ID instead of the VIN", () => {
  const ids = discoveryMessages({ vehicleId: "h6", model: "HAVAL H6 PHEV" }).map((m) => m.payload.default_entity_id);
  for (const want of [
    "binary_sensor.gwmbrasil_h6_porta_malas",
    "sensor.gwmbrasil_h6_estado_de_carga_soc",
    "sensor.gwmbrasil_h6_quilometragem_total",
    "sensor.gwmbrasil_h6_nivel_de_combustivel",
    "sensor.gwmbrasil_h6_pressao_do_pneu_dianteiro_direito",
    "sensor.gwmbrasil_h6_estado_do_motor",
    "sensor.gwmbrasil_h6_historico_de_carregamento",
  ]) {
    assert.ok(ids.includes(want), want);
  }
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("status keys keep the upstream carTextUtil names", () => {
  assert.equal(slug("Porta-Malas"), "portamalas");
  assert.equal(slug("Estado de Carga (SoC)"), "estado_de_carga_soc");
  assert.equal(entitySlug("Porta-Malas"), "porta_malas");
});

test("the publisher sets a retained offline will, connects as the configured user, and has no subscribe", () => {
  let opts;
  const fake = { connected: true, on() {}, once() {}, publish: (t, p, o, cb) => cb(), end: (_f, _o, cb) => cb() };
  const pub = createPublisher({ url: "mqtt://x", username: "gwm_reader", password: "p", vehicleId: "h6", connect: (_u, o) => ((opts = o), fake) });
  assert.deepEqual({ ...opts.will, payload: opts.will.payload.toString() }, { topic: "gwmbrasil/h6/availability", payload: "offline", qos: 1, retain: true });
  assert.equal(opts.username, "gwm_reader");
  assert.equal(pub.subscribe, undefined);
  assert.throws(() => createPublisher({ url: "mqtt://x", vehicleId: "Bad Id", connect: () => fake }), /VEHICLE_ID/);
});

test("every (re)connect re-publishes availability online, retained", () => {
  const handlers = {};
  const published = [];
  const fake = {
    connected: true,
    on: (ev, fn) => (handlers[ev] = fn),
    once() {},
    publish: (t, p, o, cb) => (published.push({ t, p: String(p), retain: o.retain, qos: o.qos }), cb && cb()),
    end: (_f, _o, cb) => cb(),
  };
  createPublisher({ url: "mqtt://x", username: "gwm_reader", password: "p", vehicleId: "h6", connect: () => fake });
  assert.equal(typeof handlers.connect, "function");
  handlers.connect();
  handlers.connect();
  assert.deepEqual(published, [
    { t: "gwmbrasil/h6/availability", p: "online", retain: true, qos: 1 },
    { t: "gwmbrasil/h6/availability", p: "online", retain: true, qos: 1 },
  ]);
});
