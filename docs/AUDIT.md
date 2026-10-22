# Upstream audit — havaleiros/hassio-haval-h6-to-mqtt @ `bafa10e` (v1.0.8)

Stage 0 of the `gwm-reader` hardening. All line references are to upstream `bafa10e`, under
`haval-h6-mqtt/` unless the path says otherwise. This audit made no request to any `*.gwmcloud.com`
host and used no credentials.

## 1. HTTP endpoints

Base URLs (`carConnector.js:36-39`):

- `API` = `https://br-app-gateway.gwmcloud.com/app-api/api/v1.0`
- `LOGIN` = `https://br-front-service.gwmcloud.com/br-official-commerce/br-official-gateway/pc-api/api/v1.0/userAuth/loginAccount`

| # | Method | Path | Purpose | Kind | Where |
|---|---|---|---|---|---|
| 1 | POST | `LOGIN` | Sign in; body `{deviceid, password: md5(password), account}` | auth | `carConnector.js:109,125` |
| 2 | GET | `API/globalapp/vehicle/acquireVehicles` | Vehicle list (VIN, IMSI, ICCID, model, tank capacity) | read | `carConnector.js:347` |
| 3 | GET | `API/vehicle/getLastStatus?vin=<VIN>&flag=true` | Last status snapshot (items, `hyEngSts`, `latitude`, `longitude`) | read | `carConnector.js:358` |
| 4 | POST | `API/vehicleCharge/getChargeLogs` | Charge history; body `{vin, pageNum:"1", pageSize:"100", continuation:"0"}` | read (POST) | `carConnector.js:410-417` |
| 5 | GET | `API/vehicle/getRemoteCtrlResultT5?seqNo=&vin=` | Result of the last remote command | command support | `carConnector.js:187-188` |
| 6 | POST | `API/vehicle/T5/sendCmd` | **Remote command** (A/C, engine, doors, trunk, windows, sunroof), body includes `securityPassword: md5(PIN)` | **command** | `carConnector.js:252-268` |
| 7 | POST | `API/vehicleCharge/setChargingPlan?vin=` | **Charging schedule**; used to stop charging (`stopCharging`) | **command** | `carConnector.js:281-316,612-618` |
| 8 | GET | `https://nominatim.openstreetmap.org/reverse?lat=&lon=` | Reverse geocoding of the car position | **third party** | `carTextUtil.js:140-164` |

Command entry points (all removed in stage 1): `carUtil.airConditioner` (`:444`), `engine` (`:478`),
`windows_skyWindow` (`:503`), `doors_trunk` (`:571`), `stopCharging` (`:612`).

Other non-GWM hosts:

- `files/HomeAssistant_Dashboard_GWM.yaml:2575-2577` embeds an `iframe` to
  `https://br-h5-abroad-community.gwmcloud.com/br-vr/`. The viewer's browser contacts GWM.
- Vehicle images come from `br-hw-prod.obs.sa-brazil-1.myhuaweicloud.com` (the `staticImageUrl` field, `index.js:132`).

## 2. Credentials, token and PIN

| Secret | Read | In memory | Persisted | Sent |
|---|---|---|---|---|
| Password | `run.sh:6` → env `PASSWORD`; `carConnector.js:12` | module constant | no | MD5 in the login body (`carConnector.js:109`). The MD5 is enough to sign in. |
| Username (e-mail) | `run.sh:5` → env `USERNAME` | module constant | no | login body; logged at INFO by `run.sh:14` |
| PIN | `run.sh:9` → env `PIN`; `carConnector.js:12`, `mqtt.js:10` | module constant | no | `md5(PIN)` in `sendCmd` (`carConnector.js:252`) |
| Access/refresh token | login response (`carConnector.js:128-134`) | `headers` object (`:172-182`) | **no**: `auth()` reads `storage` (`:100-101`) but never writes the token | every API request header |
| Device id | `md5(Math.random())` (`:106`) | — | `./storage/deviceid` (`:107`) | login body |

