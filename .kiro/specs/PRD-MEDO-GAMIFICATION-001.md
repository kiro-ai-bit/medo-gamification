---
prd_id: PRD-MEDO-GAMIFICATION-001
title: Gamification Service — Harmony Points and Theme state per Patient
application: Medo
component: "Gamification"
profile: backend-microservice
version: "1.0"
status: approved
author: Devin
approver: Sir Asim
approval_date: 22-11-26 05-53-22 UTC
upstream:
  feature_list: docs/features/feature-list.md@2026-11-20
  service_catalog: docs/contracts/service-catalog.md@2026-11-22
  glossary: GLOSSARY.md@2026-11-21
  architecture_standard: docs/architecture/MicroservicesApps-Architecture-Standard.md
downstream: [HLD, LLD, tasks]
hld_readiness: pass
supersedes: none
superseded_by: null
---

# PRD-MEDO-GAMIFICATION-001: Gamification Service — Harmony Points and Theme state per Patient

## 1. Problem statement

Gamification is Medo's Monster Defense layer: it turns dose adherence into a visible defense meter — Harmony Points (lifetime cumulative score) and Theme state (Harmony/Uneasy/Horror) per Patient — rendered on the Today screen and global shell, read identically by the Patient and every linked Caregiver.

Current state: none — greenfield build; there is no workaround in production. The cost of failure is trust, not safety: a score that drifts from dose truth, a theme stuck on Horror after a corrected outcome, or a caregiver seeing another patient's score breaks the core Monster Defense fantasy and silently misrepresents adherence.

Quantification: dose events <5,000/day and <50 concurrent users (`platform-quality-baseline.md`). The binding constraint is correctness of the recompute — ordered floor-0 replay over editable outcomes — not throughput; this service has the smallest write surface of any Medo service (zero public writes, zero scheduled jobs, publishes nothing).

Trace: `docs/features/feature-list.md` §10 (gamification), §3 (authorization — caregiver read parity), §6 (missed = points penalty), Map 1 ticket 10, Map 2 ticket 06, Map 3 tickets 07/09 (sequential consumption, rate limits), Map 4 tickets 01/02.

## 2. Goals and non-goals

### 2.1 Goals

- G-1: Maintain exactly one server-authoritative gamification state per Patient — `{harmonyPoints, themeState, updatedAt}` — updated live on EVERY `DoseOutcomeChanged` event, so the Today screen and global shell always reflect current dose truth. [§1]
- G-2: Compute Harmony Points by ordered floor-0 recompute: replay the patient's stored dose outcomes in scheduled order applying +10/−5/−10/−20 per outcome class, clamping the running total at 0 — never delta arithmetic, never negative, lifetime cumulative with no cap. [§1]
- G-3: Derive Theme state deterministically: the latest Dose by scheduled time carrying a final outcome sets the state — taken-on-time→Harmony, taken-late/skipped→Uneasy, missed→Horror; no outcomes → Harmony. [§1]
- G-4: Serve `GET /v1/patients/{id}/gamification` to the Patient (self) and linked Caregivers (Care `check-link` per read, positive-only ≤15 s cache per Map 3 t09); Caregiver reads are read-only and never create or mutate state. [§1]
- G-5: Self-heal from gaps: pull-bootstrap the full dose-outcome history from Schedule & Dose on first sight of a patient or when an event references an unseen dose, then resume event-synced updates. [§1]
- G-6: Purge all gamification state on `AccountDeleted`, consume events idempotently per `eventId` in `@medo/eventing` sequential order, and run zero scheduled jobs. [§1]

### 2.2 Non-goals

- NG-1: Dose state, schedules, outcome classification, missed-lock — owned by Schedule & Dose Service (Map 2 ticket 04); this service stores outcome *projections* for scoring only, never dose truth.
- NG-2: Doses Remaining / refill detection — owned by Medicine Service; points do not affect it (refill decrements are a separate mechanism).
- NG-3: Reminder delivery, feed, prefs — owned by Notification Service; this service emits no notifications and has no feed.
- NG-4: Care Link lifecycle / check-link ownership — owned by Care Service; this service only calls `check-link` per read.
- NG-5: User accounts / profiles — owned by Identity Service; `patientId` = Identity `userId` for Patient accounts (no separate Patient entity — `frontend-map.md`).
- NG-6: Levels, progression, battles, rewards, streaks, per-caregiver scores — rejected Map 1 ticket 10; v1 is a themed adherence meter only.
- NG-7: Caregiver Harmony Points or any non-Patient score — explicitly rejected Map 1 ticket 10; caregiver dose actions affect the Patient's score only.
- NG-8: Offline score computation — frontend shows last-known or hides the widget offline; score is server-authoritative and API-only (`frontend-map.md` Dexie exclusions).
- NG-9: Any published event (`PointsChanged`/`ThemeChanged`) — no consumer exists (Map 2 ticket 06); live updates reach clients via refetch, not push.
- NG-10: HLD/LLD/implementation — downstream artifacts per Architecture Standard.

## 3. Users, actors, and roles

| Actor | Role (glossary term) | Acts on behalf of | Authz requirement summary |
|---|---|---|---|
| Patient | Patient | self | Reads own `/v1/patients/{id}/gamification` when `patientId` = session `sub` |
| Caregiver | Caregiver | self (account); reads patient gamification via links | Same route; requires active Care Link — `check-link` per read (positive-only ≤15 s cache) |
| Schedule & Dose service | Medo service | Medo platform | Publishes `DoseOutcomeChanged` (consumed here); provides `GET /v1/patients/{id}/doses` + `GET /v1/doses/{id}` for pull-bootstrap |
| Care service | Medo service | Medo platform | Provides `GET /v1/care/check-link` for read authz |
| Identity service | Medo service | Medo platform | Publishes `AccountDeleted` (consumed here) |
| Combined frontend | Medo app | Patient/Caregiver users | Reads the single gamification route for Today screen + global shell; never trusted for authz |
| System | embedded consumer | Medo platform | Sequential `@medo/eventing` consumer; zero scheduled jobs per `scheduled-jobs.md` |

## 4. User stories / capability inventory

Service-scoped stories (backend profile §4):

- US-GAM-01: As a Patient, I want my Harmony Points and Theme state to update the moment any dose outcome changes so that my Monster Defense meter always reflects reality. [FR-GAM-001…006]
- US-GAM-02: As a Patient, I want my score to survive edits — correcting a missed dose to taken restores points correctly — so that the meter rewards honesty, not punishment for fixing mistakes. [FR-GAM-005, 006, 008]
- US-GAM-03: As a linked Caregiver, I want to see the same points/theme I see on the Today screen so that I can support the patient's adherence without a separate score. [FR-GAM-001…003]
- US-GAM-04: As the platform, I want score computation to be a deterministic replay of dose outcomes so that identical histories always produce identical scores. [FR-GAM-005…007]
- US-GAM-05: As the platform, I want automatic recovery when events are missed or the service restarts mid-stream so that scores self-heal without manual repair. [FR-GAM-009, 010]
- US-GAM-06: As the platform, I want account deletion to erase all gamification data and unauthorized reads to fail closed so that no adherence data leaks or persists. [FR-GAM-003, 013, 014]

