"use strict";

// Read-only client for the Brazilian My GWM cloud API.
//
// Ported from the read paths of the upstream carConnector.js (auth,
// getCarList, getCarInfo, getChargingLogs). All command code (sendCmd,
// setChargingPlan, getRemoteCtrlResultT5 and the security code) is removed; the route
// allowlist (routes.js) would block it anyway. See docs/AUDIT.md.

const { createHash, randomBytes } = require("node:crypto");

const { GwmError } = require("./httpClient");
const { LoginLimiter } = require("./backoff");
const { registerSecret, registerVin, unregisterSecret } = require("./logger");

const DEFAULT_LOGIN_URL =
  "https://br-front-service.gwmcloud.com/br-official-commerce/br-official-gateway/pc-api/api/v1.0/userAuth/loginAccount";
const DEFAULT_API_BASE = "https://br-app-gateway.gwmcloud.com/app-api/api/v1.0";

// Upstream login headers (carConnector.js:111-122).
const LOGIN_HEADERS = Object.freeze({
  appid: "6",
  brand: "6",
  brandid: "CCZ001",
  country: "BR",
  devicetype: "0",
  enterpriseid: "CC01",
  gwid: "",
  language: "pt_BR",
  rs: "5",
  terminal: "GW_PC_GWM",
});

// Upstream vehicle API headers (carConnector.js:172-182).
const APP_HEADERS = Object.freeze({
  rs: "2",
  terminal: "GW_APP_GWM",
  brand: "6",
  language: "pt_BR",
  systemtype: "2",
  regioncode: "BR",
  country: "BR",
});

// API codes from the EU API notes (zivillian/ora2mqtt); not verified for Brazil.
const AUTH_CODES = new Set(["550004", "570062"]); // access / refresh token expired
const RATE_LIMIT_CODES = new Set(["308024"]);
const BUSY_CODES = new Set(["550002"]);
const TOKEN_MARGIN_MS = 60_000;
const API_CODE = /^[A-Za-z0-9_-]{1,16}$/;

function md5Hex(s) {
  return createHash("md5").update(String(s)).digest("hex");
}

