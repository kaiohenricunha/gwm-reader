"use strict";

// Raw status snapshot for downstream consumers (for example Kinestra), in
// the kinestra.mygwm.status.v1 shape. It carries the GWM source timestamps.
// It never carries the VIN or any other vehicle identifier, and it never
// carries coordinates, whatever DEVICE_TRACKER_ENABLED says.

const STATUS_SCHEMA = "kinestra.mygwm.status.v1";

/** RFC 3339 UTC without fractional seconds. */
function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** epochMs accepts a number, a numeric string or an ISO string; returns integer ms or null. */
function epochMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n > 0 ? Math.trunc(n) : null;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  return null;
}

function buildSnapshot({ vehicleId, collectedAtMs, status, vehicle, fixture = false }) {
  const s = status && typeof status === "object" ? status : {};
  const items = Array.isArray(s.items) ? s.items : [];
  const payload = {
    schema: STATUS_SCHEMA,
    device: vehicleId,
    collected_at: rfc3339(collectedAtMs),
    acquisition_time: epochMs(s.acquisitionTime),
    update_time: epochMs(s.updateTime),
    upload_time: epochMs(s.uploadTime),
    hy_eng_sts: s.hyEngSts === null || s.hyEngSts === undefined ? null : String(s.hyEngSts),
    vehicle: { model: vehicle?.model ?? "", tank_capacity_l: vehicle?.tankCapacityL ?? null },
    items: items
      .filter((it) => it && typeof it === "object" && it.code !== undefined && it.code !== null)
      .map((it) => ({ code: String(it.code), value: it.value === undefined ? null : it.value, unit: it.unit === undefined ? null : it.unit })),
  };
  if (fixture) payload.fixture = true;
  return payload;
}

module.exports = { STATUS_SCHEMA, buildSnapshot, epochMs, rfc3339 };
