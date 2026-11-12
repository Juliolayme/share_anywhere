# ADR 0030: Cloud Distribution through a server-proxied, S3-compatible store

Status: Accepted (Phase 8, 2026-11-12)

## Context

Phase 8 adds optional Cloud Distribution (PRD §2, §6.6; docs/phases/PHASE_8_ROUTE_TURN_CLOUD.md): a signed-in,
consented sender stores client-side encrypted files so joined receivers (guests too) can finish when P2P fails or
the sender's app is no longer in the foreground (iOS). It must be off by default, budget-capped, TTL-bound, deleted
after delivery, and tested against "MinIO in compose". The backend is capped at eight packages (CLAUDE.md §6).

MinIO stopped publishing container images in 2025: `minio/minio` and `bitnami/minio` can no longer be pulled, so a
pinned MinIO image is not available to compose or CI.

## Decision

- **Server-proxied parts, one stored object per part.** Clients upload `PUT /v1/cloud/objects/{id}/parts/{n}` and
  download `GET …/parts/{n}` through the backend; the backend writes each part as its own object
  (`cloud/<object_id>/<n>`). The object store is never exposed to clients (no presigned URLs, no CORS, no public
  bucket endpoint), every byte passes the same access checks as the rest of the API, and the monthly budget is
  metered exactly (uploads plus downloads). Parts are 4 MiB plaintext, so a part is buffered in memory at most once
  per request; S3 multipart upload (5 MiB minimum parts, upload IDs, completion) is not needed.
- **A minimal SigV4 client** (`backend/internal/platform/objectstore`: put, get, delete, ensure bucket; path-style)
  instead of an SDK dependency, plus an in-memory adapter for development (`SA_CLOUD_STORE=memory`, refused in
  production) and unit tests. It lives under `platform` (infrastructure), and the Cloud service lives in
  `transfers` (Cloud is a transfer route), so the package count stays at eight.
- **Versity Gateway (`versity/versitygw`, Apache-2.0) replaces MinIO** as the S3-compatible store in compose
  (`--profile cloud`), the CI compose stack and the backend CI job, pinned by version. Production can point
  `SA_S3_ENDPOINT` at any S3-compatible service.
- **Off by default, a server flag.** `SA_CLOUD_ENABLED=false` unless set; clients read `GET /v1/cloud/settings`
  (device level, so guests learn `available` and see the disabled option with `product.cloud_signin`) instead of a
  build flag. CI turns it on.
- **Guests:** `POST /v1/files/{id}/distribute` and the upload routes are device level with the account check in the
  handler, so a guest sender gets `403 cloud_requires_account` (PRD §6.6) rather than the generic
  `account_required`; settings writes and estimates are plain `account` routes.
- **End-to-end keys over signaling:** the per-file key is wrapped to the receiver's ephemeral X25519 key and relayed
  as `CLOUD_KEY_REQUEST` / `CLOUD_KEY` (docs/TRANSFER_PROTOCOL.md §9), so neither the store nor the server can read
  files or keys.
- **Lifetime:** `SA_CLOUD_TTL` (24 h default); deleted once every joined receiver posts `received`, or by the
  minute sweep when expired or when the session is no longer live. Pricing is configuration
  (`SA_CLOUD_PRICE_*`); without it estimates carry `cost: null` and clients show `product.cost_unknown`.

## Alternatives considered

- **Presigned URLs straight to the store.** Less backend bandwidth, but exposes the store's host to every client,
  needs CORS for the Web, cannot meter downloads exactly, and a leaked URL is a bearer credential until it expires.
  Worth revisiting behind a CDN when volume grows.
- **The AWS SDK or minio-go.** Large dependency trees for four calls.
- **SeaweedFS or Garage as the test store.** Both work, but need multi-process setup or a layout step before the
  first bucket; the Versity gateway is one process with a POSIX directory.

## Consequences

- Cloud traffic flows through the backend: its bandwidth and the 1,200 part requests per minute per device bound
  throughput. Backlog: presigned or CDN delivery for large deployments.
- Keys live in memory on the sender. A sender that quits before a receiver asked for the key cannot serve it later;
  that receiver keeps the P2P route.
- The object store holds ciphertext only; deleting a session deletes its objects at the next sweep.
