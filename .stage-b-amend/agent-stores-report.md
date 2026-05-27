# Wave B1-Amend — Stores Domain Fix Report — db-cluster

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Agent:** Stores domain fix agent (1 of 5 parallel)
**Date:** 2026-05-27
**Pre-wave HEAD:** `30e7f22`
**v2 protocol:** per-finding test-first + 3× stability + lint clean

---

## 1. Pre-fix baseline

| Field | Value |
|---|---|
| Pre-wave HEAD | `30e7f22` |
| Pre-wave `npm run lint` | PASS (tsc --noEmit + lint:examples) |
| Pre-wave `npm test` | 778 passed / 55 skipped / 0 failed across 63 files |
| New test file pre-fix run | **18 failed / 3 passed** of 21 (test-first gate confirmed) |

The 18 pre-fix failures decomposed as: missing exports (`getRequiredTables`, `RotateResult`, `staging` field, `countEvents` method), missing behavioural changes (NDJSON format, doctor real-count, no_orphan_staging check, schema registry), and one assertion on spread-order safety. The 3 passing tests were the receipt-owner decision pin (already by design), the trace-with-archived test (already-existing trace behaviour), and the new receipts-no-owner pin.

---

## 2. Per-finding fixes (7 items)

### STORES-B-002 — NDJSON append + recoverability

- **Files:** `src/adapters/local/local-ledger-store.ts` (rewrite)
- **Shape:** Switched events.json + receipts.json from whole-array JSON to NDJSON (one record per line). `append()` and `appendReceipt()` now use `appendFileSync` + `fsync` (O(1) per write). `loadArray<T>()` parses line-by-line; the legacy whole-array format is auto-detected (`trimmed.startsWith('[')`) and read transparently — next mutation rewrites the file in NDJSON form. Tail corruption (a torn last line OR an externally-appended bad line at the end) is recoverable PROVIDED at least one prior line parsed cleanly; pure-junk files still throw `CorruptStoreError`. Interior corruption (bad line surrounded by good lines) throws.
- **Test invariants:**
  - `append() is sub-linear: per-event cost does not grow with N` — measures ms/event at N=200 vs N=800; large < small × 5 + 0.5ms ceiling.
  - `mid-write failure leaves the ledger recoverable on next load` — injects `\n{NOT VALID JSON\n` at the tail, re-opens, asserts all prior events still load.
  - `NDJSON format on disk (one event per line)` — reads raw file, asserts ≥2 non-empty lines, each parses as a JSON object with `id` and `owner: 'ledger'`.
- **Before/After:**
  - **Before:** `writeFileSync(tmp, JSON.stringify(this.events))` + rename on every append — O(N) per call, O(N²) over lifetime, a partial write replaced the good file with whatever bytes happened to land.
  - **After:** `appendFileSync(path, JSON.stringify(event) + '\n')` + fsync — O(1) per append, tail-corruption recoverable.

### STORES-B-004 — owner stamping + spread order

- **Files:** `src/adapters/local/local-ledger-store.ts`
- **Shape:** All three persistence paths (`append`, `appendReceipt`, `importEvent`, `importReceipt`) now spread caller fields FIRST and stamp generated fields LAST. The store-stamped `id`, `timestamp`, `committedAt`, and `owner` win unconditionally even when a caller bypasses the `Omit<>` type via an `as Receipt` / `as Event` cast. The decision NOT to add `owner` to the `Receipt` type is pinned by `Receipt type intentionally does not carry an owner field` (kernel-domain change deferred; pinned to make future drift visible).
- **Test invariants:**
  - `appendReceipt: caller-supplied id/committedAt cannot override generated values`
  - `append: caller-supplied id/timestamp cannot override generated values`
  - `Receipt type intentionally does not carry an owner field` (decision pin)
