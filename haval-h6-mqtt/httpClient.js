"use strict";

// The single HTTP transport of gwm-reader.
//
// - Every request passes the route allowlist (routes.js) first.
// - A *.gwmcloud.com host is refused unless live mode is enabled.
// - TLS verification is always on, against the system trust store (plus an
//   optional extra CA for a local test mock). It cannot be turned off.
// - An optional client certificate comes only from owner-supplied files.
// - With HTTPS_PROXY set, HTTPS goes through an HTTP CONNECT tunnel, so the
//   proxy sees only host:port. Redirects are never followed.
// - Each allowed request is logged as a route audit line (method, host,
//   path; never the query string or the body).

const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const { RouteNotAllowed } = require("./routes");

const MAX_BODY_BYTES = 4 * 1024 * 1024;

class GwmError extends Error {
  constructor(errorClass, message, { status, apiCode, auth = false, rateLimited = false, retryAfterMs } = {}) {
    super(message);
    this.name = "GwmError";
    this.errorClass = errorClass;
    this.status = status;
    this.apiCode = apiCode;
    this.auth = auth;
    this.rateLimited = rateLimited;
    this.retryAfterMs = retryAfterMs;
  }
}

/** isGwmCloudHost: true for gwmcloud.com and every subdomain. */
function isGwmCloudHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.+$/, "");
  return h === "gwmcloud.com" || h.endsWith(".gwmcloud.com");
}

function tlsOptions({ ca, cert, key } = {}) {
  return {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}),
    ...(cert && key ? { cert, key } : {}),
  };
}

/**
 * TunnelAgent opens an HTTP CONNECT tunnel through the proxy and starts TLS
 * inside it, with the same verification as a direct connection.
 */
class TunnelAgent extends https.Agent {
  constructor(proxyUrl, tlsOpts, timeoutMs) {
    super({ keepAlive: false, ...tlsOpts });
    this.proxy = new URL(proxyUrl);
    this.tlsOpts = tlsOpts;
    this.timeoutMs = timeoutMs;
  }

  createConnection(options, callback) {
    const target = `${options.host}:${options.port || 443}`;
    const req = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 3128,
      method: "CONNECT",
      path: target,
      headers: { host: target },
      timeout: this.timeoutMs,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new GwmError("proxy", `proxy refused CONNECT to ${options.host} (HTTP ${res.statusCode})`, { status: res.statusCode }));
        return;
      }
      const secure = tls.connect({ ...this.tlsOpts, socket, servername: options.servername || options.host });
      secure.once("secureConnect", () => callback(null, secure));
      secure.once("error", (err) => callback(err));
    });
    req.once("timeout", () => req.destroy(new GwmError("timeout", "proxy CONNECT timed out")));
    req.once("error", (err) => callback(err));
    req.end();
  }
}

/**
 * createHttpClient returns request(method, url, {headers, body}) ->
 * Promise<{status, text}>. Errors are GwmError or RouteNotAllowed.
 */
function createHttpClient({ guard, liveAllowed = false, tls: tlsFiles = {}, proxyUrl, timeoutMs = 20_000, log }) {
  const tlsOpts = tlsOptions(tlsFiles);
  const httpsAgent = proxyUrl ? new TunnelAgent(proxyUrl, tlsOpts, timeoutMs) : new https.Agent({ keepAlive: true, maxSockets: 2, ...tlsOpts });
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  const stats = { requests_total: 0, blocked_total: 0 };

  function request(method, url, { headers = {}, body } = {}) {
    const u = url instanceof URL ? url : new URL(url);
    let route;
    try {
      route = guard.check(method, u, body);
    } catch (err) {
      stats.blocked_total += 1;
      if (err instanceof RouteNotAllowed) {
        log?.error("route blocked", { method: err.method, host: err.host, path: err.path, reason: err.message });
      }
      return Promise.reject(err);
    }
    if (isGwmCloudHost(u.hostname) && !liveAllowed) {
      return Promise.reject(new GwmError("live_disabled", `${route}: gwmcloud hosts are blocked unless GWM_LIVE_ENABLED=true`));
    }
    const isHttps = u.protocol === "https:";
    if (!isHttps && u.protocol !== "http:") return Promise.reject(new GwmError("config", `${route}: unsupported protocol`));
    if (!isHttps && isGwmCloudHost(u.hostname)) return Promise.reject(new GwmError("config", `${route}: plain HTTP to gwmcloud`));

    log?.info("route audit", { route, method: String(method).toUpperCase(), host: u.host, path: u.pathname });
    stats.requests_total += 1;

    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const reqHeaders = { accept: "application/json", ...headers };
    if (payload) {
      reqHeaders["content-type"] = "application/json";
      reqHeaders["content-length"] = String(payload.length);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn(v);
        }
      };
      const req = (isHttps ? https : http).request(
        u,
        { method: String(method).toUpperCase(), agent: isHttps ? httpsAgent : httpAgent, headers: reqHeaders },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy(new GwmError("parse", `${route}: response body too large`));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => done(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", (err) => done(reject, toGwmError(route, err)));
        },
      );
      const timer = setTimeout(() => req.destroy(new GwmError("timeout", `${route}: no response within ${timeoutMs} ms`)), timeoutMs);
      req.on("error", (err) => done(reject, toGwmError(route, err)));
      req.end(payload);
    });
  }

  function close() {
    httpsAgent.destroy();
    httpAgent.destroy();
  }

  return { request, close, stats };
}

function toGwmError(route, err) {
  if (err instanceof GwmError) return err;
  const code = typeof err?.code === "string" ? err.code : "";
  const tlsFailure = /^(ERR_TLS|CERT_|UNABLE_TO|DEPTH_|SELF_SIGNED|ERR_SSL)/.test(code);
  return new GwmError(tlsFailure ? "tls" : "network", `${route}: ${code || "request failed"}`.slice(0, 200));
}

module.exports = { GwmError, TunnelAgent, createHttpClient, isGwmCloudHost, tlsOptions };
