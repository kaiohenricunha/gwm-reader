"use strict";

// The poll loop. Reads the vehicle status every REFRESH_TIME seconds and the
// charge history every CHARGING_HISTORY_INTERVAL seconds, on separate timers,
// and publishes them to MQTT. It never sends anything to the vehicle.
//
// Session policy (owner requirement):
//   - a rejected token triggers one new login (carConnector.authed);
//   - logins are capped at 3 per rolling hour, kept across restarts;
//   - failures back off exponentially (1 min .. 30 min, 15 min floor when
//     rate limited);
//   - after MAX_AUTH_FAILURES consecutive authentication failures the reader
//     HALTS: it stops polling, publishes the reader_error sensor and waits
//     for the owner (node index.js --reset-halt). The halt is persisted, so a
//     restart does not start a login storm.

const carTextUtil = require("./carTextUtil");
const { selectVehicle, tankCapacityL, vehicleModel } = require("./carConnector");
const { sensorTopics, attributeTopics } = require("./map");
const { discoveryMessages, slug } = require("./mqtt");
const { buildSnapshot } = require("./snapshot");
const { Backoff, MINUTE, SECOND, jittered } = require("./backoff");
const { errorClass, registerVin, safeError } = require("./logger");

const MAX_AUTH_FAILURES = 3;
const CONVERTERS = Object.freeze({
  kpa_to_psi: (v) => Math.floor(parseInt(v, 10) * 0.145038),
});

function convertValue(info, value) {
  const fn = info?.convert ? CONVERTERS[info.convert] : undefined;
  if (!fn || value === null || value === undefined || value === "" || isNaN(value)) return value;
  return fn(value);
}

/** statusBySlug rebuilds the upstream getStatus() shape that carTextUtil expects. */
function statusBySlug(status) {
  const out = {};
  for (const { code, value } of Array.isArray(status?.items) ? status.items : []) {
    const info = sensorTopics[code];
    if (info) out[slug(info.description)] = { ...info, value };
  }
  if (status && Object.prototype.hasOwnProperty.call(status, "hyEngSts")) {
    out.estado_do_motor = { code: "hyEngSts", description: "Estado do Motor", value: `${status.hyEngSts ?? "0"}`, state_on: "1", state_off: "0" };
  }
  return out;
}

/** formatChargeLogs keeps the upstream text format (carConnector.js:420-428). */
function formatChargeLogs(list) {
  const tz = { timeZone: "America/Sao_Paulo" };
  const hm = { ...tz, hour: "2-digit", minute: "2-digit" };
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.startTime !== undefined && x.endTime !== undefined)
    .map(({ startTime, endTime }) => {
      const s = new Date(parseInt(startTime, 10));
      const e = new Date(parseInt(endTime, 10));
      return `${s.toLocaleDateString("pt-BR", tz)} ${s.toLocaleTimeString("pt-BR", hm)} ~ ${e.toLocaleDateString("pt-BR", tz)} ${e.toLocaleTimeString("pt-BR", hm)}`;
    });
}

class Reader {
  constructor({ config, client, publisher, store, log, now = () => Date.now(), random = Math.random, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { config, client, publisher, store, log, now, random, timers });
    this.backoff = new Backoff({ random });
    this.chargeBackoff = new Backoff({ random, base: 10 * MINUTE, max: 6 * 60 * MINUTE });
    this.vehicle = null;
    this.authFailures = 0;
    this.consecutiveFailures = 0;
    this.statusTimer = null;
    this.chargeTimer = null;
    this.chargeStarted = false;
    this.stopped = false;
    this.discoveryDone = false;
    registerVin(config.vin);
  }

  get t() {
    return this.publisher.topics;
  }

