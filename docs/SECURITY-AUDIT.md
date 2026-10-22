# gwm-reader — security audit (run-1) and resolution

This page records stage 7: a full `/security-audit` (vendored cloudflare/security-audit-skill, the
`standard` profile, all six phases) of the fork at `ee85725` on `hardened`, and what was done with
each result. The complete, schema-validated run records are in
[`docs/security-audit/`](security-audit/):

- `findings.json`;
- `coverage-ledger.json`;
- `REPORT.md`, `FINDINGS-DETAIL.md` and `NEEDS-VALIDATION.md`;
- `architecture.md` and `run-metadata.json`;
- the evidence files under `agents/<id>/artifacts/`.

## How the audit ran

- **Agents:** 29 invocations (budget 30):
  - 4 reconnaissance agents;
  - 9 hunters in 4 coverage waves;
  - 4 post-wave critics and 1 final-clean critic;
  - 5 independent candidate verifiers (Phase 3);
  - 5 independent record verifiers (Phase 5).
- **Independence:** no agent verified a candidate it found.
- **Coverage:** 19 ledger units, coverage closed. The wave 4 critic and the distinct final-clean
  critic both returned no further work.
- **Execution:** source review plus bounded local checks, all in `docker run --network none
  --read-only --env-file /dev/null --cap-drop ALL --security-opt no-new-privileges`, with
  CPU/memory/pids/file-size limits and a wall-clock kill.
  - Broker and proxy checks shared one isolated loopback namespace.
  - Evidence was promoted with a no-follow, size-bounded copier.
- **Never touched:** no request to `*.gwmcloud.com` or any external host, no real credential, and
  no change to GitHub settings.
- **Not observed:** live GWM behaviour, the gitignored allowlist and override, the GitHub repository
  settings, and the HA frontend rendering. One run does not exhaust the target.

## Results and resolution

| # | Verdict | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | confirmed | **medium** | A read-only MQTT user (`homeassistant`, `kinestra_bridge`) could CONNECT with the reader's fixed client id. The broker took over the reader's session and fired its retained `offline` will, a write to `gwmbrasil/#` that the ACL denies. HA showed every entity unavailable until a restart. | **Fixed** in `41171b1`: `use_username_as_clientid true`, and the reader republishes `online` on every connect. Unit and integration regression tests. Side effect: one session per MQTT user (README, RUNBOOK 5b). |
| 2 | confirmed | low | Squid `dstdomain` without `-n` matched an IP-literal CONNECT by its reverse-DNS name. A PTR record set to a GWM host opened a tunnel to an arbitrary IP, an exfiltration path for code already inside `mqtt_internal`. | **Fixed** in `8876aab`: `dstdomain -n` plus a deny for IPv4/IPv6 literal targets. The integration netprobe expects 403. |
| 3 | confirmed | low | An unbounded GWM `body.code` caused quadratic regex backtracking in `redactString` (about 27 s for 64 kB at 0.5 CPU). This blocked the event loop, made the broker drop the reader, and was published raw in the retained `reader_error`. | **Fixed** in `1fb22ee`: API codes are validated (`^[A-Za-z0-9_-]{1,16}$`, else `invalid`), every redaction quantifier is bounded, and input is capped at 8192 chars. Regression tests: 1 MiB hostile strings take well under 1 s. |
| 4 | confirmed | low | A GWM tire-temperature value with `\|` or markdown forged `status_message` records, and the shipped HA markdown card rendered links and remote images. | **Fixed** in `a2e38b4`: the temperature must be numeric; dashboard parts are filtered to plain text and unknown records are not rendered. Unit test and dashboard scan. |
| 5 | needs_validation | — | `main` mirrors upstream, so it keeps the publish-and-sign workflow and the HA add-on repository. A new upstream workflow merges into `hardened` with no conflict. Whether any of it runs depends on GitHub settings (Actions are **off** on the fork). | **In-repo part fixed** in `4d24786`: `repo-guard.test.js` (only `ci.yml`, read-only; packaging stays deleted; no network module outside `httpClient.js`), plus the README merge checklist and corrected claims. **Owner action pending** (below). |

No finding gives vehicle control, credential disclosure or code execution. The read-only core held:

- route allowlist, live gate, TLS (also through the tunnel), file-only secrets and redaction;
- the 0600/0700 state file, the login cap and the halt;
- container isolation and the read-only CI.

## Owner actions that stay open

1. **Repository settings:** done on 2026-10-22. `hardened` is the default branch. Actions may run
   only SHA-pinned `actions/checkout`, `actions/setup-node` and `actions/upload-artifact`, and the
   default token is read-only (README, "Update from upstream"). Still open: never push to or sync
   `main`, which keeps unreviewed upstream workflows and the add-on repository.
2. **One MQTT session per user:** keep it in mind when you attach Home Assistant and the Kinestra
   bridge. Create a separate read-only user for any debugging tool (RUNBOOK 5b).
3. Run `docs/RUNBOOK.md` before any live use, as before.

## Hardening backlog (non-findings)

The hunters recorded about 40 hardening notes. They are in
[`docs/security-audit/REPORT.md`](security-audit/REPORT.md) §5. The notes most worth doing next:

- a single-flight login (two timers can spend 2 of the 3 hourly logins);
- fail-closed `Store.load` (a corrupt `state.json` clears the halt flag and the login history);
- clamp future-dated login attempts after a clock step;
- validate `MQTT_URL` (no userinfo) and register the MQTT password for redaction;
- restrict snapshot items to the `map.js` codes;
- cap the charge-log list;
- broker limits (`message_size_limit`, `max_queued_messages`) and Squid connection limits;
- a tokenizer-based read-only source scan;
- bind the TLS `servername` to the CONNECT host;
- accept `GWM_EXTRA_CA_FILE` only in fixture mode.
