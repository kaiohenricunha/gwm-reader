"use strict";

// Real sockets on 127.0.0.1 only: TLS fail-closed and the CONNECT tunnel.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const { createHttpClient } = require("../../httpClient");
const { createRouteGuard } = require("../../routes");
const { makeTestPki } = require("./helpers");

const pki = makeTestPki("localhost");
let server;
let base;
let proxy;
let proxyUrl;
const connects = [];

test.before(async () => {
  server = https.createServer({ cert: pki.cert, key: pki.key }, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "000000", description: "SUCCESS", data: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `https://localhost:${server.address().port}/app-api/api/v1.0`;

  // Minimal CONNECT proxy: allows only "localhost:<server port>".
  proxy = http.createServer((req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, socket) => {
    connects.push(req.url);
    if (req.url !== `localhost:${server.address().port}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(server.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

test.after(() => {
  server.close();
  proxy.close();
});

const guardFor = (b) => createRouteGuard({ loginUrl: `${b.replace(/\/app-api.*/, "")}/login`, apiBase: b });

test("an unknown server certificate is rejected (fail-closed)", async () => {
  const c = createHttpClient({ guard: guardFor(base) });
  await assert.rejects(c.request("GET", `${base}/globalapp/vehicle/acquireVehicles`), (e) => e.errorClass === "tls");
  c.close();
});

test("the same server is accepted when its CA is added as an extra CA", async () => {
  const c = createHttpClient({ guard: guardFor(base), tls: { ca: pki.ca } });
  const res = await c.request("GET", `${base}/globalapp/vehicle/acquireVehicles`);
  assert.equal(res.status, 200);
  c.close();
});

test("HTTPS goes through the CONNECT tunnel with the same verification", async () => {
  const c = createHttpClient({ guard: guardFor(base), tls: { ca: pki.ca }, proxyUrl });
  const res = await c.request("GET", `${base}/globalapp/vehicle/acquireVehicles`);
  assert.equal(res.status, 200);
  assert.ok(connects.includes(`localhost:${server.address().port}`));
  c.close();

  const strict = createHttpClient({ guard: guardFor(base), proxyUrl });
  await assert.rejects(strict.request("GET", `${base}/globalapp/vehicle/acquireVehicles`), (e) => e.errorClass === "tls");
  strict.close();
});

test("a proxy refusal surfaces as a proxy error", async () => {
  const other = `https://127.0.0.1:${server.address().port}/app-api/api/v1.0`;
  const c = createHttpClient({ guard: guardFor(other), tls: { ca: pki.ca }, proxyUrl });
  await assert.rejects(c.request("GET", `${other}/globalapp/vehicle/acquireVehicles`), (e) => e.errorClass === "proxy" && e.status === 403);
  c.close();
});