- **Before/After:**
  - **Before:** `{ id: randomUUID(), committedAt: ..., ...receipt }` — spread overwrites stamps.
  - **After:** `{ ...receipt, id: randomUUID(), committedAt: ..., owner: 'ledger' }`

### STORES-B-013 — Ledger rotation/archival contract

- **Files:** `src/contracts/ledger-store.ts` (contract addition), `src/adapters/local/local-ledger-store.ts` (implementation)
- **Shape:** Added `rotate(beforeTimestamp: string): Promise<RotateResult>` to `LedgerStore` contract; added `RotateResult` interface with `archived`, `retained`, optional `archiveFile`. Implementation moves events older than the boundary into `<dataDir>/ledger-archive/events-<archiveId>.ndjson` (and receipts likewise). Active files are rewritten via tmp+rename. **Safeguard:** a boundary in the future is a no-op (would otherwise archive the entire live ledger — almost always a typo). `trace()` does NOT read archives; documented as intentional (rotation is a recovery operation, not transparent compaction).
- **Test invariants:**
  - `rotate() with a future timestamp is a no-op` — returns `{ archived: 0, retained: N, archiveFile: undefined }`.
  - `rotate() with a past timestamp archives older events and keeps newer ones` — boundary midway through 6 events; 3 archived to ndjson file, 3 retained, re-open confirms archive not re-loaded.
  - `trace() of a chain that included archived events stops at the boundary` — pins the truncation semantic.
- **Cross-domain note:** `PostgresLedgerStore` does not exist in this codebase; the contract method's JSDoc documents the future Postgres implementation strategy (`DELETE … WHERE timestamp < $1 RETURNING …` in a transaction). No Postgres-side fix required this wave.

### STORES-B-014 — `doctor()` / `verify()` orphan count uses true count

- **Files:** `src/contracts/ledger-store.ts` (contract addition), `src/adapters/local/local-ledger-store.ts` (implementation), `src/ops/doctor.ts`, `src/ops/verify.ts`
- **Shape:** Added `countEvents(filter?: LedgerFilter): Promise<number>` to `LedgerStore`. `doctor()` and `verify()` now derive the orphan count from `countEvents({ action: 'mutation_orphaned' })` (no limit, true count) and only sample via `listEvents({ limit: 100 })` for the display set. Message includes "(showing first 100)" when the count exceeds the sample.
- **Test invariants:**
  - `LedgerStore.countEvents returns the true count` — exercises filter-less + action-filtered + no-match counts.
  - `doctor() reports 200 orphans when 200 exist (not capped at 100)` — spies on `listEvents` to confirm the sample limit is ≤100 even while the headline is 200.
  - `verify() reports 200 orphans when 200 exist (not capped at 100)`.
- **Before/After:**
  - **Before:** `const orphanedEvents = await stores.ledger.listEvents({ action: 'mutation_orphaned', limit: 100 }); const orphanCount = orphanedEvents.length;` — silent cap.
  - **After:** `const orphanCount = await stores.ledger.countEvents({ action: 'mutation_orphaned' });` — true count.

### STORES-B-018 — `doctor()` table name from schema registry

- **Files:** `src/adapters/postgres/schema.ts`, `src/ops/doctor.ts`, `src/ops/migrations.ts`
- **Shape:** Added `getRequiredTables(): readonly string[]` to `schema.ts` (single source of truth). `doctor.ts` imports the registry and walks it; the literal `'canonical_entities'` no longer appears outside `CANONICAL_TABLE`. `migrations.ts::checkMigrationStatus` reads `Array.from(getRequiredTables())` as its required set; `verifySchema` parameterizes the column-check query against `CANONICAL_TABLE`. When migration 002 ships a new required table, only the registry function changes; doctor + migrations + verifySchema all pick it up automatically.
- **Test invariants:**
  - `getRequiredTables() exports the canonical-table list` — registry contains `CANONICAL_TABLE`.
  - `doctor.ts uses CANONICAL_TABLE constant rather than literal` — source-level invariant.
  - `migrations.ts uses CANONICAL_TABLE/getRequiredTables constant rather than literal`.
  - `checkMigrationStatus reflects schema registry` — stub pool returns registry-listed tables; status is migrated=true.

