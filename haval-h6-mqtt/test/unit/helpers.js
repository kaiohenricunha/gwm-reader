"use strict";

// Shared test helpers. Every value here is fictitious.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TEST_VIN = "TESTVIN9XK2PQ7RZ4";
const TEST_EMAIL = "owner@example.invalid";
const TEST_PASSWORD = "not-a-real-password";
const LOGIN_URL = "https://gwm-mock.test/br-official-gateway/pc-api/api/v1.0/userAuth/loginAccount";
const API_BASE = "https://gwm-mock.test/app-api/api/v1.0";

function tmpDir(prefix = "gwm-reader-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** jwt returns an unsigned JWT-shaped token that expires in `secondsAhead`. */
function jwt(secondsAhead = 3600, now = Date.now()) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(now / 1000) + secondsAhead, sub: "test" })}.sig`;
}

function memoryLog() {
  const lines = [];
  const write = (line) => lines.push(JSON.parse(line));
  return { lines, write };
}

/** memoryStore is a Store stand-in. */
function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k) => data[k],
    update(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete data[k];
        else data[k] = v;
      }
    },
  };
}

/** fakePublisher records every publish; it has no subscribe method. */
function fakePublisher(vehicleId = "h6") {
  const { topics } = require("../../mqtt");
  const messages = [];
  return {
    topics: topics(vehicleId),
    messages,
    publish: async (topic, payload, opts = {}) => {
      messages.push({ topic, payload: typeof payload === "string" ? payload : JSON.stringify(payload), retain: Boolean(opts.retain) });
    },
    ready: async () => {},
    end: async () => {},
  };
}

/**
 * makeTestPki creates a throwaway CA and a server certificate for
 * `hostname` with openssl, in a temp dir. Nothing is committed.
 */
function makeTestPki(hostname = "localhost") {
  const dir = tmpDir("gwm-reader-pki-");
  const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=gwm-reader test CA"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", `/CN=${hostname}`]);
  fs.writeFileSync(path.join(dir, "ext.cnf"), `subjectAltName=DNS:${hostname},IP:127.0.0.1\n`);
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "ext.cnf"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=gwm-reader test client"]);
  run(["x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.pem", "-days", "2"]);
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  return { dir, ca: read("ca.pem"), cert: read("server.pem"), key: read("server.key"), clientCert: read("client.pem"), clientKey: read("client.key") };
}

module.exports = { API_BASE, LOGIN_URL, TEST_EMAIL, TEST_PASSWORD, TEST_VIN, fakePublisher, jwt, makeTestPki, memoryLog, memoryStore, tmpDir };
