#!/usr/bin/env bash
# Self-signed certificate for TURN over TLS in CI and local relay tests (docs/ADR/0029-turn-tls-and-test-relay.md).
# Written to $1 (default .tools/turn-tls); never committed. Production uses a real certificate for the TURN host.
set -euo pipefail
out="${1:-.tools/turn-tls}"
mkdir -p "$out"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
  -keyout "$out/turn.key" -out "$out/turn.crt" >/dev/null 2>&1
chmod 644 "$out/turn.key" "$out/turn.crt"
echo "$out"