/** jwtExpiryMs decodes (without verifying) a JWT and returns exp in ms, or null. */
function jwtExpiryMs(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** vehicleModel: series name plus power type unless already included (upstream index.js:120-126). */
function vehicleModel(v) {
  const powerType = String(v?.powerType ?? "").trim();
  const series = String(v?.appShowSeriesName ?? "").trim();
  if (powerType === "") return series;
  return series.toLowerCase().includes(powerType.toLowerCase()) ? series : `${series} ${powerType}`.trim();
}

function tankCapacityL(v) {
  const n = Number(v?.tankCapacity);
  return v?.tankCapacity !== null && v?.tankCapacity !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

/** selectVehicle picks the only vehicle, or the one whose VIN equals the selector. */
function selectVehicle(vehicles, vinSelector) {
  if (!Array.isArray(vehicles) || vehicles.length === 0) throw new GwmError("no_vehicle", "the account has no vehicles");
  if (vinSelector) {
    const want = String(vinSelector).trim().toUpperCase();
    const v = vehicles.find((x) => String(x?.vin ?? "").toUpperCase() === want);
    if (!v) throw new GwmError("config_vehicle", "GWM_VIN does not match any vehicle on the account");
    return v;
  }
  if (vehicles.length > 1) throw new GwmError("config_vehicle", `the account has ${vehicles.length} vehicles; set GWM_VIN`);
  return vehicles[0];
}

class GwmClient {
  constructor({ http, loginUrl = DEFAULT_LOGIN_URL, apiBase = DEFAULT_API_BASE, username, password, store, limiter, log, now = () => Date.now() }) {
    this.http = http;
    this.loginUrl = new URL(loginUrl);
    this.apiBase = String(apiBase).replace(/\/+$/, "");
    this.username = username;
    this.passwordMd5 = md5Hex(password);
    this.store = store;
    this.limiter = limiter || new LoginLimiter({ store, now });
    this.log = log;
    this.now = now;
    this.stats = { logins_total: 0, auth_failures_total: 0, rate_limited_total: 0 };
    registerSecret(username);
    registerSecret(password);
    registerSecret(this.passwordMd5);
    this.accessToken = store?.get("accessToken");
    this.refreshToken = store?.get("refreshToken");
    this.tokenFromLogin = false;
    registerSecret(this.accessToken);
    registerSecret(this.refreshToken);
  }

  deviceId() {
    let id = this.store?.get("deviceid");
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) {
      id = md5Hex(randomBytes(32).toString("hex"));
      this.store?.update({ deviceid: id });
    }
    registerSecret(id);
    return id;
  }

  tokenUsable() {
    if (!this.accessToken) return false;
    const exp = jwtExpiryMs(this.accessToken);
    if (exp === null) return this.tokenFromLogin;
    return exp - this.now() > TOKEN_MARGIN_MS;
  }

  dropToken() {
    unregisterSecret(this.accessToken);
    unregisterSecret(this.refreshToken);
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.tokenFromLogin = false;
    this.store?.update({ accessToken: undefined, refreshToken: undefined });
  }

  /** parse maps the HTTP status and the API envelope to a body or a GwmError. */
  parse(endpoint, { status, text }) {
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    // API codes are short tokens; anything else becomes "invalid", so a hostile
    // value never reaches error classes, logs or retained MQTT (audit run-1).
    const rawCode = body && body.code !== undefined && body.code !== null ? String(body.code) : undefined;
    const apiCode = rawCode === undefined ? undefined : API_CODE.test(rawCode) ? rawCode : "invalid";
    if (status === 429 || (apiCode && RATE_LIMIT_CODES.has(apiCode))) {
      this.stats.rate_limited_total += 1;
      throw new GwmError(status === 429 ? "http_429" : `api_${apiCode}`, `${endpoint}: rate limited`, { status, apiCode, rateLimited: true });
    }
    if (status === 401 || status === 403) throw new GwmError("auth", `${endpoint}: HTTP ${status}`, { status, apiCode, auth: true });
    if (status < 200 || status >= 300) throw new GwmError(`http_${status}`, `${endpoint}: HTTP ${status}`, { status, apiCode });
    if (body === undefined || typeof body !== "object") throw new GwmError("parse", `${endpoint}: response is not a JSON object`, { status });
    if (apiCode && AUTH_CODES.has(apiCode)) throw new GwmError("auth", `${endpoint}: token expired (code ${apiCode})`, { status, apiCode, auth: true });
    return { body, apiCode };
  }

  async login() {
    const slot = this.limiter.tryAcquire();
    if (!slot.ok) {
      throw new GwmError("login_capped", `login capped at ${this.limiter.limit} per hour; next slot in ${Math.ceil(slot.retryAfterMs / 1000)} s`, {
        retryAfterMs: slot.retryAfterMs,
      });
    }
    this.stats.logins_total += 1;
    const body = { deviceid: this.deviceId(), password: this.passwordMd5, account: this.username };
    try {
      const res = await this.http.request("POST", this.loginUrl, { headers: LOGIN_HEADERS, body });
      const { body: out, apiCode } = this.parse("loginAccount", res);
      const data = out.data && typeof out.data === "object" ? out.data : {};
      if (out.description !== "SUCCESS" || typeof data.accessToken !== "string" || data.accessToken === "") {
        if (apiCode && BUSY_CODES.has(apiCode)) throw new GwmError(`api_${apiCode}`, "loginAccount: system busy", { apiCode });
        throw new GwmError("auth", `loginAccount: login rejected${apiCode ? ` (code ${apiCode})` : ""}`, { apiCode, auth: true });
      }
      unregisterSecret(this.accessToken);
      unregisterSecret(this.refreshToken);
      this.accessToken = data.accessToken;
      this.refreshToken = typeof data.refreshToken === "string" ? data.refreshToken : undefined;
      this.tokenFromLogin = true;
      registerSecret(this.accessToken);
      registerSecret(this.refreshToken);
      this.store?.update({ accessToken: this.accessToken, refreshToken: this.refreshToken });
      this.log?.info("login succeeded", { logins_total: this.stats.logins_total });
    } catch (err) {
      if (err instanceof GwmError && err.auth) this.stats.auth_failures_total += 1;
      throw err;
    }
  }

  vehicleRequest(method, path, { query, body, endpoint }) {
    const url = new URL(this.apiBase + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = { ...APP_HEADERS, accessToken: this.accessToken ?? "", refreshToken: this.refreshToken ?? "" };
    return this.http.request(method, url, { headers, body }).then((res) => this.parse(endpoint, res));
  }

  /**
   * authed runs one vehicle call. On a token rejection it logs in once and
   * retries once; further failures go back to the caller, whose backoff
   * spaces the next attempt (see reader.js).
   */
  async authed(method, path, opts) {
    if (!this.tokenUsable()) await this.login();
    try {
      return await this.vehicleRequest(method, path, opts);
    } catch (err) {
      if (!(err instanceof GwmError && err.auth)) throw err;
      this.log?.info("token rejected; logging in again", { endpoint: opts.endpoint, error_class: err.errorClass });
      this.dropToken();
      await this.login();
      try {
        return await this.vehicleRequest(method, path, opts);
      } catch (err2) {
        if (err2 instanceof GwmError && err2.auth) this.stats.auth_failures_total += 1;
        throw err2;
      }
    }
  }

  static requireData(endpoint, body, apiCode) {
    if (body.description !== "SUCCESS" && (body.data === undefined || body.data === null)) {
      if (apiCode && BUSY_CODES.has(apiCode)) throw new GwmError(`api_${apiCode}`, `${endpoint}: system busy`, { apiCode });
      throw new GwmError(`api_${apiCode ?? "unknown"}`, `${endpoint}: request failed`, { apiCode });
    }
    return body.data;
  }

  /** GET /globalapp/vehicle/acquireVehicles -> list of vehicles. */
  async acquireVehicles() {
    const endpoint = "acquireVehicles";
    const { body, apiCode } = await this.authed("GET", "/globalapp/vehicle/acquireVehicles", { endpoint });
    const data = GwmClient.requireData(endpoint, body, apiCode);
    if (!Array.isArray(data)) throw new GwmError("parse", `${endpoint}: data is not a list`);
    for (const v of data) {
      registerVin(v?.vin);
      registerSecret(v?.showedVin);
      registerSecret(v?.imsi);
      registerSecret(v?.simIccid);
      registerSecret(v?.engineNo);
      registerSecret(v?.licenseNumber);
    }
    return data;
  }

  /** GET /vehicle/getLastStatus?vin=<VIN>&flag=true -> status data. */
  async getLastStatus(vin) {
    const endpoint = "getLastStatus";
    const { body, apiCode } = await this.authed("GET", "/vehicle/getLastStatus", {
      endpoint,
      query: { vin: String(vin).toUpperCase(), flag: "true" },
    });
    const data = GwmClient.requireData(endpoint, body, apiCode);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new GwmError("parse", `${endpoint}: data is not an object`);
    return data;
  }

  /** POST /vehicleCharge/getChargeLogs -> data.list (first page of 100). */
  async getChargeLogs(vin) {
    const endpoint = "getChargeLogs";
    const { body, apiCode } = await this.authed("POST", "/vehicleCharge/getChargeLogs", {
      endpoint,
      body: { vin: String(vin).toUpperCase(), pageNum: "1", pageSize: "100", continuation: "0" },
    });
    const data = GwmClient.requireData(endpoint, body, apiCode);
    return data && Array.isArray(data.list) ? data.list : [];
  }
}

module.exports = {
  APP_HEADERS,
  AUTH_CODES,
  DEFAULT_API_BASE,
  DEFAULT_LOGIN_URL,
  GwmClient,
  LOGIN_HEADERS,
  jwtExpiryMs,
  md5Hex,
  selectVehicle,
  tankCapacityL,
  vehicleModel,
};
