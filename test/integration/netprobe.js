"use strict";

// Runs INSIDE the gwm-reader container (distroless, no shell): proves that
// the reader has no direct route out and that only allowlisted hosts pass
// the proxy. Prints one JSON line.

const net = require("node:net");
const http = require("node:http");
const dns = require("node:dns").promises;

const direct = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 });
    s.on("connect", () => (s.destroy(), resolve("CONNECTED")));
    s.on("timeout", () => (s.destroy(), resolve("ETIMEDOUT")));
    s.on("error", (e) => resolve(e.code));
  });

const viaProxy = (target) =>
  new Promise((resolve) => {
    const req = http.request({ host: "squid", port: 3128, method: "CONNECT", path: target, timeout: 10_000 });
    req.on("connect", (res, socket) => (socket.destroy(), resolve(res.statusCode)));
    req.on("timeout", () => (req.destroy(), resolve("ETIMEDOUT")));
    req.on("error", (e) => resolve(e.code));
    req.end();
  });

(async () => {
  const out = {
    direct_ip: await direct("1.1.1.1", 443),
    direct_ip_80: await direct("8.8.8.8", 80),
    dns_public: await dns.lookup("example.com").then(() => "RESOLVED", (e) => e.code),
    proxy_not_allowlisted: await viaProxy("example.com:443"),
    proxy_allowlisted_mock: await viaProxy("mock-gwm:443"),
    proxy_mock_other_port: await viaProxy("mock-gwm:80"),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
})();
