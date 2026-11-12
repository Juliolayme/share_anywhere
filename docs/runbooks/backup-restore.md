# Runbook: backup and restore

What holds state, what to back up, and how to restore. The dump and restore commands below were run against the Compose CI stack (custom-format dump, restore into a new database, row counts of `devices`, `share_sessions`, `session_participants`, `transfers` and the migration table matched).

## What holds state

| Data | Where | Back up? |
|---|---|---|
| Accounts, devices, refresh-secret hashes, sessions, transfer records, encrypted history and clipboard, cloud metadata | PostgreSQL (`pgdata` volume) | **Yes**, daily |
| Secrets: `SA_TOKEN_KEYS`, `SA_SERVER_SECRET`, `TURN_SHARED_SECRET`, `POSTGRES_PASSWORD`, SMTP credentials | `/etc/share-anywhere/prod.env` | **Yes**, in a password manager or secrets store, not with the database dumps |
| TLS certificates and ACME account | Caddy (`caddydata` volume); the TURN certificate in `SA_TURN_CERT_DIR` | Optional (Caddy re-issues; keep the TURN certificate's source) |
| Cloud Distribution parts | S3-compatible store (`s3data` volume or the external bucket) | No: encrypted, temporary (at most `SA_CLOUD_TTL`), useless without the keys held by clients |
| Files being shared | Nowhere on the server (peer to peer) | — |

Losing `SA_TOKEN_KEYS` signs every device out of its access token (devices refresh with their refresh secrets once new keys are in place); losing the database loses every account and device identity (clients create new anonymous identities; accounts cannot be recovered).

## Daily database backup

```bash
cd /opt/share-anywhere && docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file /etc/share-anywhere/prod.env exec -T postgres pg_dump -U shareanywhere -d shareanywhere -Fc > /var/backups/share-anywhere/db-$(date -u +%Y%m%dT%H%MZ).dump
```

Run it from cron or a systemd timer, keep 14 daily and 8 weekly copies, and copy them off the VM (encrypted, e.g. with `age` or the storage provider's server-side encryption). The dump contains email addresses and device records: treat it as personal data.

## Restore

Stop the backend so nothing writes (`docker compose … stop backend`), then recreate the database and restore:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file /etc/share-anywhere/prod.env exec -T postgres psql -U shareanywhere -d postgres -c "DROP DATABASE shareanywhere" -c "CREATE DATABASE shareanywhere OWNER shareanywhere"
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file /etc/share-anywhere/prod.env exec -T postgres pg_restore -U shareanywhere -d shareanywhere --no-owner < /var/backups/share-anywhere/<file>.dump
```

Start the backend with the **same secrets** as when the dump was taken (`SA_TOKEN_KEYS`, `SA_SERVER_SECRET`): `docker compose … start backend`. Migrations newer than the dump apply at start.

Verify `/readyz`, sign in with a test account, and run a guest transfer.

## Restore drill

Quarterly: restore the latest dump into a scratch database on a separate host (`CREATE DATABASE restore_check`, `pg_restore`), compare row counts of the tables above with production, then drop it. Record the date and result in the operations log.
