"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { REDACTED, clearSecrets, createLogger, redact, registerSecret, registerVin } = require("../../logger");
const { TEST_EMAIL, TEST_PASSWORD, TEST_VIN, jwt, memoryLog } = require("./helpers");

const MD5 = "5f4dcc3b5aa765d61d8327deb882cf99";

function sample() {
  const err = new Error(`login failed for ${TEST_EMAIL} token=${jwt()}`);
  err.config = { data: { account: TEST_EMAIL, password: MD5 }, headers: { accessToken: jwt() } };
  return {
    msg: `vehicle ${TEST_VIN} at -10.12345, -30.54321 (masked ${TEST_VIN.slice(0, 5)}*******${TEST_VIN.slice(-5)})`,
    fields: {
      password: TEST_PASSWORD,
      accessToken: jwt(),
      account: TEST_EMAIL,
      note: `user ${TEST_EMAIL} vin fragment ${TEST_VIN.slice(-8)} wmi ${TEST_VIN.slice(0, 11)} lower ${TEST_VIN.toLowerCase()}`,
      latitude: -10.12345,
      position: "-10.1234567",
      md5: MD5,
      error: err,
      nested: { deep: [{ vin: TEST_VIN }, `pw ${TEST_PASSWORD}`] },
    },
  };
}

const SECRET_STRINGS = [TEST_PASSWORD, TEST_EMAIL, TEST_VIN, TEST_VIN.toLowerCase(), TEST_VIN.slice(-8), TEST_VIN.slice(0, 11), MD5, "eyJ", "-10.12345", "-30.54321", "10.1234567"];

for (const level of ["DEBUG", "INFO", "ERROR"]) {
  test(`LOG_LEVEL=${level}: no secret class reaches the output at any emitted level`, () => {
    clearSecrets();
    registerSecret(TEST_PASSWORD);
    registerSecret(TEST_EMAIL);
    registerVin(TEST_VIN);
    const mem = memoryLog();
    const log = createLogger({ level, write: mem.write });
    const { msg, fields } = sample();
    for (const fn of ["debug", "info", "warn", "error"]) log[fn](msg, fields);
    const out = JSON.stringify(mem.lines);
    for (const s of SECRET_STRINGS) assert.ok(!out.includes(s), `${level}: leaked ${s}`);
    assert.ok(mem.lines.length >= 1);
    assert.equal(mem.lines.at(-1).level, "error");
  });
}

test("patterns work even for values that were never registered", () => {
  clearSecrets();
  const out = JSON.stringify(redact({ text: `mail someone@example.org vin ABCDE1234567890XY jwt ${jwt()} hex ${MD5} at 12.345678,-45.678901` }));
  for (const s of ["someone@example.org", "ABCDE1234567890XY", "eyJ", MD5, "12.345678", "-45.678901"]) assert.ok(!out.includes(s), s);
});

test("errors become {error_class, message}; request config and headers are never logged", () => {
  const err = new Error("boom");
  err.config = { headers: { accessToken: "abc" }, data: "secret-body" };
  err.code = "ECONNRESET";
  assert.deepEqual(redact(err), { error_class: "network", message: "boom" });
});

test("ordinary operational values stay readable", () => {
  clearSecrets();
  const out = redact({ items: 12, refresh_time_s: 300, msg: "status published", odometer: 12345, temp: 25.5 });
  assert.deepEqual(out, { items: 12, refresh_time_s: 300, msg: "status published", odometer: 12345, temp: 25.5 });
  assert.equal(REDACTED, "[REDACTED]");
});

test("levels filter as documented", () => {
  const mem = memoryLog();
  const log = createLogger({ level: "ERROR", write: mem.write });
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assert.deepEqual(mem.lines.map((l) => l.msg), ["e"]);
});
