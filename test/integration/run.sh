#!/usr/bin/env bash
# Integration test: the real compose stack (project gwm-reader-it, never the
# owner's gwm-reader project) with a mock GWM behind Squid. It contacts no
# GWM host and uses only throwaway, fictitious secrets.
#
# Cleanup is always `docker compose -p gwm-reader-it ... down -v` (never a
# global prune), plus the temporary directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
P=gwm-reader-it
IT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gwm-reader-it.XXXXXX")"
export IT_DIR
files=(-f docker-compose.yml -f test/integration/compose.it.yml)
compose=(docker compose -p "$P" "${files[@]}")
node_image="node:24.22.0-alpine3.23@sha256:e44c87c7dd212720eb00469aeac89504ca2be77b8f0d6dbffb30665d5fcc59e1"
fail=0

# shellcheck disable=SC2317  # called through the EXIT trap
cleanup() {
  if [[ "${IT_KEEP:-}" == 1 ]]; then
    echo "IT_KEEP=1: stack kept. Clean up with: IT_DIR=$IT_DIR ${compose[*]} down -v; rm -rf $IT_DIR"
    return
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$IT_DIR"
}
trap cleanup EXIT

step() { printf '\n== %s ==\n' "$*"; }
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@"; then echo "PASS $d"; else echo "FAIL $d"; fail=1; fi
}

