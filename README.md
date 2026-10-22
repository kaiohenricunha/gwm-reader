# gwm-reader

A **read-only**, hardened fork of
[havaleiros/hassio-haval-h6-to-mqtt](https://github.com/havaleiros/hassio-haval-h6-to-mqtt).
It reads the status of a GWM vehicle (Haval H6 PHEV, Brazil) from the My GWM cloud and publishes it
to MQTT for Home Assistant. It never sends anything to the car.

> **Live use is off by default.** The reader does not contact GWM until the owner completes
> [docs/RUNBOOK.md](docs/RUNBOOK.md) and starts a deliberate run with `GWM_LIVE_ENABLED=true`.
> The GWM data gateway needs the client certificate that is extracted from the app
> ([docs/AUDIT.md §8](docs/AUDIT.md)). This project never bundles or downloads it.

- Upstream audit: [docs/AUDIT.md](docs/AUDIT.md)
- Owner steps (outside this repository): [docs/RUNBOOK.md](docs/RUNBOOK.md)
- Security audit of this fork: [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)

## What was removed, and why

| Upstream | gwm-reader | Why |
|---|---|---|
| Remote commands: A/C, engine, doors, trunk, windows, sunroof, stop charging (`sendCmd`, `setChargingPlan`) | Removed, and blocked by the route allowlist | A reader must not be able to move the car's state. |
| MQTT subscriptions plus `button`/`switch`/`select` entities | Removed. The reader never subscribes, and the broker never delivers it a message | Any MQTT client could press a button. |
| Security PIN (`gwm_pin`) | Removed. No option, no code | The PIN authorizes commands. It stays only in the phone app. |
| GPS tracker on by default, with the address from Nominatim | `DEVICE_TRACKER_ENABLED=false`. The geocoding code is removed | Coordinates are personal data. They never go to a third party. |
| Polling every 30 s | `REFRESH_TIME=300` (minimum 60). Charge history on its own timer, every 6 h | A lighter load on an unofficial API and a smaller chance of a block. |
| Password and PIN in add-on options and `.env` | Secrets only from files (`*_FILE` or `/run/secrets`). A plain env var stops the boot | Env vars leak through `docker inspect` and `/proc`. |
| TLS checks off (`rejectUnauthorized:false`, `SECLEVEL=0`) | Always verified against the system trust store | See [AUDIT §7](docs/AUDIT.md): the GWM hosts use public GlobalSign certificates. |
| Raw errors and base64 dumps in the logs | One redaction filter at every level | The old logs held the password hash, tokens, VIN and coordinates. |
| Committed app certificate and private key | Deleted from the tree. Optional, owner-supplied file only | Do not use it until GWM authorizes it. |
| The VIN in every topic and entity id | `VEHICLE_ID` (default `h6`) | The VIN stays inside the process. |
| `:latest` images, root user, auto-publish workflow | Digest-pinned multi-stage distroless image, uid 65532, no publish workflow | Supply chain. |
| HA add-on packaging | Removed. Docker Compose only | The add-on option model cannot carry file secrets. |

Kept: status polling (odometer, battery, fuel, tire pressure and temperature, charging state,
doors, windows, locks) and the charge history, with the upstream entity names.

## How it works

```
gwm-reader ──(mqtt_internal: internal network, no internet)──> mosquitto
    │
    └── HTTPS_PROXY ──> squid ──(egress)──> only the domains in the allowlist
```

- **Route allowlist** (`haval-h6-mqtt/routes.js`). Exactly four requests can leave the process:
  `POST loginAccount`, `GET acquireVehicles`, `GET getLastStatus`, and
  `POST getChargeLogs` with a pinned body. Any other method, path, host, query field or body field
  throws `RouteNotAllowed` and is logged.
- **Egress proxy.** gwm-reader is only on the internal network. Squid allows `CONNECT` on port 443
  to the allowlisted domains and does no TLS interception. It sees host:port only. The reader
  logs each path itself (`route audit`).
- **Broker.** Mosquitto with `allow_anonymous false`, a password file and an ACL file. It publishes no host port.
- **Session.** A rejected token triggers one new login. Logins are capped at **3 per hour**, and
  the cap survives restarts. Failures back off from 1 to 30 min. After 3 authentication failures in
  a row, the reader **halts**: it stops polling and publishes the `reader_error` sensor.

### MQTT topics (`VEHICLE_ID=h6`)

| Topic | Content |
|---|---|
| `gwmbrasil/h6/availability` | `online` / `offline` (retained; LWT) |
| `gwmbrasil/h6/<code>/state` | entity states (retained) |
| `gwmbrasil/h6/snapshot` | raw snapshot with the GWM source timestamps, in the `kinestra.mygwm.status.v1` shape. No VIN, no coordinates |
| `gwmbrasil/h6/reader_error/state` | `ok`, `retrying` or `halted` (+ `attributes`) |
| `gwmbrasil/h6/charging_history/{state,attributes}` | charge history |
| `gwmbrasil/h6/location/attributes` | coordinates, **only** with `DEVICE_TRACKER_ENABLED=true` |
| `homeassistant/<component>/gwmbrasil/h6_<key>/config` | discovery (retained) |

| MQTT user | Can do |
|---|---|
| `gwm_reader` | write `gwmbrasil/#` and `homeassistant/+/gwmbrasil/#`; read nothing |
| `homeassistant` | read `gwmbrasil/#` and `homeassistant/#`; write nothing |
| `kinestra_bridge` | read `gwmbrasil/+/snapshot` only |

Mosquitto 2.1's `acl_file` accepts every SUBSCRIBE (`plugins/acl-file/acl_check.c:42-45`). It
enforces the read rules when it delivers. So `gwm_reader` can send a SUBSCRIBE, but it never
receives a message. The integration test proves this.

## Set up

Requirements: Docker with Compose v2 on Linux (or WSL2), and `openssl` for the tests.
**Always pass the project name** (`-p gwm-reader`). To clean up, use
`docker compose -p gwm-reader down -v`, never `docker volume prune`.

1. Create the secrets (MQTT passwords, the hashed broker password file, and **empty** GWM files):

   ```bash
   ./scripts/init-secrets.sh
   ```

2. Write your My GWM login into the files. Do not use the shell history, and do not use env vars:

   ```bash
   nano secrets/gwm_username     # your e-mail, one line
   nano secrets/gwm_password     # your password, one line
   ```

   `secrets/` is 0700 and gitignored. Use a dedicated GWM account if the app allows one
   (RUNBOOK step 1).

3. Create the personal override and the local allowlist. Both are gitignored:

   ```bash
   cp docker-compose.override.yml.example docker-compose.override.yml
   cp proxy/allowlist.txt proxy/allowlist.local.txt   # placeholders until the review below
   ```

   Use the override for `GWM_VIN`, and only when the account has more than one vehicle. The local
   allowlist file must exist before you start the stack. If it is missing, Docker creates a
   directory in its place.

4. Start the broker and the proxy. The reader exits at once while live mode is off:

   ```bash
   docker compose -p gwm-reader up -d
   ```

## First run and the proxy allowlist

`scripts/first-run.sh` is an **owner-only** controlled run. It refuses to start without
`GWM_LIVE_ENABLED=true` and real secrets. It runs the reader for 90 s, prints a report, and stops
the reader again.

```bash
# Pass 1: proxy/allowlist.txt holds placeholders, so every CONNECT is denied.
GWM_LIVE_ENABLED=true ./scripts/first-run.sh
#   == 1. proxy CONNECT attempts ==   e.g.  TCP_DENIED/403 <host>:443
#   == 2. routes sent or blocked ==   method host path (no query, no body)
```

1. Compare each denied host with [AUDIT §1](docs/AUDIT.md). Expect only the two `br-*.gwmcloud.com`
   hosts.
2. Write the hosts you approve into `proxy/allowlist.local.txt`, one per line. This file is
   gitignored and mounted by the override.
3. Run pass 2 to see the paths. Each path must be one of the four routes. Then start the reader
   for real:

```bash
GWM_LIVE_ENABLED=true ./scripts/first-run.sh            # pass 2: check the paths
GWM_LIVE_ENABLED=true docker compose -p gwm-reader up -d # keep it running
```

The full owner procedure, with TLS troubleshooting, is in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Home Assistant

- Attach Home Assistant to the internal network (`gwm-reader_mqtt_internal`, an external network
  in HA's own compose). Connect as `homeassistant` with `secrets/mqtt_homeassistant_password`.
  The broker publishes no host port.
- The user is read-only, so HA's birth message to `homeassistant/status` is dropped. Discovery is
  retained, so HA does not need it.
- Dashboard: [`ha/dashboard.yaml`](ha/dashboard.yaml). It is derived from the upstream one, with no
  buttons, no service calls, no map or tracker, and no GWM iframe. It needs the same custom cards as
  upstream (`config-template-card`, mushroom).
- Recorder: merge [`ha/recorder.yaml`](ha/recorder.yaml). It sets `purge_keep_days: 7` and keeps the
  lock, door, window and sunroof states out of the database.

## Kinestra (one GWM client only)

Only **one** program may sign in to the GWM account. Two sign-ins sign each other out, and the
phone app too, and they double the load on the API. gwm-reader is that one client. Kinestra reads
`gwmbrasil/+/snapshot` as `kinestra_bridge`, through a read-only Mosquitto bridge, and its own MyGWM
adapter stays in fixture mode.

## Update from upstream (keep the route allowlist)

`main` mirrors `upstream/main`. All fork work lives on `hardened`.

```bash
git fetch upstream
git switch hardened && git merge upstream/main
```

When the merge touches these areas:

- **Packaging** (`config.json`, `build.yaml`, `run.sh`, `repository.json`, `translations/`,
  `certs/`): delete those files again.
- **`carConnector.js`, `mqtt.js` or `index.js`**: port only **read** changes. Take a new
  status field into `map.js` as it is. Never take a command, a subscription, the PIN, geocoding,
  `rejectUnauthorized:false` or `SECLEVEL`. The source scan in `test/unit/readonly.test.js` fails
  if any of them comes back.
- **A new read endpoint**: add it to `routes.js` with its exact method, path, query fields and body
  fields. Add a test in `test/unit/routes.test.js` and a line in `docs/AUDIT.md`. Then add its host
  to your reviewed allowlist only after a `first-run.sh` review.

Then run every check:

```bash
cd haval-h6-mqtt && npm ci && npm run lint && npm test && npm audit --audit-level=high
npm run test:integration
```

**GitHub Actions on the fork.** `main` still holds upstream's `docker-build-publish.yml`, which
publishes an image on every push to `main`. Before Actions are on, or before you use "Sync fork":

1. Allow only the SHA-pinned actions that `ci.yml` uses.
2. Disable that workflow (`gh workflow disable docker-build-publish.yml`).
3. Set the default workflow token to read-only.

## Tests and CI

| Command (in `haval-h6-mqtt/`) | What it checks |
|---|---|
| `npm test` | Unit tests (node:test + nock): the route allowlist, file-only secrets, redaction at every level, GPS off, minimum intervals, the live gate, session renewal and halt, TLS fail-closed, the CONNECT tunnel, the optional client certificate, and a read-only source scan |
| `npm run lint` | ESLint (`no-eval`, `no-implicit-globals`, strict mode) |
| `npm run test:integration` | The compose stack with a mock GWM behind Squid (project `gwm-reader-it`): the Mosquitto ACL, no direct route from the reader, and the end-to-end flow |

CI (`.github/workflows/ci.yml`) runs:

- lint and the unit tests on Node 22 and 24;
- `npm audit --audit-level=high`;
- gitleaks over the full history;
- the image build, with the digest in the job summary;
- the integration test;
- a CycloneDX SBOM, as an artifact.

Nothing is pushed to a registry. `.pre-commit-config.yaml` runs gitleaks before each commit.

## License and credits

The upstream MIT license and the license of the modifications are in [LICENSE](LICENSE). The credits
(havaleiros, ipsBruno, zivillian, and the upstream contributors) are in [NOTICE](NOTICE).
