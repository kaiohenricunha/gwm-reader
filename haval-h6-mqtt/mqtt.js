"use strict";

// Publish-only MQTT side of gwm-reader.
//
// One persistent connection, QoS 1, with a retained last-will "offline" on
// the availability topic. This module never subscribes: Home Assistant
// discovery is published retained, so the reader does not need to listen to
// homeassistant/status, and there are no command entities (no button,
// switch, lock or select). The VIN never appears in a topic or a payload;
// the vehicle is named by VEHICLE_ID.
//
// Topics (VEHICLE_ID = <id>):
//   gwmbrasil/<id>/availability                 online | offline (retained)
//   gwmbrasil/<id>/<key>/state                  entity state (retained)
//   gwmbrasil/<id>/<key>/attributes             entity attributes
//   gwmbrasil/<id>/snapshot                     raw status snapshot (snapshot.js)
//   homeassistant/<component>/gwmbrasil/<id>_<key>/config   discovery (retained)

const mqtt = require("mqtt");

const { sensorTopics } = require("./map");

const PREFIX = "gwmbrasil";
const VEHICLE_ID = /^[a-z0-9][a-z0-9_]{0,31}$/;

/** slug follows the upstream status keys (carConnector.js:376): no accents, no "()-", words joined by "_". */
function slug(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[()-]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** entitySlug follows the upstream Home Assistant ids (mqtt.js:66): the first "-" becomes "_". */
function entitySlug(name) {
  return slug(String(name).replace("-", "_"));
}

function topics(vehicleId) {
  const base = `${PREFIX}/${vehicleId}`;
  return {
    base,
    availability: `${base}/availability`,
    snapshot: `${base}/snapshot`,
    state: (key) => `${base}/${key}/state`,
    attributes: (key) => `${base}/${key}/attributes`,
    discovery: (component, key) => `homeassistant/${component}/${PREFIX}/${vehicleId}_${key}/config`,
  };
}

const HIDDEN = new Set(["-", " ", "_", "", "None", "null"]);

// Entities that are not in map.js.
const EXTRA_ENTITIES = Object.freeze([
  { key: "hyengsts", component: "sensor", name: "Estado do Motor", icon: "mdi:engine" },
  { key: "model", component: "sensor", name: "Modelo do veículo", icon: "mdi:car-estate" },
  { key: "color", component: "sensor", name: "Cor do veículo", icon: "mdi:palette" },
  { key: "tankcapacity", component: "sensor", name: "Capacidade do tanque", icon: "mdi:gas-station", unit: "L" },
  { key: "enginetype", component: "sensor", name: "Tipo de motor", icon: "mdi:engine" },
  { key: "status_message", component: "sensor", name: "Status Message", icon: "mdi:message-text" },
  { key: "charging_history", component: "sensor", name: "Histórico de carregamento", icon: "mdi:clipboard-text-clock", attributes: true },
  { key: "reader_error", component: "sensor", name: "Erro do leitor", icon: "mdi:alert-circle", attributes: true, category: "diagnostic" },
]);

/** discoveryMessages returns the retained discovery configs for one vehicle. */
function discoveryMessages({ vehicleId, model, trackerEnabled = false }) {
  const t = topics(vehicleId);
  const device = { identifiers: [`${PREFIX}_${vehicleId}`], name: `GWM ${model || vehicleId}`, manufacturer: "GWM", model: model || "BR" };
  const common = { availability_topic: t.availability, payload_available: "online", payload_not_available: "offline", device };
  const out = [];

  const entity = ({ key, component, name, unit, device_class, state_class, icon, attributes, category }) => {
    const id = `${PREFIX}_${vehicleId}_${entitySlug(name)}`;
    const payload = { ...common, unique_id: id, default_entity_id: `${component}.${id}`, name, state_topic: t.state(key) };
    if (icon) payload.icon = icon;
    if (device_class && device_class !== "None") payload.device_class = device_class;
    if (component === "binary_sensor") Object.assign(payload, { payload_on: "1", payload_off: "0" });
    if (component === "sensor" && unit && !HIDDEN.has(unit)) {
      payload.unit_of_measurement = unit;
      if (state_class) payload.state_class = state_class;
    }
    if (attributes) payload.json_attributes_topic = t.attributes(key);
    if (category) payload.entity_category = category;
    out.push({ topic: t.discovery(component, key), payload });
  };

  for (const [code, info] of Object.entries(sensorTopics)) {
    entity({ key: code, component: info.entity_type, name: info.description, unit: info.unit, device_class: info.device_class, state_class: info.state_class, icon: info.icon });
  }
  for (const e of EXTRA_ENTITIES) entity(e);

  if (trackerEnabled) {
    const id = `${PREFIX}_${vehicleId}_location`;
    out.push({
      topic: t.discovery("device_tracker", "location"),
      payload: { ...common, unique_id: id, default_entity_id: `device_tracker.${id}`, name: "Localização", source_type: "gps", json_attributes_topic: t.attributes("location") },
    });
  }
  return out;
}

/**
 * createPublisher opens the single publish-only connection. connect is
 * injectable for tests; the returned object has no subscribe method.
 */
function createPublisher({ url, username, password, vehicleId, log, connect = mqtt.connect, connectTimeoutMs = 30_000 }) {
  if (!VEHICLE_ID.test(vehicleId)) throw new Error("VEHICLE_ID must match ^[a-z0-9][a-z0-9_]{0,31}$");
  const t = topics(vehicleId);
  const stats = { published_total: 0, publish_errors_total: 0 };
  const client = connect(url, {
    username,
    password,
    clientId: `gwm-reader-${vehicleId}`,
    clean: true,
    protocolVersion: 5,
    reconnectPeriod: 5_000,
    connectTimeout: connectTimeoutMs,
    will: { topic: t.availability, payload: Buffer.from("offline"), qos: 1, retain: true },
  });
  client.on("error", (err) => log?.warn("mqtt error", { error_class: "mqtt", message: err?.message }));
  client.on("reconnect", () => log?.debug("mqtt reconnecting"));
  // Re-assert availability on every (re)connection, so a dropped session or
  // a fired will never leaves a stale retained "offline" behind.
  client.on("connect", () => {
    client.publish(t.availability, "online", { qos: 1, retain: true }, (err) => {
      if (err) log?.warn("availability publish failed", { error_class: "mqtt", message: err?.message });
    });
  });

  function ready() {
    if (client.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mqtt connect timed out")), connectTimeoutMs);
      client.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function publish(topic, payload, { retain = false } = {}) {
    const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      client.publish(topic, body, { qos: 1, retain }, (err) => {
        if (err) {
          stats.publish_errors_total += 1;
          reject(err);
        } else {
          stats.published_total += 1;
          resolve();
        }
      });
    });
  }

  function end() {
    return new Promise((resolve) => client.end(false, {}, () => resolve()));
  }

  return { topics: t, ready, publish, end, stats };
}

module.exports = { EXTRA_ENTITIES, PREFIX, VEHICLE_ID, createPublisher, discoveryMessages, entitySlug, slug, topics };