  async start() {
    await this.publisher.publish(this.t.availability, "online", { retain: true });
    const halted = this.store.get("halted");
    if (halted) {
      this.stopped = true;
      this.log.error("reader is halted; not polling. Fix the cause, then run: node index.js --reset-halt", { reason: halted.reason, since: halted.since });
      await this.publishReaderError("halted", { reason: halted.reason, since: halted.since });
      return;
    }
    this.scheduleStatus(0);
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    await this.publisher.publish(this.t.availability, "offline", { retain: true }).catch(() => {});
  }

  clearTimers() {
    if (this.statusTimer) this.timers.clearTimeout(this.statusTimer);
    if (this.chargeTimer) this.timers.clearTimeout(this.chargeTimer);
    this.statusTimer = null;
    this.chargeTimer = null;
  }

  scheduleStatus(delayMs) {
    if (this.stopped) return;
    this.statusTimer = this.timers.setTimeout(async () => {
      this.statusTimer = null;
      const next = await this.pollStatus();
      if (next !== null) this.scheduleStatus(next);
    }, delayMs);
  }

  scheduleCharge(delayMs) {
    if (this.stopped) return;
    this.chargeTimer = this.timers.setTimeout(async () => {
      this.chargeTimer = null;
      const next = await this.pollCharge();
      if (next !== null) this.scheduleCharge(next);
    }, delayMs);
  }

  async ensureVehicle() {
    if (this.vehicle) return this.vehicle;
    const list = await this.client.acquireVehicles();
    const v = selectVehicle(list, this.config.vin);
    this.vehicle = {
      vin: String(v.vin).toUpperCase(),
      model: vehicleModel(v),
      color: String(v.color ?? ""),
      engineType: String(v.engineType ?? ""),
      tankCapacityL: tankCapacityL(v),
    };
    registerVin(this.vehicle.vin);
    this.log.info("vehicle selected", { vehicles: list.length, model: this.vehicle.model });
    await this.publishDiscovery();
    return this.vehicle;
  }

  async publishDiscovery() {
    if (this.discoveryDone) return;
    const v = this.vehicle;
    for (const { topic, payload } of discoveryMessages({ vehicleId: this.config.vehicleId, model: v.model, trackerEnabled: this.config.deviceTrackerEnabled })) {
      await this.publisher.publish(topic, payload, { retain: true });
    }
    const statics = { model: v.model, color: v.color, tankcapacity: v.tankCapacityL ?? "", enginetype: v.engineType };
    for (const [key, value] of Object.entries(statics)) await this.publisher.publish(this.t.state(key), String(value), { retain: true });
    this.discoveryDone = true;
  }

  /** pollStatus runs one status cycle and returns the next delay in ms, or null when halted. */
  async pollStatus() {
    if (this.stopped) return null;
    try {
      const vehicle = await this.ensureVehicle();
      const status = await this.client.getLastStatus(vehicle.vin);
      await this.publishStatus(status);
      this.backoff.reset();
      this.authFailures = 0;
      if (this.consecutiveFailures > 0) await this.publishReaderError("ok", {});
      this.consecutiveFailures = 0;
      this.log.info("status published", { items: Array.isArray(status.items) ? status.items.length : 0 });
      if (!this.chargeStarted) {
        this.chargeStarted = true;
        this.scheduleCharge(30 * SECOND);
      }
      return jittered(this.config.refreshTimeS * SECOND, 0.1, this.random);
    } catch (err) {
      return this.onFailure(err);
    }
  }

  async onFailure(err) {
    this.consecutiveFailures += 1;
    const cls = errorClass(err);
    if (err?.auth) this.authFailures += 1;
    if (this.authFailures >= MAX_AUTH_FAILURES) {
      await this.halt("auth_failed", err);
      return null;
    }
    let delay = this.backoff.next({ rateLimited: Boolean(err?.rateLimited) });
    if (err?.retryAfterMs) delay = Math.max(delay, err.retryAfterMs);
    this.log.warn("poll failed", { ...safeError(err), consecutive_failures: this.consecutiveFailures, auth_failures: this.authFailures, retry_in_s: Math.round(delay / 1000) });
    await this.publishReaderError("retrying", { error_class: cls, consecutive_failures: this.consecutiveFailures, retry_in_s: Math.round(delay / 1000) });
    return delay;
  }