step "throwaway PKI, secrets and allowlist in $IT_DIR"
mkdir -p "$IT_DIR/pki" "$IT_DIR/secrets"
(
  cd "$IT_DIR/pki"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj "/CN=gwm-reader IT CA" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=mock-gwm" 2>/dev/null
  printf 'subjectAltName=DNS:mock-gwm\n' > ext.cnf
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 2 -extfile ext.cnf 2>/dev/null
  chmod 0644 ./*.pem ./*.key
)
printf 'owner@example.invalid\n' > "$IT_DIR/secrets/gwm_username"
printf 'not-a-real-password\n' > "$IT_DIR/secrets/gwm_password"
for u in gwm_reader homeassistant kinestra_bridge; do
  head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$IT_DIR/secrets/mqtt_${u}_password"
done
chmod 0644 "$IT_DIR"/secrets/*
mosquitto_image="$(awk '$0 ~ "^  mosquitto:$" {f = 1; next} f && /^  [a-z]/ {exit} f && $1 == "image:" {print $2; exit}' docker-compose.yml)"
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$IT_DIR/secrets:/s" "$mosquitto_image" sh -c '
  : > /s/mosquitto_passwd
  for u in gwm_reader homeassistant kinestra_bridge; do mosquitto_passwd -b /s/mosquitto_passwd "$u" "$(cat /s/mqtt_${u}_password)" >/dev/null 2>&1; done'
chmod 0644 "$IT_DIR/secrets/mosquitto_passwd"
printf '# integration test only\nmock-gwm\n' > "$IT_DIR/allowlist.txt"

step "start the stack"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"${compose[@]}" up -d --build --wait mosquitto squid mock-gwm >/dev/null
"${compose[@]}" up -d gwm-reader >/dev/null
for _ in $(seq 1 60); do
  "${compose[@]}" logs --no-log-prefix gwm-reader 2>/dev/null | grep -q '"msg":"status published"' && break
  sleep 1
done
check "the reader published a status from the mock" bash -c "${compose[*]} logs --no-log-prefix gwm-reader | grep -q '\"msg\":\"status published\"'"

step "hardening as deployed"
cid="$("${compose[@]}" ps -q gwm-reader)"
check "reader runs as 65532, read-only rootfs, no capabilities, no-new-privileges" bash -c "
  [[ \$(docker inspect $cid --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}') == '65532:65532 true [\"ALL\"] [\"no-new-privileges:true\"]' ]]"
check "reader is attached only to the internal network" bash -c "
  [[ \$(docker inspect $cid --format '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}') == '${P}_mqtt_internal ' ]]"
check "the internal network has no external access" bash -c "[[ \$(docker network inspect ${P}_mqtt_internal --format '{{.Internal}}') == true ]]"
check "no service publishes a host port" bash -c "for c in \$(${compose[*]} ps -q); do [[ -z \$(docker port \$c) ]] || exit 1; done"

step "network boundary, measured inside the gwm-reader container"
probe="$("${compose[@]}" run --rm --no-deps -T -v "$root/test/integration:/it:ro" --entrypoint /nodejs/bin/node gwm-reader /it/netprobe.js 2>/dev/null | tail -n 1)"
echo "$probe"
jq_get() { node -e 'const o=JSON.parse(process.argv[1]);console.log(o[process.argv[2]])' "$probe" "$1"; }
check "direct TCP to 1.1.1.1:443 fails" bash -c "[[ '$(jq_get direct_ip)' =~ ^(ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED)$ ]]"
check "direct TCP to 8.8.8.8:80 fails" bash -c "[[ '$(jq_get direct_ip_80)' =~ ^(ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED)$ ]]"
check "public DNS does not resolve" bash -c "[[ '$(jq_get dns_public)' != RESOLVED ]]"
check "proxy refuses a host that is not allowlisted (403)" test "$(jq_get proxy_not_allowlisted)" = 403
check "proxy allows the allowlisted mock (200)" test "$(jq_get proxy_allowlisted_mock)" = 200
check "proxy refuses a non-443 port (403)" test "$(jq_get proxy_mock_other_port)" = 403

step "MQTT ACL and end-to-end tests (node:test inside the internal network)"
if [[ "${IT_SKIP_NODE:-}" == 1 ]]; then
  echo "SKIP node:test suites (IT_SKIP_NODE=1)"
elif timeout 300 docker run --rm --network "${P}_mqtt_internal" --user "$(id -u):$(id -g)" \
  -v "$root:/w:ro" -v "$IT_DIR/secrets:/it-secrets:ro" \
  -e NODE_PATH=/w/haval-h6-mqtt/node_modules -e MQTT_URL=mqtt://mosquitto:1883 \
  "$node_image" node --test --test-concurrency=1 /w/test/integration/acl.test.js /w/test/integration/e2e.test.js; then
  echo "PASS node:test integration suites"
else
  echo "FAIL node:test integration suites"; fail=1
fi

step "the mock saw only allowlisted read routes"
"${compose[@]}" logs --no-log-prefix mock-gwm | grep '"route"' | sed -E 's/.*"route":"([^"]+)".*/\1/' | sort | uniq -c
check "no unexpected request reached the mock" bash -c "! ${compose[*]} logs --no-log-prefix mock-gwm | grep -q UNEXPECTED"

step "first-run.sh report on these logs"
report="$(GWM_READER_PROJECT="$P" GWM_READER_COMPOSE_ARGS="${files[*]}" ./scripts/first-run.sh --report "$since")"
echo "$report"
check "report shows the tunnel to the mock" grep -q "TCP_TUNNEL/200 mock-gwm:443" <<< "$report"
check "report shows the denied probe" grep -q "TCP_DENIED/403 example.com:443" <<< "$report"
check "report shows the audited status path" grep -q "route audit GET mock-gwm/app-api/api/v1.0/vehicle/getLastStatus" <<< "$report"
check "the report never shows the VIN or the e-mail" bash -c "! grep -qE 'TESTVIN9XK2PQ7RZ4|owner@example.invalid' <<< \"\$1\"" _ "$report"
check "the reader logs never show the VIN, e-mail, password or coordinates" bash -c "! ${compose[*]} logs --no-log-prefix gwm-reader | grep -qE 'TESTVIN9XK2PQ7RZ4|owner@example.invalid|not-a-real-password|-10\.123456|-30\.654321'"

echo
if [[ $fail -eq 0 ]]; then echo "integration: all checks passed"; else echo "integration: FAILED"; fi
exit $fail
