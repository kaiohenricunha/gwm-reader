#!/usr/bin/env bash
# Create ./secrets for gwm-reader. Idempotent: existing files are kept.
#
#   - random MQTT passwords for gwm_reader, homeassistant and kinestra_bridge;
#   - secrets/mosquitto_passwd, hashed with the broker's own mosquitto_passwd;
#   - EMPTY gwm_username and gwm_password files, so Compose can start. The
#     owner writes the real values later (docs/RUNBOOK.md); this script never
#     asks for them and never prints a secret.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/secrets"
umask 077
mkdir -p "$dir"
chmod 0700 "$dir"

for user in gwm_reader homeassistant kinestra_bridge; do
  f="$dir/mqtt_${user}_password"
  if [[ ! -s "$f" ]]; then
    head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32 > "$f"
    echo "created $(basename "$f")"
  fi
done

for s in gwm_username gwm_password; do
  [[ -e "$dir/$s" ]] || { : > "$dir/$s"; echo "created empty $s (the owner fills it in later)"; }
done

# The containers run as non-root users, so the secret files must be
# readable by them. secrets/ itself stays 0700, so other host users cannot
# reach the files.
chmod 0644 "$dir"/mqtt_*_password "$dir/gwm_username" "$dir/gwm_password"

mosquitto_image="$(awk '$0 ~ "^  mosquitto:$" {f = 1; next} f && /^  [a-z]/ {exit} f && $1 == "image:" {print $2; exit}' "$root/docker-compose.yml")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$dir:/in:ro" -v "$tmp:/out" "$mosquitto_image" sh -c '
  set -e
  : > /out/passwd
  for user in gwm_reader homeassistant kinestra_bridge; do
    mosquitto_passwd -b /out/passwd "$user" "$(cat /in/mqtt_${user}_password)" 2>/dev/null
  done'
install -m 0644 "$tmp/passwd" "$dir/mosquitto_passwd"
echo "wrote mosquitto_passwd (users: gwm_reader, homeassistant, kinestra_bridge)"
