# ADR 0029: TURN over TLS, and a loopback relay for tests

Status: Accepted (Phase 8, 2026-11-12)

## Context

The route ladder (docs/ARCHITECTURE.md §6, PRD §6.3) is Direct P2P → TURN over UDP → TURN over TCP/TLS 443. The
production TURN server must therefore also accept TLS on 443, which on most hosts is already taken by Caddy (the
Web app and the API). The phase also asks for forced-relay tests on all three clients in CI, where the browsers,
the iOS Simulator and the Android emulator run on one machine and the backend stack runs in Docker.

## Decision

- **coturn terminates TLS itself on its own port**, `tls-listening-port`, with its own certificate for the TURN
  host name. In production that port is 443 on a separate IP address (or a separate host) from Caddy, so neither
  needs SNI routing or a TCP proxy in front. `SA_TURN_URIS` lists `turns:<host>:443?transport=tcp` next to the UDP
  URI. Dev and CI use port 5349 (no privileged port in a container).
- **Clients pick URIs per policy step**: `all` uses every URI; `relay-udp` only UDP TURN; `relay-tls` only `turns:`
  (TURN over TCP when no TLS URI is configured). Every step but `all` is relay-only.
- **Tests use a separate coturn configuration** (`infra/coturn/turnserver.ci.conf`) on the host network, listening
  and relaying only on 127.0.0.1, with `allow-loopback-peers` and `allowed-peer-ip=127.0.0.1`. Relay-only clients
  on the machine reach each other through it: browsers and the iOS Simulator at 127.0.0.1, the Android emulator at
  10.0.2.2 (the emulator's alias for the host loopback). The production-shaped `infra/coturn/turnserver.conf`
  keeps denying every private and loopback peer.
- **The test certificate is generated at run time** by `scripts/turn-test-cert.sh` (self-signed, two days, never
  committed). Test clients accept it explicitly: the Playwright receiver for the TLS case launches Chromium with
  `--ignore-certificate-errors`; the Android and iOS test hooks use WebRTC's insecure TLS policy in test builds only.
- **coturn exports Prometheus metrics with username labels** (`prometheus`, `prometheus-username-labels`), which
  the backend reads for the relay byte cap per session (docs/SECURITY_MODEL.md §5).

## Alternatives considered

- **Caddy passing TLS through to coturn on 443 (layer-4 routing by SNI).** Needs a non-standard Caddy build with
  the layer-4 module and puts the TURN traffic on the Web edge.
- **Docker bridge networking with port mapping for tests.** The relay addresses are then container addresses in
  172.16.0.0/12; reaching them from the host needs the whole relay port range mapped and private peers allowed,
  and the emulator cannot reach them at all.

## Consequences

- Production needs a second IP address (or host) and a certificate for the TURN name; the deployment runbook
  (Phase 9) covers renewal.
- The CI coturn is reachable only from the runner itself, and only relays to 127.0.0.1.
