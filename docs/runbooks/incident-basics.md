# Runbook: incident basics

First steps for the incidents this system can have. Commands assume the production stack (`docs/runbooks/deploy.md`); shorten them with `alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file /etc/share-anywhere/prod.env'`.

## Where to look

- **Health:** `curl -fsS https://<domain>/readyz` (database reachable) and `/healthz` (process up).
- **Logs:** `dc logs --since 30m backend` (JSON; tokens, emails, codes and IP addresses are redacted or hashed by design, `docs/SECURITY_MODEL.md` §8), `dc logs coturn`, `dc logs caddy`.
- **Metrics:** `dc exec backend wget -qO- localhost:9090/metrics` — request and transfer counters by route and outcome (`sa_transfer_route_*`), code lookups and protected mode (`sa_code_lookups_failed_total`, `sa_protected_mode_on_total`), TURN (`sa_turn_credentials_issued_total`, `sa_turn_relay_cap_refused_total`, `sa_turn_usage_unavailable_total`), WebSocket presence drops, Cloud counters.

## Common incidents

| Symptom | Likely cause | Action |
|---|---|---|
| `/readyz` 503, Web shows "Couldn't set up this device" | PostgreSQL down or full | `dc ps`, `dc logs postgres`, check disk (`df -h`, `docker system df`); restart `dc restart postgres`. The backend reconnects on its own (nightly `chaos` job); P2P transfers keep going meanwhile |
| Every device signed out at once after a deploy | `SA_TOKEN_KEYS` changed or lost (new kid without the old one) | Put the previous key back in the list (`old:…,new:…`) and restart the backend; devices refresh with their refresh secrets |
| Joins by code wait for approval everywhere; senders see "Extra check" | Protected mode (failed code lookups above `SA_CODE_GUESS_ALARM_PER_MIN`, default 300, ADR 0031) | Expected under a guessing attack; it lapses after 30 minutes. Check `sa_code_lookups_failed_total` and the request log for the source; links and QR still join directly |
| Transfers between restrictive networks fail; relay never used | coturn down, firewall, expired TURN certificate, or wrong `SA_TURN_EXTERNAL_IP` | `dc logs coturn`; check ports (§2 of the deploy runbook) and the certificate dates; `turnutils_uclient` against the TURN host |
| `relay_cap_reached` for receivers; `sa_turn_usage_unavailable_total` rising | Relay byte cap reached (by design), or the coturn exporter unreachable (cap fails open) | The cap is per session (`SA_GUEST_RELAY_BYTES_CAP`, `SA_ACCOUNT_RELAY_BYTES_CAP`); for the exporter check port 9641 on the host gateway |
| coturn memory or the exporter's response growing over weeks | One metrics series per ephemeral username (ADR 0029) | Restart coturn in a quiet hour (`dc restart coturn`); active relays reconnect |
| Many `429 rate_limited` from one network | Users behind one shared IPv4 address (CGNAT) or an attack | Per-address limits are deliberate (ADR 0031); look at the request log's IP hash spread before acting. There is no allowlist |
| Cloud uploads paused | Account budget used (`403 cloud_budget_exhausted`) | Expected; the user raises the budget in Settings or waits for the month to turn |
| Password-reset mail missing | SMTP relay refused or misconfigured | `dc logs backend` filtered for `mail` (no addresses are logged); test the relay credentials |

## Suspected secret leak

- `TURN_SHARED_SECRET`: set a new value in the env file and restart coturn and the backend together; credentials issued with the old secret stop working within their TTL (30 or 60 minutes).
- `SA_TOKEN_KEYS`: add a new kid, make it active, restart; remove the old kid after 15 minutes (the access-token lifetime).
- `SA_SERVER_SECRET`: rotate and restart; outstanding proof-of-work challenges and join tickets become invalid (seconds to minutes).
- Database dump: treat as a personal-data breach (emails, device records); refresh secrets are stored hashed and history and clipboard are end-to-end encrypted.

## After the incident

Write down the timeline, the cause, and the follow-up in the operations log; add a test when the cause was a defect (the nightly jobs are the place for failure-injection cases).
