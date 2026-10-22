"use strict";

const fs = require("node:fs");
const mqtt = require("mqtt");

const URL = process.env.MQTT_URL || "mqtt://mosquitto:1883";
const SECRETS = process.env.IT_SECRETS || "/it-secrets";

function password(user) {
  return fs.readFileSync(`${SECRETS}/mqtt_${user}_password`, "utf8").trim();
}

let n = 0;
const open = new Set();

function connect(user, { protocolVersion = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(URL, { username: user, password: password(user), clientId: `it-${user}-${process.pid}-${n++}`, protocolVersion, reconnectPeriod: 0, connectTimeout: 10_000 });
    open.add(c);
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });
}

/** endAll closes every client, so a failed assertion never keeps the process alive. */
function endAll() {
  const cs = [...open];
  open.clear();
  return Promise.all(cs.map((c) => new Promise((r) => c.end(true, {}, r))));
}

/** subscribe resolves with the granted reason code (>= 128 means refused). */
function subscribe(c, topic) {
  return new Promise((resolve, reject) => c.subscribe(topic, { qos: 1 }, (err, granted) => (err ? reject(err) : resolve(granted[0].qos))));
}

/** publish resolves "ok" or the error message of a refused QoS 1 publish. */
function publish(c, topic, payload, opts = {}) {
  return new Promise((resolve) => c.publish(topic, payload, { qos: 1, ...opts }, (err) => resolve(err ? `refused: ${err.message}` : "ok")));
}

/** collect gathers messages for `ms` milliseconds. */
function collect(c, ms) {
  const got = [];
  const on = (topic, payload, packet) => got.push({ topic, payload: payload.toString(), retain: packet.retain });
  c.on("message", on);
  return new Promise((resolve) => setTimeout(() => (c.removeListener("message", on), resolve(got)), ms));
}

/** subscribeAndCollect attaches the listener first, so retained messages are not lost. */
async function subscribeAndCollect(c, topics, ms) {
  const pending = collect(c, ms);
  for (const t of topics) await subscribe(c, t);
  return pending;
}

/** nextMessage resolves with the first message, or rejects after ms. */
function nextMessage(c, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (c.removeListener("message", on), reject(new Error(`no message within ${ms} ms`))), ms);
    const on = (topic, payload) => {
      clearTimeout(timer);
      c.removeListener("message", on);
      resolve({ topic, payload: payload.toString() });
    };
    c.on("message", on);
  });
}

const end = (...cs) => Promise.all(cs.map((c) => (open.delete(c), new Promise((r) => c.end(true, {}, r)))));

module.exports = { collect, connect, end, endAll, nextMessage, publish, subscribe, subscribeAndCollect };
