"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nock = require("nock").default;

const { createHttpClient, tlsOptions, GwmError } = require("../../httpClient");
const { RouteNotAllowed, createRouteGuard } = require("../../routes");
const { DEFAULT_API_BASE, DEFAULT_LOGIN_URL } = require("../../carConnector");
const { createLogger } = require("../../logger");
const { API_BASE, LOGIN_URL, TEST_VIN, memoryLog } = require("./helpers");

test.before(() => nock.disableNetConnect());
test.afterEach(() => nock.cleanAll());
test.after(() => nock.enableNetConnect());

function client({ liveAllowed = false, loginUrl = LOGIN_URL, apiBase = API_BASE } = {}) {
  const mem = memoryLog();
  const log = createLogger({ level: "DEBUG", write: mem.write });
  const http = createHttpClient({ guard: createRouteGuard({ loginUrl, apiBase }), liveAllowed, log });
  return { http, mem };
}

test("a blocked route throws RouteNotAllowed, is logged, and sends nothing", async () => {
  const { http, mem } = client();
  const nominatim = nock("https://nominatim.openstreetmap.org").get(/.*/).reply(200, {});
  const sendCmd = nock("https://gwm-mock.test").post(/.*/).reply(200, {});
  await assert.rejects(http.request("GET", "https://nominatim.openstreetmap.org/reverse?lat=-3.71234&lon=-38.51234"), RouteNotAllowed);
  await assert.rejects(http.request("POST", `${API_BASE}/vehicle/T5/sendCmd`, { body: { vin: TEST_VIN } }), RouteNotAllowed);
  assert.equal(nominatim.isDone(), false);
  assert.equal(sendCmd.isDone(), false);
  const blocked = mem.lines.filter((l) => l.msg === "route blocked");
  assert.equal(blocked.length, 2);
  assert.equal(blocked[0].level, "error");
  assert.equal(blocked[0].host, "nominatim.openstreetmap.org");
  assert.ok(!JSON.stringify(mem.lines).includes("-3.71234"), "coordinates must not be logged");
  assert.equal(http.stats.blocked_total, 2);
  assert.equal(http.stats.requests_total, 0);
});

test("gwmcloud hosts are refused unless live mode is enabled", async () => {
  const { http } = client({ loginUrl: DEFAULT_LOGIN_URL, apiBase: DEFAULT_API_BASE });
  const gwm = nock("https://br-app-gateway.gwmcloud.com").get(/.*/).reply(200, {});
  await assert.rejects(http.request("GET", `${DEFAULT_API_BASE}/globalapp/vehicle/acquireVehicles`), (e) => e instanceof GwmError && e.errorClass === "live_disabled");
  assert.equal(gwm.isDone(), false);
});

test("an allowed request is sent and audited without its query string", async () => {
  const { http, mem } = client();
  nock("https://gwm-mock.test").get("/app-api/api/v1.0/vehicle/getLastStatus").query({ vin: TEST_VIN, flag: "true" }).reply(200, { code: "000000" });
  const res = await http.request("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}&flag=true`);
  assert.equal(res.status, 200);
  const audit = mem.lines.find((l) => l.msg === "route audit");
  assert.deepEqual({ route: audit.route, method: audit.method, host: audit.host, path: audit.path }, {
    route: "getLastStatus",
    method: "GET",
    host: "gwm-mock.test",
    path: "/app-api/api/v1.0/vehicle/getLastStatus",
  });
  assert.ok(!JSON.stringify(mem.lines).includes(TEST_VIN));
});

test("redirects are not followed", async () => {
  const { http } = client();
  const target = nock("https://nominatim.openstreetmap.org").get(/.*/).reply(200, {});
  nock("https://gwm-mock.test").get("/app-api/api/v1.0/globalapp/vehicle/acquireVehicles").reply(302, "", { location: "https://nominatim.openstreetmap.org/reverse" });
  const res = await http.request("GET", `${API_BASE}/globalapp/vehicle/acquireVehicles`);
  assert.equal(res.status, 302);
  assert.equal(target.isDone(), false);
});

test("TLS options always verify and never lower the security level", () => {
  for (const o of [tlsOptions(), tlsOptions({ ca: "x" }), tlsOptions({ cert: "c", key: "k" })]) {
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.ciphers, undefined);
    assert.equal(o.minVersion, "TLSv1.2");
  }
  assert.equal(tlsOptions({ cert: "c" }).cert, undefined, "a certificate without its key is ignored");
});
