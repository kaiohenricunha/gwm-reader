# gwm-reader — architecture summary (run-1, ee85725, branch hardened)

## Product, principals, protected resources
A read-only, hardened fork of havaleiros/hassio-haval-h6-to-mqtt (Node 22/24, CommonJS). One process polls the unofficial My GWM Brazil cloud API (login, vehicle list, last status, charge logs). It publishes values to Mosquitto for Home Assistant (HA) and a downstream "kinestra_bridge" consumer. Single owner/operator.

Protected resources:
- the GWM account credentials (e-mail; password, sent only as an MD5 hash, which by itself is enough to sign in);
- the session tokens and device id (`/data/state.json`);
- the VIN and other vehicle identifiers (IMSI, ICCID, engine number);
- the vehicle coordinates;
- the vehicle itself (remote commands are deliberately absent);
- the owner's MQTT/HA integrity;
- the egress boundary (only the GWM hosts).

Principals:
- **Owner/operator:** trusted. Supplies env, secret files, the compose override and the allowlist.
- **GWM cloud and anything on the network path:** lower trust; returns JSON that the reader parses and republishes.
- **MQTT users:**
  - `gwm_reader`: write-only (`gwmbrasil/#`, `homeassistant/+/gwmbrasil/#`);
  - `homeassistant`: read `gwmbrasil/#` and `homeassistant/#`;
  - `kinestra_bridge`: read `gwmbrasil/+/snapshot`.
- **Any container attached to `mqtt_internal`:** can reach mosquitto:1883 and squid:3128.
- **CI contributors:** fork PRs run the `pull_request` workflow.

## Comparable baseline
Upstream (docs/AUDIT.md) accepted: remote commands behind an empty-PIN gate, TLS verification off, raw error logging, and the VIN in topics. The fork's security claims are measured against removing exactly those.

## Stack and deployment
- `Dockerfile`: node:24 alpine builder, then distroless nodejs24 non-root (65532), both digest-pinned. Only `haval-h6-mqtt/*.js` and the lockfile enter the image.
- `docker-compose.yml`:
  - `gwm-reader` sits only on `mqtt_internal` (`internal: true`).
  - `squid` (ubuntu/squid 6.6, CONNECT-only to 443, dstdomain allowlist) sits on `mqtt_internal` and `egress`.
  - `mosquitto` 2.1.2 (password_file + acl_file, plaintext 1883, persistence on) sits on `mqtt_internal`.
  - All are read_only, cap_drop ALL, no-new-privileges, with no host ports.
- The real allowlist, the override, the secrets and the optional client certificate are gitignored deployment facts.
- CI: `.github/workflows/ci.yml` with contents:read, SHA-pinned actions, a fork PR integration job running Docker, and an `npx @cyclonedx/cyclonedx-npm@6.0.1` SBOM.

## Offline execution limits
- **Unit tests:** `node --test "test/unit/*.test.js"` in `haval-h6-mqtt/`. They use nock, loopback TLS and openssl. The node:24 alpine image has no openssl CLI.
- **Sandbox:** `docker run --network none --read-only --env-file /dev/null --cap-drop ALL --security-opt no-new-privileges --memory --cpus --pids-limit --ulimit fsize/nofile`, the target mounted read-only, and writes only to a size-bounded `--tmpfs`, plus a host `timeout` followed by `docker rm -f` for the wall clock.
- **Evidence:** the parent captures bounded stdout into the agent's scratch and promotes it with `promote-artifact.go` (Go 1.27 present).
- **Prohibited:** `npm ci/install/audit`, `npx`, docker pull/build `--pull`, `compose up --build`, `first-run.sh`, `init-secrets.sh` in the target, and any `GWM_LIVE_ENABLED=true` run.

## Entry surfaces → sinks
1. **GWM HTTP responses** (`carConnector.js` parse/login/acquireVehicles/getLastStatus/getChargeLogs):
   - into tokens, which go to `state.json` and to request headers;
   - into vehicle fields, which go to retained MQTT states and the discovery device name;
   - into status items, which go to state topics (keys fixed by `map.js`), to the raw snapshot to kinestra (`snapshot.js`), and to `carTextUtil` status_message, which the HA markdown card renders (`ha/dashboard.yaml`);
   - into `body.code`, which goes to the error class, then to logs and the retained `reader_error` attributes;
   - into charge logs, which go to retained attributes.