## 5. Functional requirements

### 5.1 Gamification state & read API

- FR-GAM-001: WHEN `GET /v1/patients/{id}/gamification` is called, the service SHALL authorize the caller as either (a) the Patient (`patientId` = session `sub`) or (b) a Caregiver with an active Care Link to that patient verified via Care `GET /v1/care/check-link?patientId=&caregiverId=`; on success it SHALL return the DTO `{harmonyPoints, themeState, updatedAt}` where `harmonyPoints` is an integer ≥ 0 with no cap, `themeState` ∈ `Harmony | Uneasy | Horror`, and `updatedAt` is the last state mutation time. [US-GAM-01, 03]
  - AC-GAM-001a: authorized patient-self read returns current state — verification: contract test.
  - AC-GAM-001b: authorized linked-caregiver read returns the SAME state as the patient sees — verification: contract test.
  - AC-GAM-001c: patient with no dose outcomes returns `{harmonyPoints: 0, themeState: "Harmony"}` defaults — verification: contract test.
- FR-GAM-002: The `check-link` call SHALL be made per read (no frontend trust); positive answers MAY be cached ≤ 15 s per Map 3 t09 shared-hook semantics, negative/invalid answers SHALL NEVER be cached, and link revocation SHALL take effect within the TTL bound (≤ ~15 s grace, consistent with instant-revoke semantics). [US-GAM-03, 06]
  - AC-GAM-002a: caregiver whose link ended > 15 s ago is denied on next read — verification: integration test (fake clock).
  - AC-GAM-002b: `check-link` unavailable/timeout → read fails closed (deny/503 per baseline matrix), never grants on stale-positive beyond TTL — verification: integration test.
- FR-GAM-003: (negative) WHEN the route is called by a session that is neither the patient nor a linked caregiver — including a caregiver linked to a DIFFERENT patient, an expired/declined invite state, or a malformed `patientId` — the service SHALL deny without revealing whether the patient exists or their score. [US-GAM-03, 06]
  - AC-GAM-003a: cross-patient caregiver read → denied — verification: contract test.
  - AC-GAM-003b: unauthenticated request → 401 — verification: contract test.
  - AC-GAM-003c: denial response body contains no points/theme data — verification: contract test.

### 5.2 Outcome projection & scoring

- FR-GAM-004: WHEN the service consumes `DoseOutcomeChanged` `{doseId, medicineId, patientId, outcome, actorId?, occurredAt}` (envelope `{eventId, occurredAt}`), it SHALL accept only `outcome` ∈ `taken-on-time | taken-late | skipped | missed`; events carrying any other outcome value, snooze signals, or `skippedByUser` plan-skip flags SHALL be ignored for scoring (they carry no point contribution by design — Map 1 ticket 10). [US-GAM-01, 04]
  - AC-GAM-004a: `skippedByUser`/plan-skip produces zero point delta — verification: unit test.
  - AC-GAM-004b: unknown outcome enum value → event counted as failed schema attempt → dead_letters after 5 (zod validation per `@medo/eventing`) — verification: integration test.
- FR-GAM-005: The service SHALL maintain a per-dose outcome projection keyed by `doseId` storing `{patientId, scheduledAt, outcome, occurredAt}`; when multiple events reference the same `doseId`, the record SHALL reflect the event with the latest `occurredAt` (edits until midnight missed-lock update the projection — Map 1 ticket 10). `actorId` SHALL be stored for audit but SHALL NOT affect scoring — caregiver and patient actions produce identical patient-score effects. [US-GAM-02, 04]
  - AC-GAM-005a: outcome edit (e.g. missed → taken-late before midnight) replaces the stored outcome — verification: integration test.
  - AC-GAM-005b: redelivery of an older `occurredAt` event for the same doseId does not regress the projection — verification: unit test.
- FR-GAM-006: Harmony Points SHALL be computed by ordered floor-0 recompute on every projection change: sort the patient's stored outcomes by `scheduledAt` ascending (deterministic tie-break: `doseId`), replay deltas — `taken-on-time` +10, `taken-late` −5, `skipped` −10, `missed` −20 — maintaining a running total clamped `max(0, total + delta)` after each dose; the result is the patient's lifetime `harmonyPoints` (floor 0, no cap). Delta arithmetic against a stored total is FORBIDDEN — floor 0 is non-invertible and edits are unsafe (Map 2 ticket 06). [US-GAM-01, 02, 04]
  - AC-GAM-006a: sequence [+10, −20, +10] in scheduled order → final 0→10→0→10 = 10 (intermediate clamp observable in recompute trace) — verification: unit test.
  - AC-GAM-006b: editing an early dose outcome changes the recomputed total per replay, not by patching the delta — verification: integration test.
  - AC-GAM-006c: snooze and plan-skip outcomes contribute nothing — verification: unit test.
- FR-GAM-007: Theme state SHALL be derived on every recompute as the outcome of the patient's latest dose by `scheduledAt` among stored outcomes: `taken-on-time`→`Harmony`, `taken-late`/`skipped`→`Uneasy`, `missed`→`Horror`; a patient with zero outcome-bearing doses SHALL report `Harmony`. Theme is a pure function of the projection — no separate theme event or state machine. [US-GAM-01, 02]
  - AC-GAM-007a: latest scheduled dose outcome `missed` → `Horror` even if an earlier dose was taken-on-time — verification: unit test.
  - AC-GAM-007b: correcting the latest dose's outcome updates theme on the same recompute — verification: integration test.
- FR-GAM-008: Every accepted `DoseOutcomeChanged` event SHALL trigger an immediate recompute + persist `{harmonyPoints, themeState, updatedAt}` for that `patientId` — live updates on EVERY outcome change, not only at midnight lock (Map 2 ticket 06); there is NO locked-only batching. [US-GAM-01]
  - AC-GAM-008a: two sequential events for the same patient produce monotonically consistent state after each — verification: integration test.
  - AC-GAM-008b: `updatedAt` advances on every persisted recompute — verification: contract test.

### 5.3 Bootstrap, consumption & purge