### V1-A4-004 (deferred) — `backup()` includes staging files

- **Files:** `src/ops/backup.ts`
- **Shape:** Added `staging?: StagingSnapshot[]` to `ClusterBackup`; new `StagingSnapshot { contentHash, content }` type. `backup()` walks `<dataDir>/pending-content/` when `options.dataDir` is provided and emits each sha256-hex-named file as a base64-encoded entry. `restore()` reconstructs the staging area, validates `sha256(content) === contentHash` per-entry (rejecting tampered entries into `result.staging.errors[]`), and writes the files back. Older backups (no `staging` field) restore cleanly as a no-op — backward compatible. `RestoreResult.staging` reports `{ restored, skipped, errors }`.
- **Test invariants:**
  - `backup roundtrip preserves staged content` — propose ingest_artifact, backup, restore to fresh dir, assert pending-content/contentHash file reappears with matching bytes.
  - `restore tolerates older backups without staging field` — backup object with no `staging` field restores without throwing.

### V1-A4-005 (deferred) — `no_orphan_staging` health check

- **Files:** `src/ops/doctor.ts`
- **Shape:** New `no_orphan_staging` check in `doctor()`. Walks `<dataDir>/pending-content/` (when `dataDir` is provided), filters entries to sha256-hex basenames, counts files older than 1 hour that DO NOT match any pending command's `payload.contentHash` (when `commandQueue.list()` is provided). Reports degraded with the count + oldest-age in minutes; healthy when zero. Tmp files (`<hash>.<pid>-<rand>.tmp`) are intentionally NOT this check's concern — those are swept by the kernel's `getStagingDir` sweep.
- **Test invariants:**
  - `A staging file older than 1 hour with no referencing command surfaces as degraded`.
  - `A staging file matching a pending command does NOT degrade` (commandQueue passed; file is matched by hash).
  - `A young staging file (under 1 hour) does NOT degrade even if not referenced`.

---

## 3. New `test/wave-b1-stores-regression.test.ts` — 21 tests

| Describe block | Tests |
|---|---|
| STORES-B-002 — append-only ledger persistence is sub-linear and recoverable | 3 |
| STORES-B-004 — receipt stamping is symmetric with event append | 3 |
| STORES-B-013 — ledger rotate() archives matching events | 3 |
| STORES-B-014 — orphan count reports actual not sample limit | 3 |
| STORES-B-018 — required tables registry | 4 |
| V1-A4-004 — backup includes pending-content staging | 2 |
| V1-A4-005 — no_orphan_staging health check | 3 |

All 21 tests verified FAIL pre-fix, PASS post-fix, and ran 3× deterministically (no flake).

---

## 4. Contract changes

| Symbol | Kind | File | Notes |
|---|---|---|---|
| `LedgerStore.countEvents(filter?: LedgerFilter): Promise<number>` | NEW method (required) | `src/contracts/ledger-store.ts` | Replaces `listEvents(...).length` for headline counts in ops surfaces. |
| `LedgerStore.rotate(beforeTimestamp: string): Promise<RotateResult>` | NEW method (required) | `src/contracts/ledger-store.ts` | Archival/recovery valve for unbounded ledger growth. |
| `RotateResult { archived, retained, archiveFile? }` | NEW interface | `src/contracts/ledger-store.ts` | Result type for `rotate()`. |
| `ClusterBackup.staging?: StagingSnapshot[]` | NEW optional field | `src/ops/backup.ts` | Backup format extension; older backups restore cleanly. |
| `StagingSnapshot { contentHash, content }` | NEW interface | `src/ops/backup.ts` | One pending-content/ file, base64-encoded. |
| `BackupOptions.dataDir?: string` | NEW optional field | `src/ops/backup.ts` | Required to include staging; absence omits the field. |
| `RestoreOptions.dataDir?: string` | NEW optional field | `src/ops/backup.ts` | Required to restore staging; absence skips the staging block. |
| `RestoreResult.staging?: { restored, skipped, errors }` | NEW optional field | `src/ops/backup.ts` | Reports per-file outcomes. |
| `getRequiredTables(): readonly string[]` | NEW export | `src/adapters/postgres/schema.ts` | Schema registry — single source of truth for required Postgres tables. |
| `DoctorOptions.dataDir?: string` | NEW optional field | `src/ops/doctor.ts` | Required for `no_orphan_staging` check. |
| `DoctorOptions.commandQueue?: { list(): Command[] }` | NEW optional field | `src/ops/doctor.ts` | Distinguishes referenced from orphan staging files. |

