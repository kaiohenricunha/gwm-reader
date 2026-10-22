#!/usr/bin/env bash
# OWNER ONLY. The controlled first run against the real GWM cloud.
#
# It starts the stack, lets gwm-reader run for a short window, then prints:
#   1. every CONNECT the proxy saw (host:port and whether it was allowed);
#   2. every route the reader sent or blocked (method, host, path; never
#      the query string, the body or a credential).
# Then it stops gwm-reader again (pass --keep to leave it running).
#
# With the placeholder proxy/allowlist.txt every CONNECT is denied, so the
# first pass reaches nothing and only shows which domains the reader wants.
# Review them, write the approved ones to proxy/allowlist.local.txt, and run
# this script again to see the paths. See docs/RUNBOOK.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
window="${FIRST_RUN_SECONDS:-90}"
keep=false
[[ "${1:-}" == "--keep" ]] && keep=true

if [[ "${GWM_LIVE_ENABLED:-}" != "true" ]]; then
  echo "refusing: set GWM_LIVE_ENABLED=true for this command only, after the owner checklist in docs/RUNBOOK.md" >&2
  exit 2
fi
for s in gwm_username gwm_password mqtt_gwm_reader_password mosquitto_passwd; do
  if [[ ! -s "secrets/$s" ]]; then
    echo "refusing: secrets/$s is missing or empty (run scripts/init-secrets.sh, then write your My GWM login)" >&2
    exit 2
  fi
done

compose=(docker compose -p gwm-reader)
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GWM_LIVE_ENABLED=true "${compose[@]}" up -d --build
echo "gwm-reader is running; collecting ${window}s of logs ..."
sleep "$window"

echo
echo "== 1. proxy CONNECT attempts (squid) =="
"${compose[@]}" logs --no-log-prefix --since "$since" squid \
  | awk '$4 == "CONNECT" {print $3, $5}' | sort | uniq -c | sort -rn || true

echo
echo "== 2. routes sent or blocked (gwm-reader) =="
"${compose[@]}" logs --no-log-prefix --since "$since" gwm-reader \
  | grep -E '"msg":"route (audit|blocked)"' \
  | sed -E 's/.*"msg":"(route [a-z]+)".*"method":"([A-Z]+)".*"host":"([^"]+)".*"path":"([^"]+)".*/\1 \2 \3\4/' \
  | sort | uniq -c | sort -rn || true

echo
echo "== 3. reader state =="
"${compose[@]}" logs --no-log-prefix --since "$since" gwm-reader \
  | grep -E '"level":"(warn|error)"|"msg":"(login succeeded|vehicle selected|status published|reader halted.*)"' | tail -n 20 || true

if ! $keep; then
  "${compose[@]}" stop gwm-reader
  echo "gwm-reader stopped (use --keep to leave it running)."
fi