- FR-GAM-009: WHEN the first `DoseOutcomeChanged` arrives for a `patientId` with no stored outcome projection (first sight), OR an event references a `doseId` absent from the projection (gap), the service SHALL pull-bootstrap BEFORE applying the event: call Schedule & Dose `GET /v1/patients/{id}/doses?from=&to=&outcome=` for the patient's full outcome-bearing dose history, seed the projection, then apply the triggering event; the bootstrap SHALL run at most once per gap episode and SHALL be idempotent under redelivery. [US-GAM-05]
  - AC-GAM-009a: first-ever event for a patient with prior dose history → score reflects full history, not just the new event — verification: integration test (stubbed doses API).
  - AC-GAM-009b: bootstrap upstream failure → event NOT applied, consumer retries per `@medo/eventing` (5 attempts → `dead_letters`); no partial projection — verification: integration test.
  - AC-GAM-009c: bootstrap response containing doses with no outcome contributes nothing to scoring — verification: unit test.
- FR-GAM-010: WHEN a `doseId` in an event is absent from the projection AND absent from a completed bootstrap window (e.g. a newly materialized dose), the service SHALL fetch `GET /v1/doses/{id}` to resolve `scheduledAt` (and confirm `patientId`/`medicineId` consistency), then include it in the projection before recompute; if the dose detail call fails, the event SHALL retry per the standard consumer path. [US-GAM-05]
  - AC-GAM-010a: event for post-bootstrap dose → scheduledAt resolved via dose detail, correct ordering in recompute — verification: integration test.
  - AC-GAM-010b: dose detail returns mismatched `patientId` → event rejected as invalid (no cross-patient contamination) — verification: unit test.
- FR-GAM-011: The service SHALL consume events strictly sequentially in broker order per `@medo/eventing` (`last_event_id` offsets in own DB), giving per-patient ordering for free (Map 3 ticket 07); it SHALL additionally dedupe per `eventId` so at-least-once redelivery never double-applies, and SHALL tolerate defensively out-of-order `occurredAt` per `doseId` via the FR-GAM-005 latest-wins rule. [US-GAM-04, 05]
  - AC-GAM-011a: same `eventId` delivered twice → one projection update — verification: integration test.
  - AC-GAM-011b: consumer restart resumes from stored offset — no event skipped or replayed beyond idempotent re-application — verification: integration test.
- FR-GAM-012: The service SHALL publish NO events — explicit per catalog ("Publishes: none; no `PointsChanged`/`ThemeChanged` — no consumer exists"); score propagation to clients happens exclusively via the read API + frontend refetch (`refetchInterval` ≈ 15 min + post-mutation refresh per `frontend-map.md`). [US-GAM-01]
  - AC-GAM-012a: zero outbound event writes in outbox — verification: contract test / code review.
- FR-GAM-013: WHEN the service consumes `AccountDeleted` `{userId}`, it SHALL purge ALL gamification state for that `patientId` (= `userId` for Patient accounts): the patient state row, the entire per-dose outcome projection, and SHALL emit no further reads of value (subsequent reads deny as patient-unknown); consumption SHALL be idempotent and redelivery a no-op. `AccountDeleted` for a Caregiver `userId` SHALL be a no-op — caregivers hold no gamification state. [US-GAM-06]
  - AC-GAM-013a: post-purge, zero rows remain for the patientId across all gamification tables — verification: integration test.
  - AC-GAM-013b: caregiver `AccountDeleted` → no state change, event consumed cleanly — verification: unit test.
  - AC-GAM-013c: events arriving after purge for that patientId SHALL be ignored (no resurrection) — verification: integration test.
- FR-GAM-014: The service SHALL run ZERO scheduled jobs — explicit per `scheduled-jobs.md` (Medicine/Gamification = zero jobs); all state changes are event-driven or read-time; there is no timer, sweep, or retention job in this service. [US-GAM-06]
  - AC-GAM-014a: no node-cron registrations exist in the service — verification: code review / boot log check.

### 5.4 Boundary & versioning

- FR-GAM-015: The service SHALL expose exactly ONE public route — `GET /v1/patients/{id}/gamification` — and NO internal REST routes (catalog: "Internal REST — None — read API only; no service callers"); it SHALL NOT accept public writes of any kind (score is computed, never client-set). [US-GAM-03]
  - AC-GAM-015a: any write method on the route → 405/404 — verification: contract test.
  - AC-GAM-015b: route enumeration matches catalog exactly — verification: contract test.
