# gwm-reader — owner runbook

These steps are **outside** the code. Only the vehicle owner can do them, and the development
sessions did none of them. Nobody has ever run gwm-reader against GWM. Do the steps in order, and
do not set `GWM_LIVE_ENABLED=true` before steps 1–5 are complete.

The same approval checklist exists for Kinestra, in the private `kaiohenricunha/kinestra`
repository at `docs/mygwm-integration.md` ("Approval checklist"). Complete it once; it covers both
projects. **Only one program may sign in to the GWM account:** gwm-reader. Never run Kinestra's
live MyGWM adapter at the same time.

## 1. Use a dedicated account, with its own e-mail and 2FA

- In the My GWM app, check whether you can share the vehicle with a second account. If you can:
  create a new e-mail address for it only, turn on 2FA for that mailbox, and share the vehicle with
  the new account.
- Give gwm-reader only that account. Your phone keeps your main account. A leak of the server
  credentials then exposes a revocable secondary account, not your main login. The two sessions
  also stop signing each other out.
- If the app cannot share the vehicle, do not continue without a written decision (see step 5).
  The server would then hold the main account's credentials.

## 2. Keep the PIN in the app only

- Keep the security PIN active in the My GWM app. It is what authorizes remote unlock and start.
- Never put the PIN on the server. gwm-reader has no option for it and no code that uses it. If
  any guide or tool asks for it, stop.

## 3. Confirm that GWM Conecta is active

- In the app, open the connected services (GWM Conecta) and confirm that the subscription is
  active. The free period is 24 months from the first delivery.
- Without it, the cloud has no fresh data. The reader would only repeat an old snapshot. Check the
  `acquisition_time` in `gwmbrasil/<id>/snapshot`.

## 4. The first real login (controlled), and the allowlist

Before you start:

- Steps 1–3 and 5 are complete.
- Decide on the **client certificate** (see "Client certificate" below). Without it, login may
  succeed, but the data gateway is expected to refuse the calls.
- `./scripts/init-secrets.sh` has run. Your login is in `secrets/gwm_username` and
  `secrets/gwm_password`, one line each. Never use environment variables for them; the reader
  refuses to start if you do.
- `docker-compose.override.yml` and `proxy/allowlist.local.txt` exist (README, "Set up", step 3).

Pass 1 shows which domains the reader wants. Nothing passes the proxy yet:

```bash
GWM_LIVE_ENABLED=true ./scripts/first-run.sh
```

- Section 1 must list only `TCP_DENIED/403` lines, for the two hosts in `docs/AUDIT.md` §1:
  `br-front-service.gwmcloud.com:443` and `br-app-gateway.gwmcloud.com:443`.
- If any other host appears, **stop**. Do not add it, and investigate first.
- Write the approved hosts into `proxy/allowlist.local.txt`, one per line, with no wildcards.

Pass 2 shows the paths:

```bash
GWM_LIVE_ENABLED=true ./scripts/first-run.sh
```

- Section 2 may contain only these four `route audit` lines: `POST …/userAuth/loginAccount`,
  `GET …/globalapp/vehicle/acquireVehicles`, `GET …/vehicle/getLastStatus` and
  `POST …/vehicleCharge/getChargeLogs`.
- A `route blocked` line means that something tried a path outside the allowlist. Stop, and keep
  the log.
- Section 3 must show `login succeeded` once, then `vehicle selected` and `status published`.

Then check the data:

- Compare the odometer, SoC, fuel and tire values in Home Assistant with the car's own display.
- Check that the lock and door states match reality. Lock the car, wait two polls (10 min), and
  compare.

Keep it running only after both passes are clean:

```bash
GWM_LIVE_ENABLED=true docker compose -p gwm-reader up -d
```

To stop it at once: `docker compose -p gwm-reader stop gwm-reader`.

## 5. Get the insurer's position in writing

Ask your insurer for a **written** answer (keep the e-mail) on:

1. whether passive, read-only access to the app data through unofficial software affects the
   coverage;
2. whether a theft through a stolen app login plus a remote unlock is covered (*furto sem
   vestígios*);
3. whether you must declare this software as an aggravation of risk (*agravamento de risco*).

