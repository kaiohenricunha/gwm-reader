"use strict";

// Route allowlist: the only HTTP requests this program can send.
//
// Every request goes through check() before a socket is opened. A request
// that does not match one route exactly (method, origin, path, query keys
// and body fields) throws RouteNotAllowed. There are no command routes:
// sendCmd, setChargingPlan, getRemoteCtrlResultT5 and every third-party host
// (for example Nominatim) are rejected by construction.
//
// When you merge a new upstream release, add a route here only for a new
// READ endpoint, and only with its exact body fields (see README.md).

const HEX32 = /^[a-f0-9]{32}$/;

const ROUTES = Object.freeze([
  {
    name: "loginAccount",
    method: "POST",
    base: "login",
    path: "",
    query: {},
    body: {
      deviceid: (v) => HEX32.test(v),
      password: (v) => HEX32.test(v), // MD5 of the password, never the password itself
      account: (v) => v.length > 0,
    },
  },
  {
    name: "acquireVehicles",
    method: "GET",
    base: "api",
    path: "/globalapp/vehicle/acquireVehicles",
    query: {},
    body: null,
  },
  {
    name: "getLastStatus",
    method: "GET",
    base: "api",
    path: "/vehicle/getLastStatus",
    query: { vin: (v) => /^[A-Z0-9]{17}$/.test(v), flag: (v) => v === "true" },
    body: null,
  },
  {
    // POST in the upstream API, but it only reads the charge history.
    // The body is pinned to the query fields upstream sends.
    name: "getChargeLogs",
    method: "POST",
    base: "api",
    path: "/vehicleCharge/getChargeLogs",
    query: {},
    body: {
      vin: (v) => /^[A-Z0-9]{17}$/.test(v),
      pageNum: (v) => v === "1",
      pageSize: (v) => v === "100",
      continuation: (v) => v === "0",
    },
  },
]);

class RouteNotAllowed extends Error {
  constructor(reason, { method, host, path } = {}) {
    super(`request blocked by the route allowlist: ${reason}`);
    this.name = "RouteNotAllowed";
    this.errorClass = "route_not_allowed";
    this.method = method;
    this.host = host;
    this.path = path;
  }
}

function sameKeys(obj, allowed) {
  const keys = Object.keys(obj).sort();
  const want = Object.keys(allowed).sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i]);
}

function checkFields(kind, values, allowed, info) {
  if (!sameKeys(values, allowed)) {
    throw new RouteNotAllowed(`${info.route}: ${kind} fields must be exactly [${Object.keys(allowed).join(", ")}]`, info);
  }
  for (const [k, ok] of Object.entries(allowed)) {
    const v = values[k];
    if (typeof v !== "string" || !ok(v)) {
      throw new RouteNotAllowed(`${info.route}: ${kind} field "${k}" has an unexpected value`, info);
    }
  }
}

/**
 * createRouteGuard binds the allowlist to the configured login URL and API
 * base, so the same rules apply to GWM and to the local mock.
 */
function createRouteGuard({ loginUrl, apiBase }) {
  const login = new URL(loginUrl);
  const api = new URL(String(apiBase).replace(/\/+$/, ""));
  const bases = {
    login: { origin: login.origin, prefix: login.pathname },
    api: { origin: api.origin, prefix: api.pathname.replace(/\/+$/, "") },
  };

  function check(method, url, body) {
    const u = url instanceof URL ? url : new URL(url);
    const m = String(method).toUpperCase();
    const info = { method: m, host: u.host, path: u.pathname };
    if (u.username || u.password || u.hash) throw new RouteNotAllowed("credentials or fragments in the URL", info);

    const route = ROUTES.find((r) => {
      const b = bases[r.base];
      return r.method === m && u.origin === b.origin && u.pathname === b.prefix + r.path;
    });
    if (!route) throw new RouteNotAllowed(`${m} ${u.host}${u.pathname} is not an allowed route`, info);
    info.route = route.name;

    const query = {};
    for (const [k, v] of u.searchParams) {
      if (k in query) throw new RouteNotAllowed(`${route.name}: repeated query field "${k}"`, info);
      query[k] = v;
    }
    checkFields("query", query, route.query, info);

    if (route.body === null) {
      if (body !== undefined) throw new RouteNotAllowed(`${route.name}: a body is not allowed`, info);
    } else {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new RouteNotAllowed(`${route.name}: a JSON object body is required`, info);
      }
      checkFields("body", body, route.body, info);
    }
    return route.name;
  }

  return { check };
}

module.exports = { ROUTES, RouteNotAllowed, createRouteGuard };