2. **Outbound request construction:**
   - route guard (`routes.js`), then the live gate (`httpClient.js isGwmCloudHost`, `config.js liveGate`), then TLS options, then the CONNECT tunnel (`TunnelAgent`) or a direct `http.Agent` for plain-http fixture hosts.
   - Fixture mode sends the real credentials to any two non-gwmcloud URLs.
3. **Env/config/secret files** (`config.js`): plain-secret refusal, `*_FILE` and `/run/secrets`, `GWM_EXTRA_CA_FILE` (added for all hosts), client cert, `HTTPS_PROXY`, `MQTT_URL` (no TLS), `DATA_DIR` (used by `--reset-halt` before validation).
4. **State file** (`store.js`): loaded with JSON.parse; it feeds tokens, `deviceid`, `loginAttempts` (limiter) and `halted`.
5. **MQTT:** publish-only client with an LWT (`mqtt.js`). The broker ACL (`mosquitto/acl`) is the only isolation for HA/kinestra consumers. acl_file accepts SUBSCRIBE and filters on delivery.
6. **Proxy:** `proxy/squid.conf`, with `localnet` = all RFC1918 and no private-destination deny. `dstdomain` decides on CONNECT host names.
7. **Scripts:**
   - `first-run.sh` (env-driven compose argv, log parsing);
   - `init-secrets.sh`;
   - `test/integration/run.sh` (container output interpolated into `bash -c`);
   - `scripts/derive-dashboard.js` (a denylist over third-party YAML).
8. **CI/supply chain:** workflow triggers, the npx SBOM tool, the pre-commit mutable tag, Dependabot.

## Trust boundaries and strongest controls
- **Egress:** the exact route allowlist plus the gwmcloud live gate plus network isolation plus the Squid allowlist.
- **TLS:** `rejectUnauthorized: true` always, the system roots plus an optional additive CA.
- **Secrets:** file-only intake, a central redaction logger, a 0600/0700 state file.
- **Vehicle commands:** no code path exists; a source scan test guards it.
- **MQTT:** password auth plus acl_file; the reader never subscribes.
- **Session:** 3 logins/hour persisted, backoff, halt after 3 auth failures.
- **Containers:** distroless, non-root, read-only, no caps, internal network.
- **CI:** contents:read, pull_request (not pull_request_target), persist-credentials false.

## Starting paths
`haval-h6-mqtt/{routes,httpClient,carConnector,reader,mqtt,config,logger,store,snapshot,index,carTextUtil,map,backoff}.js`, `proxy/`, `mosquitto/`, `docker-compose*.yml*`, `Dockerfile`, `.dockerignore`, `scripts/`, `test/integration/`, `.github/`, `ha/`, `.pre-commit-config.yaml`, `.gitleaksignore`.

## Prior coverage
No prior run or ledger exists for this repository.

## Companion selection
- **PROTOCOLS-RPC-AND-MESSAGING.md:** the Mosquitto broker ACL, and the producer/consumer trust between gwm_reader, HA and kinestra.
- **CLOUD-AND-DEPLOYMENT.md:** compose networks, container capabilities, secret mounts, the Squid egress.
- **SUPPLY-CHAIN-AND-RELEASE.md:** CI triggers, pinned images, the npx tool, Dependabot and pre-commit.
- **WEB-PROTOCOL-AND-AUTH.md:** the outbound TLS/mTLS client, the CONNECT proxy, bearer tokens.
- **RESOURCE-EXHAUSTION-AND-AVAILABILITY.md:** unbounded GWM response fields into the regex redaction and retained MQTT.
- **Excluded:** CLIENT-SIDE.md (the HA dashboard is third-party HA rendering, covered as a second-order sink under Injection), AI-AND-LLM.md, MEMORY-SAFETY-AND-BINARY.md, DESKTOP-MOBILE-AND-LOCAL-IPC.md, DATA-ISOLATION-AND-LIFECYCLE.md (single owner, no tenants; state retention is covered under secrets).