Session renewal: `updateHeaders()` returns early when a token is in memory (`carConnector.js:147-148`).
The token is never renewed in the process, so every call fails after the JWT expires. Most
failures then end in `process.exit(0)` (`index.js:321,377`).

Storage: `node-localstorage` at `./storage` (`storage.js:1-2`). The add-on has no `/data` mapping
for it, and it uses the default file modes. Persisted keys: `deviceid`, `vinList`, `imsi-<VIN>`,
`model-<VIN>`, `topicsAndActions`, `topicsToSubscribe` (these contain the VIN), `lastCommands`,
`Startup`, and the error counters (`utils.js:47-90`).

## 3. MQTT

Each publish opens a new connection with QoS 0 and closes it (`mqtt.js:41-50`). There is no LWT.

Published:

- `gwmbrasil_<vin>/<code>/state`: sensor values, retained (`mqtt.js:194-198`). **The VIN is in the topic.**
- `homeassistant/<type>/gwmbrasil_<vin>_<code>/config`: discovery, retained (`mqtt.js:64-138`). The
  device `identifiers` and `name` are the full VIN (`mqtt.js:73-78`).
- `homeassistant/device_tracker/gwmbrasil_<vin>/attributes`: **latitude/longitude** plus IMSI (`mqtt.js:182-193`, `index.js:259-263,351-354`).
- `homeassistant/select/gwmbrasil_veiculos_registrados/{config,state}`: the list of all account VINs (`index.js:64-78`).
- Empty payloads to legacy `haval_<vin>` discovery topics, for cleanup (`mqtt.js:51-63`, `index.js:88-115`).

Subscribed (**command inputs**):

- `ActionableAndLink.execute()` subscribes to every topic in `topicsToSubscribe` (`mqtt.js:206-217`).
  These are the `command_topic`s of the button entities (`mqtt.js:123-127,157-176`).
- The `on('message')` handler maps a `PRESS` to `carUtil.*` commands (`mqtt.js:219-315`). Actions:
  `airConditioner`, `engineOn/Off`, `trunkOpen/Close`, `doorsOpen/Close`, `windowsOpen/Close`,
  `skyWindowOpen/Close`, `stopCharging`, and `chargingLogs` (a read behind a button).
- The only gate is a non-empty `PIN` (`mqtt.js:144`) and a `Startup` flag reloaded from storage
  (`mqtt.js:224`). Anyone with publish rights to `homeassistant/button/...` can send commands.
- After an action, the poll interval drops to 5 s for 1 min (`index.js:382-414`).

Button definitions: `map.js:16-23,139-145,153-168,178-193,244-250,267-282,291-306` and the
engine buttons in `index.js:217-232`.

## 4. GPS

- Source: `latitude`/`longitude` in `getLastStatus` (`index.js:263,277-279,354-358`).
- `config.json` default `device_tracker_enabled: true` publishes the position on every poll.
- Each poll also sends the coordinates to Nominatim (`carTextUtil.js:141-144`) and publishes the
  address as `endereco_atual` (`index.js:265-280,356-359`).

## 5. Logs

`printLog` (`utils.js:38-114`) passes `...optionalParams` to `console.*` unchanged.

| Level | Content | Sensitive |
|---|---|---|
| INFO (`run.sh`) | username and VIN (`run.sh:14-15`) | **e-mail, VIN** |
| INFO | `Registering car: <VIN>` (`index.js:83`) | **VIN** |
| ERROR | raw axios error for a failed login (`carConnector.js:139`). `err.config.data` holds the e-mail and the **MD5 password**; `err.config.headers` holds the tokens on API calls (`:200,273,313,402`). | **password hash, tokens** |
| ERROR | `e.Message` (undefined) (`carConnector.js:352,362`) | no (and useless) |
| DEBUG | base64 dumps of `acquireVehicles` (VIN, IMSI, ICCID, engine number) (`:348`), `getLastStatus` (**coordinates**) (`:359`), `getStatus` (`:399`), `sendCmd` replies (`:209,240,270`), charge logs (`:430`) | **VIN, IMSI, ICCID, coordinates** |

