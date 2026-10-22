"use strict";

// gwm-reader entry point: configuration, the live-mode gate, the read-only
// poll loop and graceful shutdown. See README.md and docs/AUDIT.md.

const { ConfigError, liveGate, loadConfig } = require("./config");
const { GwmClient } = require("./carConnector");
const { createHttpClient } = require("./httpClient");
const { createRouteGuard } = require("./routes");
const { createPublisher } = require("./mqtt");
const { Reader } = require("./reader");
const { Store } = require("./store");
const { createLogger, safeError } = require("./logger");

const EX_CONFIG = 78;

async function main(env = process.env, argv = process.argv.slice(2)) {
  const boot = createLogger({ level: env.LOG_LEVEL || "INFO" });
  let config;
  try {
    const gate = liveGate(env);
    if (!gate.run) {
      boot.info(gate.reason);
      return 0;
    }
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      boot.error("invalid configuration", safeError(err));
      return EX_CONFIG;
    }
    throw err;
  }

  const log = createLogger({ level: config.logLevel });
  for (const w of config.warnings) log.warn(w);
  const store = new Store({ dir: config.dataDir, log });

  if (argv.includes("--reset-halt")) {
    store.update({ halted: undefined });
    log.info("halt flag cleared; start the reader again");
    return 0;
  }

  log.info("starting gwm-reader (read-only)", {
    mode: config.mode,
    vehicle_id: config.vehicleId,
    refresh_time_s: config.refreshTimeS,
    charging_history_interval_s: config.chargingHistoryIntervalS,
    device_tracker: config.deviceTrackerEnabled,
    proxy: Boolean(config.proxyUrl),
    client_certificate: Boolean(config.tls.key),
  });

  const http = createHttpClient({
    guard: createRouteGuard({ loginUrl: config.loginUrl, apiBase: config.apiBase }),
    liveAllowed: config.liveAllowed,
    tls: config.tls,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.requestTimeoutMs,
    log,
  });
  const client = new GwmClient({ http, loginUrl: config.loginUrl, apiBase: config.apiBase, username: config.username, password: config.password, store, log });
  const publisher = createPublisher({ url: config.mqttUrl, username: config.mqttUsername, password: config.mqttPassword, vehicleId: config.vehicleId, log });
  await publisher.ready();
  const reader = new Reader({ config, client, publisher, store, log });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    await reader.stop();
    http.close();
    await publisher.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await reader.start();
  return undefined; // keep running
}

if (require.main === module) {
  main().then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (err) => {
      createLogger().error("fatal error", safeError(err));
      process.exit(1);
    },
  );
}

module.exports = { main };