- FR-GAM-016: The service SHALL authorize every read server-side per FR-GAM-001…003; the frontend is never trusted, and `patientId` semantics follow `frontend-map.md` (Patient: `patientId` = session `sub`; Caregiver: selected Care Link's `patientId`). [US-GAM-03, 06]
  - AC-GAM-016a: (negative) forged `patientId` in path with caregiver session lacking link → denied — verification: contract test.
- FR-GAM-017: Outbound service calls SHALL use per-service asymmetric JWTs (`aud`-scoped, 5-min, minted per call) per Map 3 t06: `GET /v1/care/check-link` (`aud` Care), `GET /v1/patients/{id}/doses` + `GET /v1/doses/{id}` (`aud` Schedule & Dose); directory lookups are NOT needed (no email/name resolution in this service). [US-GAM-03, 05]
  - AC-GAM-017a: missing/invalid service JWT → upstream rejects; treated as dependency failure per §8.1 — verification: contract test.

## 6. Non-functional requirements

| NFR-ID | Category | Metric + threshold + condition | Source/justification |
|---|---|---|---|
| NFR-GAM-01 | performance/latency | `GET /v1/patients/{id}/gamification` p95 < 300 ms including check-link call (≤15 s cache absorbs repeat reads); event consume→persist recompute p95 < 500 ms per event at <5k dose events/day | `platform-quality-baseline.md` read class + load envelope |
| NFR-GAM-02 | availability/reliability | ~99% during hackathon period; own-DB failure → clean 503; dependency failures degrade per §8.1 — reads fail closed on authz deps, event consumption retries per `@medo/eventing`; score is always recomput-able from projection so no silent corruption | `platform-quality-baseline.md` |
| NFR-GAM-03 | scalability | < 50 concurrent users; < 5,000 dose events/day → outcome events are a small subset; recompute cost = O(doses per patient) per event, trivial at envelope; single instance on EC2 `t3.micro` | `platform-quality-baseline.md` load envelope |
| NFR-GAM-04 | security/authz | Read authz = patient-self OR Care `check-link` per read; positive-only ≤15 s cache, negatives never cached; per-route rate limits per Map 3 t09 (reads 300/min/user, public n/a — route is session-scoped patient route); no patient data in denial responses | Map 2 t06, Map 3 t06/09 |
| NFR-GAM-05 | data/privacy | Harmony Points + Theme = health-adjacent adherence data (PII-adjacent); all state purged on `AccountDeleted`; outcome projection retained for account lifetime (lifetime score requires full history); no backups in v1 (accepted risk); `actorId` stored = attribution PII, minimal | `platform-quality-baseline.md` retention table |
| NFR-GAM-06 | observability | Pino JSON logs + `X-Request-Id`/`eventId` correlation; `GET /metrics` RED + custom counters (gamification reads ok/denied, events consumed per type, recompute count + duration, bootstrap count + failures, dose-detail fallbacks, dead_letters, consumer lag); Sentry project `medo-gamification`; `/health` public, `/ready` checks own DB + `broker_db` | `platform-observability.md` + PRD deltas |

† Offline/resilience and accessibility NFR categories are frontend-profile only — not applicable to this backend PRD.

### 6.1 Scaling & operational needs

- Load profile: the only hot path is event consumption — `DoseOutcomeChanged` volume ≪ 5k dose events/day (only outcome marks/edits/missed-locks emit); reads are one route on the Today screen + global shell, cached ≤15 s on the authz side.
- Scheduled jobs (cite `scheduled-jobs.md`): this service owns ZERO jobs — Medicine/Gamification row is explicit "none". **Delta:** none.
- Statefulness: patient gamification state, per-dose outcome projection, and consumer offsets live in own `gamification_db`; check-link positive cache ≤15 s in-memory per Map 3 t09; no other caches.
- Health: `GET /health` public liveness; `GET /ready` internal readiness checking own Postgres DB + `broker_db` reachability (event consumer). Upstream REST (Care check-link, Schedule & Dose doses) is NOT a readiness dep — it degrades per §8.1.
- Deployment independence: independently containerized per Architecture Standard; runtime couplings are Schedule & Dose doses REST (bootstrap only), Care check-link (per read), `broker_db` event transport — all declared in §10/§11.

## 7. Scope boundaries

### 7.1 In scope

- Gamification state per Patient: `{harmonyPoints, themeState, updatedAt}` — server-authoritative, lifetime, floor 0, no cap.
- Single read route `GET /v1/patients/{id}/gamification` with patient-self + check-link caregiver authz.
- `DoseOutcomeChanged` consumption: per-dose outcome projection, ordered floor-0 recompute (+10/−5/−10/−20), theme derivation, live update on every change.
- Pull-bootstrap via Schedule & Dose doses API on first sight/gap + dose-detail fallback for unseen doseIds.
- `AccountDeleted` purge; idempotent `@medo/eventing` consumption; zero scheduled jobs; publishes none.

### 7.2 Out of scope

- Dose/schedule/outcome truth and missed-lock — Schedule & Dose Service.
- Doses Remaining, refill alerts — Medicine Service (+ Notification delivery).
- Reminders, feed, prefs, push — Notification Service.
- Care Links, invites, check-link ownership — Care Service (this service consumes the check only).
- Users/profiles/credentials — Identity Service.
- Levels, progression, battles, rewards, streaks, per-caregiver scores — rejected Map 1 ticket 10.
- Offline score computation/caching — frontend shows last-known or hides widget (`frontend-map.md`: gamification is API-only, never Dexie-cached).
- Push/event notification of score changes — no `PointsChanged`/`ThemeChanged` events; clients refetch.
- HLD/LLD/implementation → downstream artifacts per Architecture Standard.

### 7.3 Dependencies on locked decisions

- `docs/features/feature-list.md` §10 — points deltas, floor 0, no cap, lifetime, theme mapping, edit-until-midnight recalc, caregiver read parity/no caregiver score, no levels; §3 authorization (caregiver parity, server-side enforcement); §6 missed = points penalty.
- `docs/contracts/service-catalog.md` — Gamification section: single public read route, "Internal REST — None", "Publishes: none", consumes `DoseOutcomeChanged` + `AccountDeleted`; event-catalog payload `{doseId, medicineId, patientId, outcome, actorId?, occurredAt}` + `{eventId, occurredAt}` envelope; `outcome` enum.
- `docs/contracts/frontend-map.md` — Today screen calls this route in parallel fan-out; caregiver gamification view = same endpoint, read-only; gamification is API-only (never Dexie-cached — last-known or hidden offline); `patientId` rule.
- `docs/architecture/platform-quality-baseline.md` — latency/availability/retention/resilience defaults; idempotency rule.
- `docs/architecture/platform-observability.md` — logging/metrics/health/Sentry defaults + consumer counters.
- `docs/architecture/scheduled-jobs.md` — explicit zero-jobs row for this service.
- `GLOSSARY.md` — Patient, Caregiver, Care Link, Dose, Harmony Points, Theme state.
- Map 1 ticket 10 — gamification semantics (deltas, theme machine, editability, no levels, caregiver actions affect patient score only).
- Map 2 ticket 06 — boundary: per-Patient state only, live updates every event, ordered floor-0 recompute (delta rejected), pull-bootstrap on first sight/gap, check-link per read, read API only, `AccountDeleted` purge.
- Map 3 tickets 03/06/07/09 — self-hosted Postgres + Drizzle, per-service JWTs, Postgres outbox sequential consumption (per-patient ordering free), check-link positive-only ≤15 s cache + rate limits.

### 7.4 Open questions

- OQ-GAM-01: Exact `scheduledAt` field name/shape in the doses-window and dose-detail DTOs (needed for FR-GAM-005 ordering) — defined by Schedule & Dose contract/PRD; this PRD consumes whatever ships. Owner: Schedule & Dose HLD; blocks-HLD: no.
- OQ-GAM-02: Bootstrap `from`/`to` window bounds for "full outcome-bearing history" (epoch→now vs bounded lookback) — Schedule & Dose doses API supports `from`/`to`/`outcome` filters; exact pagination strategy is LLD detail. Owner: LLD; blocks-HLD: no.
- OQ-GAM-03: Whether `skippedByUser` plan-skip emits any event at all — assumed NO (it is a flag, not an outcome; `DoseOutcomeChanged` payload has no field for it); FR-GAM-004 ignores it defensively either way. Owner: Schedule & Dose HLD confirmation; blocks-HLD: no.
- OQ-GAM-04: Recompute performance guard — if a patient accumulates very large dose history, whether recompute-per-event needs incremental caching; at <5k events/day envelope full replay is trivial, revisit only if profiling says otherwise. Owner: LLD; blocks-HLD: no.
- OQ-GAM-05: Whether theme/points should appear in any Notification feed row (e.g. milestone alerts) — currently NO consumer and NO feed integration by design (publishes none); would be a future additive feature, not v1. Owner: future map; blocks-HLD: no.

### 7.5 Service boundary statement

The Gamification Service solely owns Harmony Points and Theme state per Patient: the single read route, the per-dose outcome projection used for scoring, the ordered floor-0 recompute, pull-bootstrap via Schedule & Dose, and `AccountDeleted` purge. It does NOT own dose/schedule truth (Schedule & Dose), medicines/refills (Medicine), messaging/feed (Notification), links/authz mechanism (Care — check-link is a consumed call), or users (Identity). It publishes NO events and runs ZERO scheduled jobs. This matches the Gamification heading in `service-catalog.md`.

## 8. Edge cases and failure modes

| Edge case | Requirement/NFR mapping | Notes |
|---|---|---|
| First event for patient with long prior history | FR-GAM-009 | Bootstrap fetches full outcome history before applying event — score never reflects only the newest event |
| Event for doseId unseen post-bootstrap (new materialized dose) | FR-GAM-010 | Dose-detail fallback resolves `scheduledAt`; mismatch `patientId` → reject |
| Outcome edited repeatedly before midnight | FR-GAM-005, 006 | Each edit = new event → projection latest-wins → full replay; score/theme follow current state per Map 1 t10 |
| Missed at midnight then "corrected" — actually locked | FR-GAM-004, 005 | Post-midnight no further outcome events exist (Schedule & Dose locks); projection stable |
| Events arrive while bootstrap in flight | FR-GAM-009, 011 | Sequential consumer → bootstrap completes before next event processed; at most one bootstrap per gap |
| `AccountDeleted` for patient mid-recompute | FR-GAM-013, §8.1 | Purge wins; post-purge events ignored (FR-GAM-013c); no resurrection |
| `AccountDeleted` for caregiver | FR-GAM-013b | No-op — caregivers hold no state; consumed cleanly |
| Duplicate/redelivered event | FR-GAM-011 | Per-`eventId` dedup + latest-`occurredAt` per doseId → idempotent |
| Poison/malformed event payload | FR-GAM-004b | zod validation → failed attempt → `dead_letters` after 5; no partial projection |
| Care `check-link` down during read | FR-GAM-002b, §8.1 | Fail closed — deny/503; ≤15 s positive cache absorbs blips; negatives never cached so revocation still instant |
| Caregiver link ends between cache and read | FR-GAM-002 | ≤15 s positive-cache grace — consistent with Map 3 t09 instant-revoke bound |
| Schedule & Dose doses API down during bootstrap | FR-GAM-009b, §8.1 | Event not applied; consumer retries → dead_letters after 5; manual replay recovers — score self-heals on replay |
| Dose detail call fails for unseen doseId | FR-GAM-010 | Event retries per consumer path; no guessing of `scheduledAt` (ordering correctness depends on it) |
| Patient deletes all medicines/schedules | FR-GAM-006, 007 | Existing projection persists (lifetime score is history); zero NEW outcomes → state frozen at last recompute — accepted: score is lifetime cumulative, not current-schedule |
| `MedicineArchived` consumed? | FR-GAM-004 | NOT subscribed — archived medicine's past outcomes remain in projection (history counts); future doses simply stop producing events. No action needed — verified against catalog (only `DoseOutcomeChanged` + `AccountDeleted` subscribed) |
| Concurrent reads during recompute write | FR-GAM-001, NFR-GAM-02 | Read returns last persisted state (single-row upsert per recompute); brief stale read ≤ one event latency — accepted |
| Huge dose history → slow recompute | FR-GAM-006, OQ-GAM-04 | O(n log n) replay per event; trivial at envelope; profiling guard deferred to LLD |
| Two patients, same caregiver | FR-GAM-003 | Per-patient state isolated by `patientId`; caregiver authz checked per read per patient |
| `patientId` that never existed / no events ever | FR-GAM-001c, 003 | No state → defaults `{0, Harmony}` IF authorized (patient-self with valid session but no doses; nonexistent patientId fails check-link/self-match → denied) |
| Broker consumer lag | FR-GAM-011, NFR-GAM-06 | `last_event_id` offsets + watchdog (platform `broker-watchdog` in Notification service counts lag → Sentry); consumers retry 5× → dead_letters manual replay |

## 8.1 Dependency failure behavior

| Dependency | Failure mode | Required behavior |
|---|---|---|
| Own Postgres `gamification_db` | unavailable/timeout (5 s) | fail-closed → 503 on reads; consumer aborts batch, retries next poll (baseline matrix) |
| Care `GET /v1/care/check-link` | timeout/unavailable | read fails closed (deny/503 per baseline); ≤15 s positive cache absorbs short blips; negatives never cached (FR-GAM-002) |
| Schedule & Dose `GET /v1/patients/{id}/doses` (bootstrap) | timeout/unavailable (3 s + 1 retry) | event not applied; consumer retries per `@medo/eventing` → dead_letters after 5; manual replay recovers (FR-GAM-009b) |
| Schedule & Dose `GET /v1/doses/{id}` (fallback) | timeout/unavailable | event retries per consumer path (FR-GAM-010); no partial projection |
| `broker_db` event transport | consumer failure | sequential retry → `dead_letters` after 5 attempts; platform watchdog alerts; manual replay only (Map 3 t07) |
| Duplicate/redelivered events | at-least-once delivery | per-`eventId` dedup + per-`doseId` latest-`occurredAt` (FR-GAM-011, 005) |
| Poison/malformed event payload | schema validation failure | `@medo/eventing` zod validation → failed attempt → dead_letters after 5; no partial state |

## 9. Data requirements

### 9.1 Owned data

| Entity | Lifecycle | Ownership | Notes |
|---|---|---|---|
| Patient gamification state (patientId, harmonyPoints, themeState, updatedAt) | lazy-create on first recompute → update per event → purge on `AccountDeleted` | owned solely per patient; shared read-only with linked caregivers via authz'd route | Single row per patient; absent row = implicit defaults `{0, Harmony}` |
| Dose outcome projection (doseId PK, patientId, scheduledAt, outcome, actorId?, occurredAt) | insert on first sight of doseId (event or bootstrap) → update on later events → purge on `AccountDeleted` | owned solely per patient (rows keyed by dose, scoped by patientId) | Scoring input only — NOT dose truth; retains history for lifetime recompute |
| Consumer offsets (`last_event_id`) | advance per consumed event | owned solely | `@medo/eventing` pattern (Map 3 t07) |

### 9.2 Consumed/read data

- Schedule & Dose `GET /v1/patients/{id}/doses?from=&to=&outcome=` — provider: Schedule & Dose, contract: internal REST. Pull-bootstrap source for full outcome history (FR-GAM-009); window bounds = LLD detail (OQ-GAM-02).
- Schedule & Dose `GET /v1/doses/{id}` — provider: Schedule & Dose, contract: internal REST. Fallback `scheduledAt`/consistency resolution for doseIds outside the bootstrap window (FR-GAM-010).
- Care `GET /v1/care/check-link?patientId=&caregiverId=` — provider: Care, contract: internal REST. Per-read authz for caregiver reads (FR-GAM-002); positive-only ≤15 s cache per Map 3 t09.

### 9.3 Shared/community data

None — all owned data is per-patient private. No shared/community entities exist in this service.

### 9.4 Retention & deletion

- Patient gamification state + outcome projection: account lifetime — required for lifetime cumulative score and ordered replay; purged ONLY on `AccountDeleted` (FR-GAM-013). No time-based retention applies (baseline retention table has no gamification row → lifetime by necessity).
- Consumer offsets: advance continuously; reset-safe per `@medo/eventing`.
- Dead letters: platform-wide retention (>30d purge by Notification service's `broker-watchdog` — sole writer per `scheduled-jobs.md`).
- No backups in v1 — accepted risk (`platform-quality-baseline.md`).

### 9.5 Sensitive data

- Harmony Points + Theme state = health-adjacent adherence data — treated as PII-adjacent; never logged with patient-identifying detail beyond `patientId`/`doseId` correlation IDs.
- `actorId` in the projection = attribution record (which user marked the dose) — minimal PII, retained for audit; not exposed in the read DTO.
- No emails, names, medicine names, or clinical detail are stored or served by this service — the read DTO is `{harmonyPoints, themeState, updatedAt}` only.

## 10. External contracts touched

| Contract ID (verbatim) | Direction | Sync/Async | Public/Internal | Authz | Idempotent? | Catalog ref |
|---|---|---|---|---|---|---|
| `GET /v1/patients/{id}/gamification` | exposes | REST | public | patient-self or linked caregiver (check-link per read) | n-a (read-only) | catalog §Gamification public REST |
| `GET /v1/patients/{id}/doses?from=&to=&outcome=` | consumes | REST | internal | service-JWT (`aud` Schedule & Dose) | n-a (read-only bootstrap) | catalog §Schedule & Dose internal REST |
| `GET /v1/doses/{id}` | consumes | REST | internal | service-JWT (`aud` Schedule & Dose) | n-a | catalog §Schedule & Dose internal REST |
| `GET /v1/care/check-link?patientId=&caregiverId=` | consumes | REST | internal | service-JWT (`aud` Care) | n-a (positive-only ≤15 s cache) | catalog §Care internal REST |
| `DoseOutcomeChanged` | consumes | event | internal | n-a | idempotent per eventId + per-doseId latest-occurredAt | catalog §Event catalog |
| `AccountDeleted` | consumes | event | internal | n-a | idempotent consumer (FR-GAM-013) | catalog §Event catalog |

Publishes: **none** — explicit per catalog.

### 10.1 Exposed contracts — detail

- Single route `GET /v1/patients/{id}/gamification` — sync REST under `/v1`, returns boundary DTO `{harmonyPoints, themeState, updatedAt}`; no writes exist; `updatedAt` = last persisted recompute time.
- DTO rule: response carries no internal fields (no per-dose breakdown, no actorIds, no eventIds) — consumers cannot reconstruct dose history from this route by design.
- Route is patient-scoped per catalog convention (`/patients/{patientId}/`); `patientId` = Identity `userId` for Patient accounts.

### 10.2 Consumed contracts — detail

- `GET /v1/patients/{id}/doses?from=&to=&outcome=` (Schedule & Dose): bootstrap source — the ONLY bulk dose-history read; must return enough per dose to seed `{scheduledAt, outcome, occurredAt-equivalent}` projections; exact window/pagination = OQ-GAM-02 (LLD).
- `GET /v1/doses/{id}` (Schedule & Dose): per-dose fallback for doseIds outside bootstrap coverage; response must expose `scheduledAt` + `patientId` for consistency check (OQ-GAM-01 — field names per Schedule & Dose PRD).
- `GET /v1/care/check-link?patientId=&caregiverId=` (Care): per-read caregiver authz; returns active-link boolean; positive answers cacheable ≤15 s, negatives/invalid never cached (Map 3 t09).

### 10.3 Events published & subscribed

- Published: **none** — explicit per catalog ("Publishes: none — no `PointsChanged`/`ThemeChanged` — no consumer exists").
- Subscribed (2 types, via `@medo/eventing` sequential in-order consumption with own-DB `last_event_id` offsets):
  - `DoseOutcomeChanged` (Schedule & Dose) → projection update + ordered floor-0 recompute + theme derive + persist (FR-GAM-004…008, 009, 010).
  - `AccountDeleted` (Identity) → purge all patient gamification state (FR-GAM-013); caregiver `userId` = no-op.
- Required reaction + idempotency: per-`eventId` dedup on every applied event (FR-GAM-011); per-`doseId` latest-`occurredAt` wins (FR-GAM-005); 5 attempts → `broker_db.dead_letters`, manual replay only.
- `UserRegistered`/`ProfileChanged`/`EmailVerificationRequested`/`PasswordResetRequested`/5 Care events/`RefillThresholdCrossed`/`MedicineArchived` are NOT subscribed — no scoring or authz relevance; `MedicineArchived` deliberately unsubscribed (past outcomes remain history — §8 edge table).

### 10.4 Authorization requirements

- The single public route authorizes per read: `patientId` = session `sub` → allow; otherwise session must be a Caregiver with active Care Link → Care `check-link` required (FR-GAM-001); frontend never trusted.
- Caregiver reads are READ-ONLY by construction — no write routes exist at all (FR-GAM-015); a caregiver cannot mutate score even in principle.
- No internal REST routes exposed (catalog: "Internal REST — None").
- Outbound calls carry per-service asymmetric JWTs (`aud`-scoped, 5-min, minted per call, Map 3 t06): `aud` = Care / Schedule & Dose respectively.
- `check-link` is a CALL, not a cache of link state — this service stores zero link/invite state (Map 2 t02 rule preserved).
- Denial responses reveal nothing about patient existence or score (FR-GAM-003c).

### 10.5 Versioning & compatibility

- Exposed REST under `/v1`; the DTO `{harmonyPoints, themeState, updatedAt}` may gain fields additively (e.g. future `level`, `streak`) without breaking — consumers must tolerate unknown fields.
- Evolution rule: additive-only within `/v1`; breaking changes require a new version prefix + migration note per Architecture Standard.
- Known consumers constraining evolution: the combined frontend Today screen + global shell + caregiver view (`frontend-map.md`) — it expects exactly this DTO shape; Schedule & Dose constrains THIS service via the doses-window/dose-detail DTOs it consumes (OQ-GAM-01/02).
- Event schema evolution: additive-only unless versioned; `DoseOutcomeChanged`/`AccountDeleted` payloads may gain fields, never lose/rename without versioning — zod schemas must tolerate additive fields.
- Score semantics are contract-relevant: delta values (+10/−5/−10/−20), floor-0 ordered recompute, and theme mapping are locked by Map 1 t10 — changing them is a feature change requiring map reopening, not a PRD revision.

## 11. Dependencies and integrations

### 11.1 Upstream dependencies

- Own Postgres `gamification_db` — patient state, outcome projection, offsets. Failure → fail closed, 503 (baseline matrix).
- Schedule & Dose `GET /v1/patients/{id}/doses` + `GET /v1/doses/{id}` — bootstrap + fallback reads; 3 s + 1 retry; failures retry via consumer path (FR-GAM-009b/010).
- Care `GET /v1/care/check-link` — per-read authz; same retry semantics; fail-closed on reads (FR-GAM-002).
- `broker_db` event transport via `@medo/eventing` — 2 event subscriptions; consumer offsets in own DB.
- Identity — `AccountDeleted` event only (no REST consumption; no directory lookups needed).

### 11.2 Downstream dependents

- Combined frontend — the single public route via gateway: Today screen parallel fan-out (points + theme render), global shell palette, caregiver gamification view (read-only). Gateway public-route table must list it (Map 3 t05).
- Schedule & Dose — this service is a consumer of its doses REST (bootstrap only, low volume) and `DoseOutcomeChanged` events; its event payload is load-bearing for scoring correctness.
- Care — provides `check-link`; its `CareLinkEnded`/link lifecycle indirectly bounds read authz via TTL.
- API gateway (Caddy/nginx) — pass-through proxy; the route is session-authenticated (NOT public-unauthenticated).
- UptimeRobot — `GET /health` liveness target (platform-observability.md).

### 11.3 Ordering constraints

- Bootstrap MUST complete before the triggering event is applied (FR-GAM-009) — otherwise first-sight scores under-count history.
- Consumers must treat both events as at-least-once and per-`eventId` idempotent; sequential ordering per `last_event_id` offsets preserved — this is what makes per-patient recompute ordering correct (Map 3 t07).
- `AccountDeleted` purge should complete before any expectation of read denial; post-purge events are ignored by design (FR-GAM-013c) — ordering vs in-flight `DoseOutcomeChanged` is safe either way because purge deletes the projection the event would update.
- Deploy order unconstrained: service tolerates upstream outages via retry/dead-letter; score correctness self-heals on event replay because recompute is a pure function of the projection + bootstrap can re-seed.
- No DNS/domain prerequisites — this service has no email, no push, no external webhooks.

## 12. Success metrics

| Goal | Metric | Instrumentation | Guardrails |
|---|---|---|---|
| G-1 | State freshness: events consumed→persisted latency; reads returning post-event state | consumer offset lag + recompute duration histogram + `/metrics` | Zero state mutations outside event consumption (invariant — no public writes exist) |
| G-2 | Recompute correctness: replay determinism — identical projection → identical `{points, theme}` every time | unit-test suite + recompute trace logging (debug level) | Points never negative, never decrease below floor-0 replay result (invariant); deltas exactly {+10,−5,−10,−20} |
| G-3 | Theme correctness: theme = f(latest scheduled outcome) — 100% match vs projection-derived expectation | contract tests per outcome class + integration tests | Zero theme states outside {Harmony, Uneasy, Horror} (invariant) |
| G-4 | Authz correctness: denied reads = 0 data leakage; check-link called per uncached read | read ok/denied counters + check-link call counter | Zero cross-patient reads (invariant); zero cached negatives (invariant) |
| G-5 | Bootstrap coverage: first-sight/gap events resulting in complete-history scores | bootstrap counter + post-bootstrap projection size vs upstream count | Zero scores computed without bootstrap when history exists (invariant) |
| G-6 | Purge completeness: `AccountDeleted` → zero surviving rows | post-purge verification queries + consumer counters | Zero surviving gamification data post-deletion (invariant) |
| G-7 | Consumption health: per-type consumed counts, dedup hits, dead_letters, lag | consumer offsets + `/metrics` + platform watchdog | Zero unprocessed events after replay; idempotent redelivery = no double-apply |

## 13. Assumptions and constraints

- Locked decisions cited, not re-decided: gamification semantics — deltas +10/−5/−10/−20, floor 0, lifetime, no cap, no levels, theme machine, edit-until-midnight, caregiver actions affect patient score only, no caregiver score (Map 1 t10); per-Patient state only, live updates every event, ordered floor-0 recompute with delta rejected, pull-bootstrap on first sight/gap, check-link per read, read API only, `AccountDeleted` purge (Map 2 t06); sequential in-order consumption giving per-patient ordering, per-service JWTs, check-link ≤15 s positive cache (Map 3 t06/07/09); zero scheduled jobs (Map 4 t02 / `scheduled-jobs.md`).
- Technical constraints already decided: Node.js + TypeScript + Fastify + Drizzle (Map 3 t01); self-hosted PostgreSQL `gamification_db` (Map 3 t03); `@medo/eventing` consumption pattern (Map 3 t07); per-service asymmetric JWTs for outbound calls (Map 3 t06).
- This PRD assumes the Architecture Standard's four-layer backend structure and one-combined-frontend topology; it does not re-decide them.
- "Final outcome" (Map 1 t10 theme wording) is interpreted as: any recorded outcome value on a dose — outcomes are editable until midnight but always carry one of the 4 final classes once set; theme follows the latest scheduled dose WITH a recorded outcome. Pre-outcome doses (pending/unmarked) never set theme.
- Floor-0 semantics interpreted as running clamp during ordered replay (`max(0, total + delta)` per dose in scheduled order) — consistent with "lifetime cumulative, floor 0" + "recalculated in scheduled order" (Map 1 t10) and "ordered floor-0 recompute" (Map 2 t06); delta arithmetic explicitly rejected there.
- `skippedByUser` plan-skip and snooze produce no `DoseOutcomeChanged` (they are not outcomes — Schedule & Dose contract `outcome` enum has 4 values); FR-GAM-004 ignores non-enum values defensively regardless (OQ-GAM-03).
- Archived medicines: their historical outcomes remain in the projection (lifetime score = history); `MedicineArchived` is deliberately NOT subscribed — no score decay on archive (verified vs catalog subscription list).
- Score has no read-after-write guarantee across service restarts beyond event-sourcing correctness: projection + offsets in own DB make consumption resumable; bootstrap covers first-sight only, NOT routine restarts (offsets prevent re-processing).
- `patientId` = Identity `userId` for Patient accounts — no separate Patient entity (`frontend-map.md`); a Caregiver `userId` never has gamification state.
- Domain selection remains map fog — irrelevant to this service (no URLs/emails generated).

## 14. Glossary and terminology

Terms used → `GLOSSARY.md` anchors: **Patient**, **Caregiver**, **Care Link**, **Dose**, **Harmony Points**, **Theme state**.

Avoid-list compliance: "Harmony Points"/"Theme state" used only in glossary sense; no "score/points/health" substitutions for Harmony Points in prose (the glossary avoid-list bans score/points/health AS the term — descriptive use like "the score" is avoided; "gamification state"/"meter" used instead); no "level/progression/battle" (rejected scope); no "drug/medication/prescription" for Medicine; "outcome" used only for Dose outcomes.

New technical terms (flagged `proposed-glossary-entry` for HLD/LLD clarity):

- **Outcome projection** — this service's per-`doseId` stored copy `{patientId, scheduledAt, outcome, actorId?, occurredAt}` used solely for scoring replay; explicitly NOT dose truth (Schedule & Dose owns that).
- **Ordered floor-0 recompute** — the scoring algorithm: replay projection in `scheduledAt` order applying +10/−5/−10/−20 with running `max(0, …)` clamp; delta arithmetic forbidden (Map 2 t06).
- **Pull-bootstrap** — the one-time (per gap) `GET /v1/patients/{id}/doses` history fetch that seeds the projection before the first/gap event is applied (Map 2 t06).
- **Theme derivation** — pure function: outcome of latest `scheduledAt` dose with a recorded outcome → Harmony/Uneasy/Horror; no separate state machine.
- **Final outcome** — any of the 4 `DoseOutcomeChanged` outcome classes once recorded on a dose (editable until midnight, but always one of the final classes); distinct from pending/unmarked.

## 15. Traceability matrix

| Need (feature-list §) | Goal | Story | FR/NFR | Contract(s) | Verification |
|---|---|---|---|---|---|
| §10 points rules (+10/−5/−10/−20, floor 0, lifetime, no cap) | G-2 | US-GAM-01, 04 | FR-GAM-005, 006 | `DoseOutcomeChanged`, doses REST | unit + integration tests (replay vectors) |
| §10 theme state machine (Harmony/Uneasy/Horror, latest outcome) | G-3 | US-GAM-01, 02 | FR-GAM-007 | projection | unit + integration tests per outcome class |
| §10 live updates on every outcome change (editable until midnight) | G-1, G-2 | US-GAM-01, 02 | FR-GAM-005, 008 | `DoseOutcomeChanged` | integration tests (edit sequences) |
| §10 server-authoritative, shared patient+caregivers | G-1, G-4 | US-GAM-01, 03 | FR-GAM-001…003, 012 | read route, check-link | contract + integration tests |
| §10 no levels / no caregiver score | — | US-GAM-03 | FR-GAM-003, 015, NG-6/7 | read route | contract tests (single DTO, no caregiver state) |
| §3 authorization (caregiver parity reads, server-side enforcement) | G-4, G-6 | US-GAM-03, 06 | FR-GAM-001…003, 016, 017 | check-link | contract tests (cross-patient denial) |
| §6 missed = points penalty (−20) | G-2 | US-GAM-01 | FR-GAM-006 | `DoseOutcomeChanged` (missed) | unit test |
| Map 2 t06 pull-bootstrap on first sight/gap | G-5 | US-GAM-05 | FR-GAM-009, 010 | doses REST | integration tests (stubbed upstream) |
| Map 2 t06 ordered recompute, delta rejected | G-2 | US-GAM-04 | FR-GAM-006 | projection | unit tests (replay determinism) |
| Map 3 t07 sequential consumption = per-patient ordering | G-5 | US-GAM-05 | FR-GAM-011 | `@medo/eventing` | integration tests (ordering, dedup) |
| Map 3 t09 check-link cache + rate limits | G-4 | US-GAM-03 | FR-GAM-002, NFR-GAM-04 | check-link | integration tests (TTL, fail-closed) |
| `scheduled-jobs.md` zero jobs | G-6 | US-GAM-06 | FR-GAM-014 | — | boot/code review |
| Account deletion safety | G-6 | US-GAM-06 | FR-GAM-013 | `AccountDeleted` | integration tests (purge completeness) |
| Platform NFRs | — | — | NFR-GAM-01…06 | `/metrics`, `/health`, `/ready` | metric checks + smoke tests |

## Appendix A. Alternatives considered

- **Delta arithmetic vs ordered floor-0 recompute** — recompute chosen Map 2 t06: floor 0 is non-invertible (a later +10 cannot "refund" an earlier clamped −20 correctly); replay over stored projection is deterministic and edit-safe. Rejected storing `points += delta`.
- **Locked-only batching vs live updates every event** — live updates chosen Map 2 t06 + Map 1 t10: outcomes editable until midnight means points must follow current state continuously; no midnight-only recompute.
- **Caregiver score vs patient-only state** — patient-only chosen Map 1 t10: one shared meter per Patient; caregiver actions affect the patient's score; no per-caregiver tracking exists.
- **Push events (`PointsChanged`) vs read-API-only** — read-only chosen Map 2 t06: no consumer exists for score events; frontend refetches (15-min interval + post-mutation) per `frontend-map.md`; avoids event-surface for zero benefit.
- **Store full dose snapshots vs minimal projection** — minimal projection `{scheduledAt, outcome, occurredAt, actorId?}` chosen: scoring needs only ordering key + outcome class; full dose data stays in Schedule & Dose (DTO rule, no truth duplication).
- **Bootstrap on every restart vs offsets-only** — offsets-only for restarts (consumer resumes, no re-processing); bootstrap reserved for first-sight/gap where projection is incomplete (Map 2 t06).
- **Subscribe `MedicineArchived`/`CareLinkEnded` etc.** — rejected: archived medicine history still counts (lifetime score); link state is never stored (check-link per read, ≤15 s TTL bounds revocation grace); subscription list stays minimal per catalog.
- **Levels/streaks/battles** — rejected Map 1 t10: v1 is a themed adherence meter, not a battle game; additive future scope only.
- **Caching gamification in Dexie** — rejected `frontend-map.md`: score is server-authoritative/cosmetic; frontend shows last-known or hides widget offline; Dexie slice is doses+medicines+schedules+queue only.

## Appendix B. HLD-readiness checklist result

- Result: **pass**
- Date: 22-11-26 (draft self-check vs `prd-standard.md` §7 + `prd.schema.json`)
- Checker: Devin (self-check; `D:\Temp\validate_prd.py` run at draft time)
- Conditions: none — all decisions trace to closed Maps 1–3 + Map 4 tickets 01–04; remaining OQs are HLD/LLD detail (DTO field names, bootstrap window bounds, plan-skip event confirmation). `hld_readiness` mirrors this verdict pending user approval.