Base64 is not redaction: any log reader can decode it.

## 6. Dependencies

`package.json`: axios ^1.13.5, dotenv ^16.4.5, md5 ^2.3.0, mqtt ^5.7.0, node-localstorage ^3.0.5,
slugify ^1.6.6, yup ^1.4.0. Locked: axios 1.19.0, dotenv 16.4.7, md5 2.3.0, mqtt 5.10.4,
node-localstorage 3.0.5, slugify 1.6.6, yup 1.6.1 (84 packages).

`npm audit --package-lock-only`: **not available.** The registry audit endpoint returned
`503 Service Unavailable` twice on 2026-10-22. The fallback was a query of all 84 locked
packages to OSV (`api.osv.dev/v1/querybatch`):

- `axios` 1.19.0 has 12 advisories: GHSA-3pq3-5fj3-cg6v, -44g4-m2mj-wpvx, -4hqw-qxg8-jxx2,
  -542g-h47m-68v8, -9fr6-4gfg-395g, -c29m-xwm3-cm6r, -j8rh-479h-cp32, -m8m8-qj5v-23w3,
  -mghh-pgcx-3jjj, -r4gj-5m52-g5wh, -vh66-26gq-q6x8, -x97p-jq2g-jp4f.
- `follow-redirects` 1.16.0 has 2: GHSA-8r9p-f939-6h3c, GHSA-q3jh-wrc6-jgq8.

Stage 4 reruns `npm audit --audit-level=high` on the fork lockfile.

## 7. TLS — why upstream turned verification off

The agent (`carConnector.js:160-166`) sets `cert`/`key` (client certificate), `ca: gwm_root.cer`,
`rejectUnauthorized: false` and `ciphers: "DEFAULT:@SECLEVEL=0"`. This has been there since the first
commit (`268237d`, 2024-06-03). No commit message or issue gives a reason. The evidence (no live
handshake was made):

