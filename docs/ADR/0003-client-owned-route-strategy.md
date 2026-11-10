# ADR 0003: Clients own route selection

Status: Accepted (Phase 0, 2026-11-10)

## Context

PRD §2 fixes route selection as per receiver, decided by the client and recorded by the server. Route quality (direct, TURN UDP, TURN TCP/TLS, Cloud) is only observable at the endpoints through WebRTC `getStats()`. A backend that tried to choose routes would act on stale, second-hand data and would need per-receiver state that the clients already hold.

## Decision

- Route selection, ETA, hysteresis, and fallback live in the clients' transfer engines (`web/src/features/transfer/engine`, Android `transfer/engine`, iOS `ShareAnywhereCore/Transfer`).
- The backend issues TURN credentials to participants who may use them and records the chosen route per transfer for metrics only (`docs/ARCHITECTURE.md` §6).
- The backend stays within eight packages (`CLAUDE.md` §6).

## Consequences

- The route policy must be implemented three times against shared test vectors; Phase 8 adds classifier and hysteresis vectors to `shared/protocol/schemas/`.
- Server-side metrics show what clients chose, not what they could have chosen.
