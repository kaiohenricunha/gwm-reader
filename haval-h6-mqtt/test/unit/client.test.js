"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nock = require("nock").default;

const { GwmClient, md5Hex } = require("../../carConnector");
const { createHttpClient } = require("../../httpClient");
const { createRouteGuard } = require("../../routes");
const { LoginLimiter } = require("../../backoff");
const { createLogger } = require("../../logger");
const { API_BASE, LOGIN_URL, TEST_EMAIL, TEST_PASSWORD, TEST_VIN, jwt, memoryLog, memoryStore } = require("./helpers");

const MOCK = "https://gwm-mock.test";
const LOGIN_PATH = "/br-official-gateway/pc-api/api/v1.0/userAuth/loginAccount";
const API = "/app-api/api/v1.0";

test.before(() => nock.disableNetConnect());
test.afterEach(() => nock.cleanAll());
test.after(() => nock.enableNetConnect());

function makeClient({ store = memoryStore(), now = () => Date.now(), limiter } = {}) {
  const mem = memoryLog();
  const log = createLogger({ level: "DEBUG", write: mem.write });
  const http = createHttpClient({ guard: createRouteGuard({ loginUrl: LOGIN_URL, apiBase: API_BASE }), log });
  const client = new GwmClient({ http, loginUrl: LOGIN_URL, apiBase: API_BASE, username: TEST_EMAIL, password: TEST_PASSWORD, store, log, now, limiter });
  return { client, store, mem, http };
}

const loginOk = (token = jwt()) => ({ code: "000000", description: "SUCCESS", data: { accessToken: token, refreshToken: "refresh-token-value" } });

test("login sends the MD5 of the password, never the password", async () => {
  const { client, mem } = makeClient();
  let sent;
  nock(MOCK).post(LOGIN_PATH, (b) => ((sent = b), true)).reply(200, loginOk());
  await client.login();
  assert.deepEqual(Object.keys(sent).sort(), ["account", "deviceid", "password"]);
  assert.equal(sent.password, md5Hex(TEST_PASSWORD));
  assert.ok(!JSON.stringify(mem.lines).includes(TEST_PASSWORD));
  assert.ok(!JSON.stringify(mem.lines).includes(md5Hex(TEST_PASSWORD)));
});

test("getChargeLogs posts exactly the pinned body", async () => {
  const { client } = makeClient({ store: memoryStore({ accessToken: jwt() }) });
  let sent;
  nock(MOCK).post(`${API}/vehicleCharge/getChargeLogs`, (b) => ((sent = b), true)).reply(200, { code: "000000", description: "SUCCESS", data: { list: [] } });
  await client.getChargeLogs(TEST_VIN.toLowerCase());
  assert.deepEqual(sent, { vin: TEST_VIN, pageNum: "1", pageSize: "100", continuation: "0" });
});

test("a 401 on a read triggers exactly one new login and one retry", async () => {
  const { client } = makeClient({ store: memoryStore({ accessToken: jwt() }) });
  const status = { code: "000000", description: "SUCCESS", data: { items: [] } };
  nock(MOCK).get(`${API}/vehicle/getLastStatus`).query(true).reply(401, {});
  const login = nock(MOCK).post(LOGIN_PATH).reply(200, loginOk());
  nock(MOCK).get(`${API}/vehicle/getLastStatus`).query(true).reply(200, status);
  const data = await client.getLastStatus(TEST_VIN);
  assert.deepEqual(data, { items: [] });
  assert.ok(login.isDone());
  assert.equal(client.stats.logins_total, 1);
});

test("an expired-token API code is treated like a 401", async () => {
  const { client } = makeClient({ store: memoryStore({ accessToken: jwt() }) });
  nock(MOCK).get(`${API}/globalapp/vehicle/acquireVehicles`).reply(200, { code: "550004", description: "token expired" });
  nock(MOCK).post(LOGIN_PATH).reply(200, loginOk());
  nock(MOCK).get(`${API}/globalapp/vehicle/acquireVehicles`).reply(200, { code: "000000", description: "SUCCESS", data: [] });
  assert.deepEqual(await client.acquireVehicles(), []);
});

test("logins are capped at 3 per hour, and the cap survives a restart", async () => {
  let t = 1_000_000;
  const now = () => t;
  const store = memoryStore();
  const { client } = makeClient({ store, now });
  nock(MOCK).post(LOGIN_PATH).times(3).reply(200, { code: "1", description: "FAILED" });
  for (let i = 0; i < 3; i++) await assert.rejects(client.login(), (e) => e.auth === true);
  await assert.rejects(client.login(), (e) => e.errorClass === "login_capped" && e.retryAfterMs > 0);

  // A new process with the same store is still capped.
  const restarted = makeClient({ store, now }).client;
  await assert.rejects(restarted.login(), (e) => e.errorClass === "login_capped");

  t += 60 * 60 * 1000 + 1;
  nock(MOCK).post(LOGIN_PATH).reply(200, loginOk(jwt(3600, t)));
  await restarted.login();
});

test("rate limiting is reported as rateLimited", async () => {
  const { client } = makeClient({ store: memoryStore({ accessToken: jwt() }) });
  nock(MOCK).get(`${API}/globalapp/vehicle/acquireVehicles`).reply(429, {});
  await assert.rejects(client.acquireVehicles(), (e) => e.rateLimited === true);
});

test("LoginLimiter ignores corrupt saved attempts", () => {
  const l = new LoginLimiter({ store: memoryStore({ loginAttempts: ["x", null, 5] }), now: () => 10 });
  assert.deepEqual(l.attempts, [5]);
});

test("an oversized or odd API code becomes 'invalid' before it reaches error classes", async () => {
  const { client } = makeClient({ store: memoryStore({ accessToken: jwt() }) });
  nock(MOCK).get(`${API}/vehicle/getLastStatus`).query(true).reply(200, { code: "a".repeat(100000), description: "FAIL", data: null });
  await assert.rejects(client.getLastStatus(TEST_VIN), (e) => e.errorClass === "api_invalid" && e.apiCode === "invalid");
  nock(MOCK).get(`${API}/vehicle/getLastStatus`).query(true).reply(200, { code: "99999<img src=x>", description: "FAIL", data: null });
  await assert.rejects(client.getLastStatus(TEST_VIN), (e) => e.errorClass === "api_invalid");
  nock(MOCK).get(`${API}/vehicle/getLastStatus`).query(true).reply(200, { code: "308024", description: "busy" });
  await assert.rejects(client.getLastStatus(TEST_VIN), (e) => e.rateLimited === true, "known short codes still work");
});