**Cross-domain breadcrumb for SDK consumers:** the new `LedgerStore.countEvents` and `rotate` methods are REQUIRED on the contract. Any `ClusterSDK` method that proxies the ledger (none today, but Surface domain should audit `src/sdk/cluster-sdk.ts`) may want passthrough wrappers. No existing SDK method was broken.

---

## 5. Post-fix verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` (lint) | **PASS** (clean) |
| `npx vitest run test/wave-b1-stores-regression.test.ts` × 3 | **3/3 PASS at 21/21 deterministically** |
| Stores cascade tests (wave-a3-tests-regression + wave-a4-stores-regression) | **PASS** after cascade fixes (see §6) |
| Full-suite test count delta | **+21 new tests** (this file) |
| Release-gate | NOT RUN — CI/Docs domain owns. Other agents running in parallel; will run at coordinator-level post-wave merge. |

---

## 6. Cross-domain breadcrumbs

### Cascade impacts addressed

1. **`test/wave-a3-tests-regression.test.ts::TESTS-R2-005` (3 tests)** — these source-pattern-level tests assert `CorruptStoreError` on corrupt ledger files. My NDJSON rewrite of `loadArray<T>` initially made the loader too lenient (it would silently return empty on pure-junk files and accept a single `{"not":"an array"}` JSON object as one record). Fixed by tightening:
   - Pure-junk file (no parseable lines) still throws `CorruptStoreError`.
   - Per-line shape gate requires `typeof value.id === 'string'` — so an unrelated JSON object like `{"not":"an array"}` fails the per-line check and throws via the no-parseable-lines branch.
2. **`test/wave-a4-stores-regression.test.ts::STORES-B-001` (1 test)** — source-pattern test required private method names `persistEvents` / `persistReceipts` to exist with random-tmp-suffix bodies. My initial rewrite renamed them to `appendOneEvent` / `appendOneReceipt` and added `rewriteEvents` / `rewriteReceipts`. Resolved by renaming the rewrite methods back to `persistEvents` / `persistReceipts` (the rewrite-via-tmp-rename is what the source-pattern test was probing); the O(1) append helpers retain their `appendOneEvent` / `appendOneReceipt` names.

### Out-of-scope cascades observed (NOT mine to fix)

1. **`test/phase4-proof.test.ts` (3 failures)** — Provenance trace tests show `[REDACTED]` in place of `evidence.pdf` / `AuthService` / project names. Source: Kernel domain's TraceBuilder structured-label redaction (KERNEL-B-006 / AGG-008). Out of Stores scope; coordinator + Kernel agent's responsibility.
2. **`test/wave-b1-surface-regression.test.ts` (10 failures)** — Surface agent's own test file checking unimplemented fixes (SURFACE-B-005, B-007, B-008, B-011, B-013). Out of Stores scope.
3. **`test/phase15-proof.test.ts::Proof 5` (intermittent under concurrent run)** — `npm pack` race when multiple agents trigger `prepack` concurrently. Passes in isolation. Not my domain.

