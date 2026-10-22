"use strict";

// Test-only HTTPS mock of the four GWM read endpoints. Every value is
// fictitious. Any other request is answered 404 and logged as UNEXPECTED,
// so the integration test can prove that nothing else was attempted.

const fs = require("node:fs");
const https = require("node:https");

const VIN = "TESTVIN9XK2PQ7RZ4";
const LOGIN = "/br-official-gateway/pc-api/api/v1.0/userAuth/loginAccount";
const API = "/app-api/api/v1.0";
const NOW = Date.now();

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = () => `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600 })}.mock`;
const ok = (data) => ({ code: "000000", description: "SUCCESS", data });

const STATUS = {
  acquisitionTime: NOW - 120_000,
  updateTime: NOW - 60_000,
  hyEngSts: "0",
  latitude: "-10.123456",
  longitude: "-30.654321",
  items: [
    { code: "2103010", value: "12345", unit: "km" },
    { code: "2013021", value: "80", unit: "%" },
    { code: "2011501", value: "61", unit: "km" },
    { code: "2011007", value: "540", unit: "km" },
    { code: "2017002", value: "38", unit: "L" },
    { code: "2013005", value: "92", unit: "%" },
    { code: "2101001", value: "250", unit: "kPa" },
    { code: "2101002", value: "252", unit: "kPa" },
    { code: "2208001", value: "0", unit: "" },
    { code: "2041142", value: "0", unit: "" },
  ],
};

function log(entry) {
  process.stdout.write(JSON.stringify({ mock: "gwm", ...entry }) + "\n");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        resolve("unparseable");
      }
    });
  });
}

const server = https.createServer({ cert: fs.readFileSync("/pki/server.pem"), key: fs.readFileSync("/pki/server.key") }, async (req, res) => {
  const url = new URL(req.url, "https://mock-gwm");
  const body = await readBody(req);
  const send = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const route = `${req.method} ${url.pathname}`;
  const keys = body && typeof body === "object" ? Object.keys(body).sort().join(",") : "";
  if (route === `POST ${LOGIN}` && keys === "account,deviceid,password") {
    log({ route, ok: true });
    return send(200, ok({ accessToken: token(), refreshToken: "mock-refresh" }));
  }
  if (route === `GET ${API}/globalapp/vehicle/acquireVehicles`) {
    log({ route, ok: true });
    return send(200, ok([{ vin: VIN, showedVin: "TESTV*******7RZ4", imsi: "000000000000000", appShowSeriesName: "HAVAL H6", powerType: "PHEV", color: "TEST GRAY", engineType: "TEST1.5T", tankCapacity: 55 }]));
  }
  if (route === `GET ${API}/vehicle/getLastStatus` && url.searchParams.get("vin") === VIN && url.searchParams.get("flag") === "true") {
    log({ route, ok: true });
    return send(200, ok(STATUS));
  }
  if (route === `POST ${API}/vehicleCharge/getChargeLogs` && keys === "continuation,pageNum,pageSize,vin") {
    log({ route, ok: true });
    return send(200, ok({ list: [{ startTime: String(NOW - 7_200_000), endTime: String(NOW - 3_600_000) }, { startTime: String(NOW - 90_000_000), endTime: String(NOW - 86_400_000) }] }));
  }
  log({ route, ok: false, unexpected: "UNEXPECTED", keys });
  return send(404, { code: "404", description: "not found" });
});

server.listen(443, () => log({ listening: 443 }));
