# Runbook: deploy on a single VM

Docker Compose on one Linux VM: PostgreSQL 16, the Go backend, the Web app, coturn, and Caddy with automatic HTTPS (CLAUDE.md §5). The production override is `docker-compose.prod.yml` with `infra/caddy/Caddyfile.prod`; validated with `docker compose … config` and `caddy validate`, and the backend accepts the production environment it sets. A first deployment on a real VM with a public domain has not been done yet (`KNOWN_LIMITATIONS.md`).

## 1. Prerequisites

- A VM with 2 vCPU, 4 GB RAM and 20 GB disk to start (the server never stores files, except Cloud Distribution parts for at most `SA_CLOUD_TTL`), Docker Engine with Compose v2.24.4 or later (`!reset` and `!override` in the override file), and a public IPv4 address.
- DNS: an `A` record for the Web domain (`SA_DOMAIN`, e.g. `share.example.org`) and one for the TURN host (`SA_TURN_HOST`, e.g. `turn.example.org`), both to the VM. **No `AAAA` record** with this layout: the Compose network has no IPv6, so Docker's proxy would hand every IPv6 client to Caddy with the bridge gateway as its address, and all IPv6 users would share one set of per-address limits (one guesser would lock them all out). Serving IPv6 needs Docker IPv6 (`"ipv6": true` and `ip6tables` in `daemon.json`, `enable_ipv6` on the network) or Caddy on the host network, plus the client-address check in §5.
- A TLS certificate and key for the TURN host (coturn terminates TLS itself, ADR 0029): from your ACME client of choice, saved as `turn.crt` and `turn.key` in `SA_TURN_CERT_DIR`, readable by the coturn container, renewed before expiry (restart coturn after renewal).
- An SMTP relay for password-reset mail (`SA_SMTP_ADDR`, credentials if it needs them).

## 2. Firewall

| Port | Protocol | Purpose | Open to |
|---|---|---|---|
| 80, 443 | TCP | Caddy (HTTP redirects, HTTPS, ACME) | Internet |
| 443 | UDP | HTTP/3 | Internet |
| 3478 | UDP, TCP | TURN | Internet |
| 5349 (`SA_TURN_TLS_PORT`) | TCP | TURN over TLS | Internet |
| 49152–65535 | UDP | TURN relay range | Internet |
| 9641 | TCP | coturn usage exporter (relay byte cap) | **Closed** to the Internet, **open from the Docker bridge** (the backend reads it through the host gateway; with `ufw`: `ufw allow from 172.16.0.0/12 to any port 9641 proto tcp`). If the host firewall drops it, the relay cap fails open silently (`sa_turn_usage_unavailable_total` rises) |
| 9090 | TCP | backend metrics listener | **Closed** (published on 127.0.0.1 only; scrape on the VM or through an SSH tunnel) |
| 5432 | TCP | PostgreSQL | **Closed** (not published) |

TURN over TLS on port 443 (best for restrictive networks) needs a second public IP address for coturn, since Caddy holds 443 on the first: set `SA_TURN_TLS_PORT=443` and bind coturn to the second address (`--listening-ip`), ADR 0029.

## 3. Secrets and environment

Create `/etc/share-anywhere/prod.env` (mode 600, owned by the deploy user, never committed):

```bash
SA_DOMAIN=share.example.org
SA_ACME_EMAIL=ops@example.org
POSTGRES_PASSWORD=<openssl rand -base64 32>
SA_TOKEN_KEYS=k1:<openssl rand -base64 32>
SA_TOKEN_ACTIVE_KID=k1
SA_SERVER_SECRET=<openssl rand -base64 32>
TURN_SHARED_SECRET=<openssl rand -base64 32>
SA_TURN_HOST=turn.example.org
SA_TURN_EXTERNAL_IP=<the VM's public IPv4>
SA_TURN_CERT_DIR=/etc/share-anywhere/turn-tls
SA_SMTP_ADDR=smtp.example.org:587
SA_SMTP_USERNAME=<optional>
SA_SMTP_PASSWORD=<optional>
SA_MAIL_FROM=Share Anywhere <no-reply@example.org>
# Optional
SA_ANDROID_CERT_SHA256=<Android App Links, docs/runbooks/android-app-links.md>
SA_APPLE_APP_ID=<Team ID>.app.shareanywhere
SA_CLOUD_ENABLED=false
```

Every variable marked `:?` in `docker-compose.prod.yml` is required: Compose refuses to start without it. `SA_TOKEN_KEYS` signs every access token: keep old key IDs in the list while their tokens live when rotating (ADR 0008). The full list of settings is `.env.example`.

## 4. First deployment

```bash
git clone https://github.com/<owner>/share_anywhere.git /opt/share-anywhere
```

```bash
cd /opt/share-anywhere && docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file /etc/share-anywhere/prod.env up -d --build
```

Migrations run at backend start (`SA_MIGRATE_ON_START`, ADR 0007). Caddy obtains the certificate for `SA_DOMAIN` on the first request.

## 5. Verify

```bash
curl -fsS https://share.example.org/readyz
```

- `/readyz` answers `{"status":"ok"}` (the database is reachable); `/healthz` answers while the process runs.
- Open the Web app, send a small file as a guest from one browser and receive it in another on a different network; the route chip shows Direct or Using relay.
- Relay: in a browser, force relay with a restrictive network (or `chrome://webrtc-internals` shows a `relay` candidate pair), or run `turnutils_uclient -u <user> -w <password> turn.example.org` with credentials from `POST /v1/turn/credentials`.
- Metrics: `curl -s http://127.0.0.1:9090/metrics` on the VM shows the `sa_` counters (the backend image has no shell, so this is the way in).
- Client addresses: after a request from a phone on mobile data, the backend's request log shows a different `ip_hash` from a request from the VM itself; if every client has the same hash, the proxy chain hides client addresses and the per-address limits would treat all users as one (see the DNS note in §1).

## 6. Upgrades and rollback

```bash
git -C /opt/share-anywhere fetch && git -C /opt/share-anywhere checkout <release tag>
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file /etc/share-anywhere/prod.env up -d --build
```

Take a database backup first (`docs/runbooks/backup-restore.md`). Migrations only move forward; to roll back across a migration, restore the backup taken before the upgrade and check out the previous tag. Active P2P transfers survive a backend restart (they reconnect to signaling; the nightly `chaos` job tests this).