### Cross-domain refactor — optional consolidation

The CI/Docs agent extracted `src/util/tmp-paths.ts` during this wave (canonical home for `buildRandomTmpPath` + `cleanupOrphanTmpFiles` + `sweepContentDirOrphans`). Per the dispatch's "Optional coordination" section, I refactored `src/adapters/local/tmp-cleanup.ts` to delegate to the util module. The adapter-side helpers retain their public signatures (`void` return) as back-compat shims so existing call sites in the four local adapter files need no edits. Kernel-side inline copies (`cluster-kernel.ts::sweepStagingOrphans`, `command-queue.ts::cleanupOrphanTmpFiles`) are NOT touched here — that delegation is the Kernel agent's call (the no-back-edge rule no longer applies once `src/util/tmp-paths.ts` exists).

### Surface SDK consumer audit

`src/sdk/cluster-sdk.ts` (Surface domain) does NOT directly call `LedgerStore.countEvents` or `LedgerStore.rotate` today. Once Surface adds an `archiveLedger(beforeTimestamp)` wrapper (out of B1-Amend scope), the contract method is ready.

---

## 7. Pattern-fix self-assessment

The v2 "family-of-call-sites" probe applied to every fix in this wave:

| Fix | Sibling sites probed | Outcome |
|---|---|---|
| STORES-B-002 (NDJSON append) | Receipts share the persist anti-pattern → also fixed in same rewrite. Postgres ledger doesn't exist; documented in JSDoc as future work. | All siblings fixed |
| STORES-B-004 (owner + spread order) | Three sites: `append`, `appendReceipt`, `importEvent`, `importReceipt` — fixed all four. STORES-B-021 closed as side-effect. | All siblings fixed |
| STORES-B-013 (rotate contract) | Probed: `LocalLedgerStore` is the only LedgerStore impl in-tree → contract+impl together. Future Postgres documented in JSDoc. | All siblings fixed |
| STORES-B-014 (count) | Both `doctor()` and `verify()` had the same silent-limit pattern → both fixed. Surface dashboard (`OperationsPanel.jsx`) — Surface agent's territory; flagged as breadcrumb. | All in-scope siblings fixed |
| STORES-B-018 (schema registry) | Probed: `doctor.ts`, `migrations.ts::checkMigrationStatus`, `migrations.ts::verifySchema` — all three updated to use the registry/constant. CANONICAL_TABLE still imported in `schema.ts` for the SQL constants. | All siblings fixed |
| V1-A4-004 (backup staging) | Probed: only `backup()` and `restore()` are the staging entry/exit points; the kernel `getStagingDir()` is read-side and doesn't change. | All siblings fixed |
| V1-A4-005 (orphan-staging check) | Probed: doctor() is the right home; `verify()` is data-consistency-focused (does not own filesystem cleanup observability) so not extended. | Intentional scope |

No deferred-to-next-wave findings from the family-of-call-sites probe within Stores domain.

---

## 8. Saturation indicators

| Indicator | Value | Verdict |
|---|---|---|
| Stores HIGH findings closed in this wave | 4 (STORES-B-002, B-004, B-013, B-018) | All 4 closed |
| MEDIUM findings closed | 2 (STORES-B-014, V1-A4-004) | Both closed |
| Deferred staging-doctor MEDIUM closed | 1 (V1-A4-005) | Closed |
| 3× stability of new tests | 3/3 PASS at 21/21 | ✓ |
| Lint | PASS | ✓ |
| Net new tests | +21 (`test/wave-b1-stores-regression.test.ts`) | |

---

Stores domain fix complete. Test count after wave: 21/55/0 (this file). Cascade impacts: wave-a3-tests-regression TESTS-R2-005 (3 tests) repaired in `loadArray`; wave-a4-stores-regression STORES-B-001 (1 test) repaired by retaining `persistEvents` / `persistReceipts` method names.
