"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ROUTES, RouteNotAllowed, createRouteGuard } = require("../../routes");
const { API_BASE, LOGIN_URL, TEST_VIN } = require("./helpers");

const guard = createRouteGuard({ loginUrl: LOGIN_URL, apiBase: API_BASE });
const HEX = "0123456789abcdef0123456789abcdef";
const chargeBody = () => ({ vin: TEST_VIN, pageNum: "1", pageSize: "100", continuation: "0" });
const blocked = (fn) => assert.throws(fn, RouteNotAllowed);

test("the allowlist has exactly four routes and only login and getChargeLogs are POST", () => {
  assert.deepEqual(ROUTES.map((r) => `${r.method} ${r.name}`).sort(), ["GET acquireVehicles", "GET getLastStatus", "POST getChargeLogs", "POST loginAccount"]);
});

test("allowed read routes pass", () => {
  assert.equal(guard.check("POST", LOGIN_URL, { deviceid: HEX, password: HEX, account: "owner@example.invalid" }), "loginAccount");
  assert.equal(guard.check("GET", `${API_BASE}/globalapp/vehicle/acquireVehicles`), "acquireVehicles");
  assert.equal(guard.check("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}&flag=true`), "getLastStatus");
  assert.equal(guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, chargeBody()), "getChargeLogs");
});

test("command routes are not reachable", () => {
  blocked(() => guard.check("POST", `${API_BASE}/vehicle/T5/sendCmd`, { instructions: {}, vin: TEST_VIN }));
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/setChargingPlan?vin=${TEST_VIN}`, { enable: true }));
  blocked(() => guard.check("GET", `${API_BASE}/vehicle/getRemoteCtrlResultT5?seqNo=1&vin=${TEST_VIN}`));
  blocked(() => guard.check("POST", `${API_BASE}/vehicle/security/pin`, { pin: "1234" }));
});

test("non-GET methods are blocked on read routes, and every other method everywhere", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    blocked(() => guard.check(m, `${API_BASE}/globalapp/vehicle/acquireVehicles`, m === "POST" ? {} : undefined));
  }
  for (const m of ["GET", "PUT", "DELETE"]) blocked(() => guard.check(m, LOGIN_URL));
  blocked(() => guard.check("GET", `${API_BASE}/vehicleCharge/getChargeLogs`));
});

test("Nominatim and every other host are blocked", () => {
  blocked(() => guard.check("GET", "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=-10.1&lon=-30.5"));
  blocked(() => guard.check("GET", "https://evil.example/app-api/api/v1.0/globalapp/vehicle/acquireVehicles"));
  blocked(() => guard.check("GET", "http://gwm-mock.test/app-api/api/v1.0/globalapp/vehicle/acquireVehicles"));
  blocked(() => guard.check("GET", "https://gwm-mock.test:8443/app-api/api/v1.0/globalapp/vehicle/acquireVehicles"));
});

test("getChargeLogs: the exact body passes; extra, missing or changed fields are rejected", () => {
  assert.equal(guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, chargeBody()), "getChargeLogs");
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, { ...chargeBody(), enable: true }));
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, { ...chargeBody(), securityPassword: HEX }));
  const missing = chargeBody();
  delete missing.continuation;
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, missing));
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, { ...chargeBody(), pageSize: "1000" }));
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`, { ...chargeBody(), vin: 123 }));
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs?vin=${TEST_VIN}`, chargeBody()));
  blocked(() => guard.check("POST", `${API_BASE}/vehicleCharge/getChargeLogs`));
});

test("login body must be exactly deviceid, MD5 password and account", () => {
  blocked(() => guard.check("POST", LOGIN_URL, { deviceid: HEX, password: "plain-text", account: "a@b.c" }));
  blocked(() => guard.check("POST", LOGIN_URL, { deviceid: HEX, password: HEX, account: "a@b.c", pin: "1234" }));
  blocked(() => guard.check("POST", LOGIN_URL, { deviceid: HEX, password: HEX }));
});

test("query strings are pinned", () => {
  blocked(() => guard.check("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}&flag=true&cmd=1`));
  blocked(() => guard.check("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}`));
  blocked(() => guard.check("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}&flag=false`));
  blocked(() => guard.check("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}&vin=${TEST_VIN}&flag=true`));
  blocked(() => guard.check("GET", `${API_BASE}/globalapp/vehicle/acquireVehicles?x=1`));
  blocked(() => guard.check("GET", `${API_BASE}/vehicle/getLastStatus?vin=${TEST_VIN}&flag=true`, {}));
});