If you hold two products (the GWM-bundled insurance and a separate policy), ask both insurers.

## 5b. MQTT users: one session each

The broker allows one live connection per user name (`use_username_as_clientid`). If you connect
as `homeassistant` to debug, Home Assistant is disconnected. For any extra tool, add a separate
read-only user: add its name to the loop in `scripts/init-secrets.sh`, add a `user <name>` block
with `topic read ...` lines to `mosquitto/acl`, run `./scripts/init-secrets.sh`, and restart the
broker (`docker compose -p gwm-reader restart mosquitto`).

## 6. If you suspect a leak

Do these steps at once and in this order:

1. Stop the reader: `docker compose -p gwm-reader stop gwm-reader`.
2. In the My GWM app, change the password and end all other sessions (or remove the vehicle
   share from the secondary account). Check the app for remote commands that you did not send.
3. Change the password of the dedicated e-mail account, and review its 2FA devices.
4. Rotate the MQTT passwords: `rm secrets/mqtt_*_password secrets/mosquitto_passwd &&
   ./scripts/init-secrets.sh`. Then update Home Assistant with the new `homeassistant` password.
5. Drop the stored session tokens: `docker compose -p gwm-reader down -v`. This removes only this
   project's volumes. Never use `docker volume prune`.
6. Write the new login into `secrets/`, and run step 4 again (both passes) before you start the
   reader.

---

## Diagnose a TLS failure on the first real login

gwm-reader always verifies the server certificate. **Never** set `rejectUnauthorized:false`,
`SECLEVEL=0` or `NODE_TLS_REJECT_UNAUTHORIZED=0`. A TLS error is a finding, not an obstacle.

1. Read the reader log: `docker compose -p gwm-reader logs gwm-reader | grep -E 'tls|proxy'`.
   - `error_class: "proxy"` with HTTP 403: the host is not in `proxy/allowlist.local.txt`. This is
     not a TLS problem.
   - `error_class: "tls"`: continue below. The message holds the Node error code.
2. Read the code:
   - `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`, `CERT_UNTRUSTED`: the server
     chain does not end in a public root. On a trusted machine, run
     `openssl s_client -connect <host>:443 -servername <host> -showcerts </dev/null` and read the
     issuer. If GWM's private CA issued it, add **only that CA** with `GWM_EXTRA_CA_FILE`, after you
     check its fingerprint. The file is added to the system roots and never replaces them. Never
     use `gwm_root.cer` blindly as the only trust anchor: that is the upstream mistake
     (AUDIT §7).
   - `ERR_TLS_CERT_ALTNAME_INVALID`: the certificate does not match the host name. Stop: this can
     be interception.
   - `CERT_HAS_EXPIRED`: GWM's problem. Wait, and do not bypass it.
   - A handshake failure, or an alert like "certificate required" or "unknown ca", on
     `br-app-gateway`: the server wants a client certificate. See below.
3. Squid never terminates TLS: `TCP_TUNNEL/200` in its log only means that the tunnel opened.

## Client certificate

The evidence in `docs/AUDIT.md` §8 says that the data gateway requires the client certificate
shipped inside the app (`CN=LGWGWM-AD-BR-GENERAL`, valid until 2027-10-18, the same for all
users). gwm-reader does not bundle or download it.

- Use it only after GWM authorizes this access (checklist "Ask GWM …"). Then put the
  certificate and key in `secrets/gwm_client_cert` and `secrets/gwm_client_key` (0644, inside the
  0700 `secrets/` directory). Enable the commented lines in `docker-compose.override.yml`.
- If the client chain fails because of a SHA-1 intermediate, that is a client-side issue. It never
  justifies turning off server verification.

## The halt state

- After 3 authentication failures in a row, the reader stops polling, publishes
  `gwmbrasil/<id>/reader_error/state = halted`, and remembers this across restarts. This protects
  the account from a login storm.
- To fix it: correct the login in `secrets/`, then run
  `docker compose -p gwm-reader run --rm --no-deps gwm-reader /app/index.js --reset-halt` and start the
  reader again.
- The login cap (3 per rolling hour) still applies after a reset.