  async halt(reason, err) {
    this.stopped = true;
    this.clearTimers();
    const since = new Date(this.now()).toISOString();
    this.store.update({ halted: { reason, since } });
    this.log.error("reader halted after repeated authentication failures; not polling any more. Check the credentials, then run: node index.js --reset-halt", {
      reason,
      auth_failures: this.authFailures,
      ...safeError(err),
    });
    await this.publishReaderError("halted", { reason, since, error_class: errorClass(err) });
  }

  async publishReaderError(state, attributes) {
    try {
      await this.publisher.publish(this.t.state("reader_error"), state, { retain: true });
      await this.publisher.publish(this.t.attributes("reader_error"), { ...attributes, updated_at: new Date(this.now()).toISOString() }, { retain: true });
    } catch (e) {
      this.log.warn("reader_error publish failed", { error: e });
    }
  }

  async publishStatus(status) {
    const id = this.config.vehicleId;
    const snapshot = buildSnapshot({ vehicleId: id, collectedAtMs: this.now(), status, vehicle: this.vehicle, fixture: this.config.mode === "fixture" });
    await this.publisher.publish(this.t.snapshot, snapshot, { retain: false });

    const attributes = {};
    for (const { code, value } of Array.isArray(status.items) ? status.items : []) {
      if (Object.prototype.hasOwnProperty.call(sensorTopics, code)) {
        await this.publisher.publish(this.t.state(code), String(convertValue(sensorTopics[code], value)), { retain: true });
      }
      if (Object.prototype.hasOwnProperty.call(attributeTopics, code)) attributes[slug(attributeTopics[code].description)] = String(value);
    }
    if (Object.prototype.hasOwnProperty.call(status, "hyEngSts")) {
      await this.publisher.publish(this.t.state("hyengsts"), String(status.hyEngSts ?? "0"), { retain: true });
    }
    const message = carTextUtil.getVehicleStatusHardAnalysis(JSON.stringify(statusBySlug(status)));
    if (message) await this.publisher.publish(this.t.state("status_message"), message.replace(/(\r\n|\n|\r)/g, " | "), { retain: true });

    // Coordinates leave the process only when the owner enables the tracker.
    if (this.config.deviceTrackerEnabled) {
      const lat = Number(status.latitude);
      const lon = Number(status.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
        await this.publisher.publish(this.t.attributes("location"), { latitude: lat, longitude: lon, gps_accuracy: 60, ...attributes }, { retain: false });
      }
    }
  }

  /** pollCharge reads the charge history on its own cadence. */
  async pollCharge() {
    if (this.stopped) return null;
    try {
      const vehicle = await this.ensureVehicle();
      const list = formatChargeLogs(await this.client.getChargeLogs(vehicle.vin));
      await this.publisher.publish(this.t.state("charging_history"), String(list.length), { retain: true });
      await this.publisher.publish(this.t.attributes("charging_history"), { charging_logs: list, last_update: new Date(this.now()).toISOString() }, { retain: true });
      this.chargeBackoff.reset();
      this.log.info("charge history published", { records: list.length });
      return this.config.chargingHistoryIntervalS * SECOND;
    } catch (err) {
      if (err?.auth) {
        this.authFailures += 1;
        if (this.authFailures >= MAX_AUTH_FAILURES) {
          await this.halt("auth_failed", err);
          return null;
        }
      }
      let delay = this.chargeBackoff.next({ rateLimited: Boolean(err?.rateLimited) });
      if (err?.retryAfterMs) delay = Math.max(delay, err.retryAfterMs);
      this.log.warn("charge history failed", { ...safeError(err), retry_in_s: Math.round(delay / 1000) });
      return delay;
    }
  }
}

module.exports = { CONVERTERS, MAX_AUTH_FAILURES, Reader, convertValue, formatChargeLogs, statusBySlug };