1. **The `ca` option replaces Node's trust store.** Public Certificate Transparency logs (crt.sh,
   2026-10-22) show `*.gwmcloud.com` and `gwmcloud.com` certificates from **GlobalSign** (`GlobalSign
   GCC R46 OV TLS CA 2025`, valid until 2027-02-22; `GlobalSign RSA OV SSL CA 2018`, until 2027-01-30).
   `gwm_root.cer` holds only GWM's private PKI (`GWM Root CA`, `IOV APP SubCA`, `IOV APP General
   SubCA`). With `ca` set to that file, a GlobalSign server certificate fails verification.
   `rejectUnauthorized: false` is the probable work-around. zivillian/ora2mqtt (README, "Cert pinning")
   also says that the app pins the GlobalSign chain for the app gateway.
2. **SHA-1 in the GWM PKI.** In `gwm_root.cer`, `IOV APP General SubCA` (the issuer of the client
   certificate) is signed with `sha1WithRSAEncryption`. OpenSSL 3 at security level 1 or higher rejects SHA-1 signatures, so the
   client chain needs `SECLEVEL=0`. ora2mqtt ships an `openssl.cnf` with
   `CipherString = DEFAULT@SECLEVEL=0` for the same reason.

Fork decision: verify the server against the default (public) trust store and never set `ca` to the
GWM private root. `rejectUnauthorized: false` stays out. If the client chain needs a lower security
level, that is a client-side setting and does not affect server verification. Stage 1 must decide
that case (see section 8), and `docs/RUNBOOK.md` explains how to diagnose a TLS failure.

## 8. Client certificate — does login work without `gwm_general.key`?

- **Upstream always sends it.** `updateHeaders()` reads `certs/gwm_general.{cer,key}` and `gwm_root.cer`. If the
  read fails, it returns before `auth()` (`carConnector.js:150-158`), so upstream never signs in
  without the certificate. `index.js:42-44` flags a missing file at startup.
- **Certificate facts:**
  - `CN=LGWGWM-AD-BR-GENERAL, O=Great Wall Motor Co., Ltd., L=APP`, issued by `IOV APP General SubCA`;
  - valid from 2022-10-19 to **2027-10-18**, RSA 2048, SHA-256;
  - it is one general certificate shipped inside the app, so all users share it.
- **zivillian/ora2mqtt README** (the project that upstream derives from, lines 142 and 172-174):
  - "the `eu-app-gateway` endpoint needs a client certificate of the GWM CA";
  - the app ships `assets/gwm_general.{cer,key}`, and on first sign-in it issues itself an individual certificate (README "Client Cert"). The EU and BR platforms use the same gateway design (`<region>-app-gateway`).
- **Login host:** login goes to `br-front-service` (`pc-api`, header `terminal: GW_PC_GWM`,
  `carConnector.js:121`). That is the web/PC gateway, so login may work without the certificate.
  But the vehicle data (rows 2–4) all go to `br-app-gateway`.

**Conclusion:** the evidence says that the data API **requires** the extracted client certificate.
Without it, login may succeed, but no vehicle data can be read. Under amendment 6 of the plan, the
work **stops here** until the owner decides. The user's safeguard says: do not use an extracted client
certificate unless authorization and necessity are established.

## 9. Suspicious and noteworthy items

- **Committed private key:** `certs/gwm_general.key` (PKCS#8, since `268237d`). It is GWM's shared app key, and
  anyone can extract it from the public app, but it is still a credential in git history. gitleaks
  finding below.
- **Obfuscated code in history:** release 0.0.17 (`2158d54`, 2025-03-16) added `axios_add.js`, an obfuscated
  `setChargingPlan` client with `rejectUnauthorized:false`. It was replaced by plain code in 1.0.1
  (`acde828`). It is not in HEAD, but it is in the history.
- **Auto-publish workflow:** `.github/workflows/docker-build-publish.yml:9-14,29,61-101` pushes to
  `ghcr.io/<owner>/<repo>` on each push to `main` or a `v*` tag, with `packages: write` and cosign
  signing. On the fork it would publish under the fork owner. Actions are off on the fork, and
  stage 4 disables this workflow by ID.
- **`:latest` bases:** `build.yaml:2-6` (`ghcr.io/home-assistant/*-base:latest`); the root `Dockerfile` uses
  `node:20-alpine` and runs as root (`Dockerfile:1-8`, `haval-h6-mqtt/Dockerfile:1-15`).
- **`eval` of a formula with an API value:** `index.js:206,339`. It is guarded by `!isNaN(value)`,
  so only numeric strings reach `eval`. The risk is low, but `eval` is not needed.
- **Implicit globals:** `register(entityType = …, vin = …, …)` (`index.js:67-76,164-173,191-200`) assigns globals.
  `vin` then leaks into later code (`index.js:257-263,279,299-303`).
- **License:** there is no `LICENSE` file. The MIT text is only in `README.md:408-417` (Portuguese). The credits
  (`README.md:400`) name `ipsBruno/haval-h6-gwm-alexa-chatgpt-mqtt-integration` and `zivillian/ora2mqtt`.
- `files/haval_h6.zip`: 34 PNG dashboard images only.
- `files/nodered_flow_Haval.json`: HA notifications and one `hassio.addon_restart`, with no vehicle commands.
  The `position-config` node has no coordinates.
- No telemetry or analytics calls. The only non-GWM network call in the code is Nominatim.

## 10. gitleaks (full history)

`gitleaks v8.28.0` (`ghcr.io/gitleaks/gitleaks@sha256:cdbb7c95…a854`), `git --log-opts=--all --redact`,
88 commits scanned:

| Rule | File | Commit | Fingerprint |
|---|---|---|---|
| private-key | `haval-h6-mqtt/certs/gwm_general.key:1` | `268237d` | `268237d9186582bdd66fec822308328a9490056b:haval-h6-mqtt/certs/gwm_general.key:private-key:1` |

Plan: delete `certs/` from the `hardened` tree. Add this exact fingerprint to `.gitleaksignore` (upstream
history, not rewritten), and nothing else.

## 11. Status in gwm-reader (branch `hardened`)

| Finding (section) | Resolution | Commit | Proof |
|---|---|---|---|
| Command endpoints 5–7, MQTT command subscriptions, button entities (§1, §3) | Removed. `routes.js` allows only rows 1–4 | 31641d5 | `test/unit/routes.test.js`, `readonly.test.js`; the integration mock sees only the 4 routes |
| `getChargeLogs` is a POST (§1 row 4) | The only non-login POST, with a pinned body (`vin`, `pageNum=1`, `pageSize=100`, `continuation=0`) | 31641d5 | `routes.test.js` (exact body, extra field, missing field) |
| PIN read, sent as `md5(PIN)` (§2) | No option, no code. The source scan forbids it | 31641d5 | `readonly.test.js` |
| No token renewal; `process.exit(0)` loops (§2) | Renewal on 401/expired codes; 3 logins/hour kept across restarts; backoff; halt + `reader_error` | 31641d5 | `client.test.js`, `reader.test.js` |
| Plain env secrets; username/VIN at INFO (§2, §5) | File-only secrets; a plain env var stops the boot (exit 78); `/data` 0700, files 0600 | 86f3b1a | `config.test.js`, `main.test.js`, `store.test.js` |
| VIN in topics and device ids; VIN list select (§3) | `VEHICLE_ID` alias; no select | 31641d5 | `reader.test.js`, integration "no VIN … reach the broker" |
| GPS on by default; Nominatim (§4) | `DEVICE_TRACKER_ENABLED=false`; the geocoding code is deleted; Nominatim is blocked by the allowlist | 31641d5, 86f3b1a | `reader.test.js`, `httpClient.test.js` |
| Raw errors and base64 dumps in logs (§5) | `logger.js`: one redaction filter at every level; errors become `{error_class, message}` | 31641d5, 86f3b1a | `logger.test.js` |
| axios 1.19.0 (12 advisories), follow-redirects (§6) | axios removed (`node:https`, redirects not followed); only `mqtt` 5.16.0 at runtime; `npm audit`: 0 vulnerabilities | 31641d5 | CI `npm audit --audit-level=high` |
| TLS off: the `ca` option replaced the trust store; `SECLEVEL=0` (§7) | Always verified against the system roots; an optional extra CA is *added*, never replaces them | 31641d5 | `tls.test.js` (fail-closed, tunnel) |
| Client certificate required by the data gateway (§8) | Never bundled or fetched; optional owner-supplied files after GWM authorization (RUNBOOK) | 31641d5 | `tls.test.js` (presented only when configured) |
| Committed private key (§9, §10) | `certs/` deleted from the tree; the exact fingerprint in `.gitleaksignore`; history not rewritten | 31641d5, 95cd608 | gitleaks over the full history: no leaks |
| Auto-publish workflow; `:latest` bases; root user (§9) | Workflow deleted on `hardened`; `main` still mirrors upstream (owner action in README, security audit run-1); digest-pinned distroless image, uid 65532 | 3ce5329, 95cd608 | CI `image` job |
| `eval` of formulas; implicit globals (§9) | A named `kpa_to_psi` converter; ESLint `no-eval`, `no-implicit-globals` | 31641d5, 95cd608 | `reader.test.js`, `npm run lint` |
| GWM iframe in the dashboard (§1) | `ha/dashboard.yaml` derived by `scripts/derive-dashboard.js` without iframe, buttons, service calls, select or map | fd34435 | `readonly.test.js` (dashboard scan) |
| Egress | gwm-reader only on an internal network; Squid CONNECT allowlist | 3ce5329 | integration network probe |

Stage 7 (`/security-audit` run-1) found 4 further defects in the fork and 1 lead that needs validation. All of them are fixed or guarded in commits `41171b1` to `4d24786`. See [`docs/SECURITY-AUDIT.md`](SECURITY-AUDIT.md).
