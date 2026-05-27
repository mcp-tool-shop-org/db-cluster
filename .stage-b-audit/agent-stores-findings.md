# Stage B Audit — Stores Domain — db-cluster

**Lens:** Proactive Health
**Date:** 2026-05-27
**HEAD audited:** 71ba55c

## Files audited

- `src/contracts/artifact-store.ts`
- `src/contracts/canonical-store.ts`
- `src/contracts/index-store.ts`
- `src/contracts/ledger-store.ts`
- `src/contracts/index.ts`
- `src/adapters/local/local-artifact-store.ts`
- `src/adapters/local/local-canonical-store.ts`
- `src/adapters/local/local-index-store.ts`
- `src/adapters/local/local-ledger-store.ts`
- `src/adapters/local/errors.ts`
- `src/adapters/local/index.ts`
- `src/adapters/postgres/postgres-canonical-store.ts`
- `src/adapters/postgres/schema.ts`
- `src/adapters/postgres/index.ts`
- `src/adapters/postgres/migrations/001_create_canonical_entities.ts`
- `src/adapters/factory.ts`
- `src/ops/backup.ts`
- `src/ops/doctor.ts`
- `src/ops/errors.ts`
- `src/ops/health.ts`
- `src/ops/migrations.ts`
- `src/ops/provenance-check.ts`
- `src/ops/rebuild.ts`
- `src/ops/receipt-check.ts`
- `src/ops/verify.ts`

## Severity rollup
| Severity | Count |
|---|---:|
| HIGH | 8 |
| MEDIUM | 11 |
| LOW | 9 |
| should-have-been-stage-a | 3 |

## Findings (HIGH then MEDIUM then LOW)

### STORES-B-001 — Multi-process race on fixed `${path}.tmp` suffix corrupts atomic-write invariant
**Severity:** HIGH
**Category:** defensive
**File:** `src/adapters/local/local-canonical-store.ts:130-132`, `src/adapters/local/local-ledger-store.ts:166-168,172-174`, `src/adapters/local/local-index-store.ts:128-130`, `src/adapters/local/local-artifact-store.ts:109,171,225`
**Description:** All four local adapters write to a constant `${target}.tmp` path before renaming. If two Node processes (or two `createLocalCluster` calls in the same process — there is no per-instance lock) both hit `persist()`, both open the same `.tmp` file in parallel; the second `writeFileSync` truncates and overwrites the first's bytes; whichever `renameSync` runs last clobbers the target with arbitrary intermixed data. The tmp+rename idiom assumes single-writer; nothing here enforces it. The doctor() / verify() layers cannot detect this because the result is still valid JSON (just stale or missing entries). Carry-over STORES-R2-007 escalated from "defensive coding gap" to HIGH because the failure mode is silent data loss and there is no integrity check downstream.
**Recommendation:** Use `${path}.${randomUUID()}.tmp` (or PID+counter) so each writer owns its own tmp file. Add a `cleanupOrphanTmp(dir)` helper at constructor time to GC tmp orphans from earlier crashes. Document explicitly that local adapters are single-process only and have the factory throw if a lockfile already exists.
**Evidence:**
```
local-canonical-store.ts:130    const tmpPath = `${this.filePath}.tmp`;
local-ledger-store.ts:166-168   const tmpPath = `${this.eventsPath}.tmp`;
                                writeFileSync(tmpPath, JSON.stringify(this.events, null, 2));
                                renameSync(tmpPath, this.eventsPath);
```

### STORES-B-002 — `LocalLedgerStore.persistEvents` rewrites entire array on every append — silent data-loss window on partial write
**Severity:** HIGH
**Category:** defensive / degradation
**File:** `src/adapters/local/local-ledger-store.ts:31-43,165-175`
**Description:** Every `append()` serializes the FULL events array (`JSON.stringify(this.events, null, 2)`) to tmp and renames over. The append-only ledger therefore has O(n^2) write cost AND a single bad write loses the entire ledger — the renameSync replaces a known-good file with whatever bytes happened to land in the tmp. If `writeFileSync` partial-fails on disk-full mid-write the renameSync still proceeds (rename of an existing file is the success path). Receipts share this pattern. For the cluster's append-only truth store this is the highest-stakes write path in the codebase.
**Recommendation:** Switch to an append-friendly format: NDJSON file where `append()` does `appendFileSync(path, JSON.stringify(event) + '\n')`. Add fsync (`writeFileSync` with a `fsync()` on the fd) before rename so the tmp file is durable before becoming the new target. For now, at minimum read+verify the tmp contents before renaming so a truncated write doesn't silently replace the good file.
**Evidence:**
```
local-ledger-store.ts:40-41    this.events.push(full);
                                this.persistEvents();
local-ledger-store.ts:165-169   private persistEvents(): void {
                                    const tmpPath = `${this.eventsPath}.tmp`;
                                    writeFileSync(tmpPath, JSON.stringify(this.events, null, 2));
                                    renameSync(tmpPath, this.eventsPath);
                                }
```

### STORES-B-003 — Silent first-write-wins on `importEvent` / `importReceipt` with no content comparison
**Severity:** HIGH
**Category:** observability / defensive
**File:** `src/adapters/local/local-ledger-store.ts:117-129,135-144`
**Description:** Carry-over STORES-R2-008 confirmed present. `importEvent` does `this.events.find((e) => e.id === event.id); if (existing) return existing;` with no field comparison. A tampered backup containing an event with an existing event's `id` but altered `action` / `subjectId` / `parentEventId` is silently masked — the existing event wins, the tampered payload disappears, no error, no log, no signal to `verify()`. Same story for `importReceipt`. The ledger is the cluster's truth-of-record store; restore must surface "this backup contains a record that conflicts with our existing record" not swallow it. Same pattern exists in `LocalCanonicalStore.importSnapshot` (lines 94-97) and `LocalArtifactStore.importSnapshot` (lines 155-158).
**Recommendation:** Compare the incoming event byte-for-byte (or by deep-equal of business fields excluding `owner`) against the existing record. On mismatch: throw a typed `DuplicateIdMismatchError` carrying both records, OR append a `ledger.import_conflict` event so doctor()/verify() can surface it. Same change for `importReceipt`, `canonical.importSnapshot`, `artifact.importSnapshot`.
**Evidence:**
```
local-ledger-store.ts:117-122    async importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent> {
                                     const existing = this.events.find((e) => e.id === event.id);
                                     if (existing) {
                                         return existing;
                                     }
local-canonical-store.ts:94-97   const existing = this.entities.get(entity.id);
                                  if (existing) {
                                      return existing;
                                  }
```

### STORES-B-004 — `LocalLedgerStore.appendReceipt` and `importReceipt` lack `owner` stamping — silent ownership asymmetry
**Severity:** HIGH
**Category:** defensive
**File:** `src/adapters/local/local-ledger-store.ts:80-89,135-144`
**Description:** `appendReceipt` constructs the receipt with `{ id, committedAt, ...receipt }` — no `owner`. Compare to `append()` at line 34-39 which sets `owner: 'ledger'`. Same omission in `importReceipt` line 140 where it does `{ ...receipt }` with no owner override — a tampered backup can specify any owner string. The asymmetry between `append` (sets owner explicitly) and `appendReceipt`/`importReceipt` (does not) creates a footgun: future code that filters by `owner === 'ledger'` will return events but not receipts even though both live in the ledger store. If `Receipt` type does NOT include `owner` then this is "by design" but the asymmetry is still defect-prone documentation; if it DOES include `owner` then receipts can be written with stale/incorrect owner values.
**Recommendation:** Decide whether Receipt has an owner field (the type declaration is outside this audit scope, but the LedgerStore contract should declare it explicitly) and either always set it in `appendReceipt`/`importReceipt`, or remove the owner stamping from `append()` for symmetry. The current asymmetric stamping is a footgun.
**Evidence:**
```
local-ledger-store.ts:80-89  async appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt> {
                                  const full: Receipt = {
                                      id: randomUUID(),
                                      committedAt: new Date().toISOString(),
                                      ...receipt,                  // owner not set here
                                  };
local-ledger-store.ts:34-39  const full: ProvenanceEvent = {
                                  id: randomUUID(),
                                  timestamp: new Date().toISOString(),
                                  ...event,
                                  owner: 'ledger',                 // owner IS set here
                              };
```

### STORES-B-005 — Postgres adapter has no migration_status / applied_migrations table — v0.1→v0.2 path undefined
**Severity:** HIGH
**Category:** future-proofing
**File:** `src/adapters/postgres/migrations/001_create_canonical_entities.ts`, `src/adapters/postgres/postgres-canonical-store.ts:151-156`
**Description:** Carry-over confirmed. `migrate()` blindly runs `up()` from migration 001 every time. There is no tracking table (`schema_migrations`, `migration_status`, anything) that records which migrations have been applied. The current single migration is idempotent (CREATE TABLE IF NOT EXISTS), so this is invisible today. The moment migration 002 ships — say, "ALTER TABLE add column X" — there is no way to know if it has already been applied. The naive `migrate()` re-runs all migrations every startup, so 002 will run twice and fail the second time (or worse, silently succeed if the ALTER is IF NOT EXISTS). The shipping policy of v0.1 establishes the migration table as part of v0.1 OR v0.2 must bootstrap one — but it has to be in the design now, not after the first additional migration fails in production.
**Recommendation:** Add a `db_cluster_migrations` table to migration 001 (it's still time): `CREATE TABLE db_cluster_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. Rewrite `migrate()` to: list available migration files → list rows in db_cluster_migrations → run+insert only missing ones, in a transaction per migration. Add a `getAppliedMigrations(): Promise<string[]>` method on the store so `doctor()` can report applied vs. available.
**Evidence:**
```
postgres-canonical-store.ts:153-156  async migrate(): Promise<void> {
                                          const { up } = await import('./migrations/001_create_canonical_entities.js');
                                          await up(this.pool);
                                      }
migrations/001_create_canonical_entities.ts:11-13  export async function up(pool: Pool): Promise<void> {
                                                       await pool.query(CREATE_TABLE_SQL);
                                                   }
```

### STORES-B-006 — Postgres pool has no SSL config + no error handler + no shutdown wiring
**Severity:** HIGH
**Category:** degradation / future-proofing
**File:** `src/adapters/factory.ts:52,86`
**Description:** `new Pool({ connectionString: config.postgresUrl })` — no `ssl`, no `max`, no `idleTimeoutMillis`, no `connectionTimeoutMillis`. Cloud Postgres providers (Neon, Supabase, RDS, Heroku) require SSL; the connection string can carry `?sslmode=require` but the pg driver also needs `ssl: { rejectUnauthorized: true }` to enforce certificate validation. Without it the connection MAY succeed unencrypted (depends on server config) and the SDK will silently downgrade. Additionally there is no `pool.on('error', ...)` handler — an idle client error throws unhandled and crashes the process; the comment in `ClusterWithPool` says "Call pool.end() on shutdown" but nothing in the factory wires that to SIGTERM, so a graceful shutdown leaks connections.
**Recommendation:** Take a `pgPoolConfig?: PoolConfig` option on `ClusterConfig` so callers can pass `ssl`, `max`, timeouts. Default `ssl: { rejectUnauthorized: true }` when `postgresUrl` starts with `postgres://` and a non-localhost host. Attach a `pool.on('error', (err) => /* structured log */)` handler before returning. Document graceful-shutdown responsibility explicitly in the JSDoc of `createCluster` — or better, return a `shutdown(): Promise<void>` function instead of the raw pool.
**Evidence:**
```
factory.ts:52    const pool = new Pool({ connectionString: config.postgresUrl });
factory.ts:65    pool,
factory.ts:33-34 /** Postgres pool — present when Postgres backend is used. Call pool.end() on shutdown. */
                 pool?: Pool;
```

### STORES-B-007 — `restore()` silently ignores rebuildIndex failure; partial-restore success not signalled to caller
**Severity:** HIGH
**Category:** observability / degradation
**File:** `src/ops/backup.ts:213-225`
**Description:** After restoring entities/artifacts/events/receipts, `restore()` calls `rebuildIndex(stores)` with no try/catch and no incorporation of result into the `RestoreResult`. If rebuild throws, the entire restore call throws even though the canonical/artifact/ledger writes already succeeded — caller sees failure for an effectively-successful restore. If rebuild "succeeds" with errors in its `errors: string[]` array, those errors are dropped on the floor and the cluster has a partial / wrong index. Operators need to know: (a) did restore complete? (b) is the index now consistent? Today the answer to (b) is buried in stdout if at all.
**Recommendation:** Wrap the rebuildIndex call in try/catch. Add `index?: { rebuilt: number; errors: string[]; ok: boolean }` to `RestoreResult`. On rebuild failure, set `result.index = { ok: false, errors: [err.message], rebuilt: 0 }` and DO NOT throw — return the partial result so the caller can decide. Document the "stores restored but index needs rebuild" recovery path explicitly (doctor() already flags this via the `index_populated` check, which is good — but the restore caller deserves a typed signal too).
**Evidence:**
```
backup.ts:213-215   // Rebuild index after restore
                    const { rebuildIndex } = await import('./rebuild.js');
                    await rebuildIndex(stores);  // no try/catch, return value discarded
backup.ts:42-48     export interface RestoreResult {
                        entities: { created: number; skipped: number; errors: string[] };
                        artifacts: { ... };
                        events: { ... };
                        receipts: { ... };
                        commands?: { restored: number };
                        // no `index` field
                    }
```

### STORES-B-008 — `LocalArtifactStore.importSnapshot` mutates state before persist with no transactional rollback
**Severity:** HIGH
**Category:** defensive / degradation
**File:** `src/adapters/local/local-artifact-store.ts:150-200`
**Description:** The flow is: validate hash → check existing → write content via tmp+rename → set in-memory map → `this.persist()`. If `persist()` throws (disk-full, FS readonly mid-restore) AFTER the content file is renamed into place AND the in-memory map mutated, we now have: a content file on disk with no metadata pointing to it (orphan content), AND in-memory state that thinks the artifact exists. A retry will find the existing content file and skip the write — but `persist()` will be called again, possibly failing the same way; meanwhile other code calling `get(id)` returns the in-memory artifact pointing to a file that — wait, actually exists, fine. But the on-disk artifacts.json is missing the row, so on next process restart the artifact disappears even though its content is still on disk. This is a write-ordering inversion: canonical metadata should be persisted before the in-memory mutation is "committed" (or use a transactional pattern). Same in-memory-vs-disk inversion in `ingest()` at lines 127-128.
**Recommendation:** Reorder: write content to tmp, build the new in-memory map locally (don't mutate `this.artifacts` yet), persist the new map to a sibling tmp metadata file, rename content first, rename metadata, then assign `this.artifacts = newMap`. If anything throws before both renames, no state is committed. Document the invariant: "in-memory map == persisted file == content directory" must hold across every public method.
**Evidence:**
```
local-artifact-store.ts:188-199   // content already renamed at this point
                                   const artifact: Artifact = {
                                       ...metadata,
                                       storagePath: contentPath,
                                       owner: 'artifact',
                                   };
                                   this.artifacts.set(artifact.id, artifact);  // in-memory committed
                                   this.persist();                              // may throw
                                   return artifact;
```

### STORES-B-009 — `PostgresCanonicalStore.update()` has no optimistic-concurrency check — lost-update race
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/adapters/postgres/postgres-canonical-store.ts:78-105`
**Description:** Two concurrent updates to the same entity each `UPDATE ... WHERE id = $1 RETURNING ...`. Postgres serializes the writes at row level, but the patch is built from `Partial<Pick<Entity, 'name' | 'attributes'>>` — there's no `WHERE updated_at = $expected` check. Last-writer-wins on `name` and `attributes`. Since `attributes` is `JSONB`, an attempted partial merge ("set just attributes.foo") would clobber sibling keys; the contract says `attributes` is whole-object replacement, so the loss is "your edit happened, then mine fully overwrote yours." The kernel's command pipeline may already serialize this, but the store should be robust on its own — at least surface the race via an optimistic-lock signal.
**Recommendation:** Add an `expectedUpdatedAt?: string` parameter to the contract `update()` (next minor version). On mismatch throw `ConcurrentUpdateError`. For attributes, document that this is full-replacement, never field-merge. Alternatively expose a `jsonMerge(id, partialAttrs)` method for true merge semantics using Postgres `attributes || $jsonMerge::jsonb`.
**Evidence:**
```
postgres-canonical-store.ts:78-98  async update(id, patch) {
                                       ...
                                       setClauses.push(`updated_at = $${paramIndex++}`);
                                       params.push(new Date().toISOString());
                                       params.push(id);
                                       const sql = `UPDATE ... SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING ...`;
                                       // no WHERE updated_at = $expected
                                   }
```

### STORES-B-010 — Postgres store has zero observability: no query latency, no error counter, no pool-state probe
**Severity:** MEDIUM
**Category:** observability / future-proofing
**File:** `src/adapters/postgres/postgres-canonical-store.ts` (all query methods)
**Description:** Carry-over confirmed. Every method calls `this.pool.query(...)` directly. No timing, no error categorization, no slow-query log. The doctor() probe only does `list({ limit: 1 })` which masks the difference between "Postgres is alive" and "Postgres is alive but every query is taking 30s." Pool state (`pool.totalCount`, `pool.idleCount`, `pool.waitingCount`) is not surfaced. When ops swap in OpenTelemetry / Prometheus there is no extension point — every method would need to be re-wrapped.
**Recommendation:** Introduce an optional `metrics?: { onQuery(name: string, durationMs: number, ok: boolean): void }` field on the constructor or factory. Wrap each `this.pool.query(...)` in `withMetrics('get'|'list'|'create'|'update'|'importSnapshot', ...)`. Add a `poolStats(): { total, idle, waiting }` method. Add a `doctor()` check that reports `poolStats` (waiting > 0 for >30s = bad). This is the minimum viable observability for a production Postgres adapter.
**Evidence:**
```
postgres-canonical-store.ts:19-25  async get(id: string): Promise<Entity | null> {
                                       const result = await this.pool.query(...);
                                       if (result.rows.length === 0) return null;
                                       return this.rowToEntity(result.rows[0]);
                                   }
                                   // no try/catch, no timing, no metric emit
```

### STORES-B-011 — `restore()` lacks abort threshold and only checks contract-method existence lazily
**Severity:** MEDIUM
**Category:** degradation
**File:** `src/ops/backup.ts:96-225`
**Description:** When restore() collects errors into `result.entities.errors` / `result.artifacts.errors` etc., it still proceeds to call `rebuildIndex` unconditionally. If half the entities failed to restore, the index will be rebuilt to reflect only the half that succeeded — which is correct, but the operator now has an index that disagrees with the backup-file source-of-truth and no signal pointing them at the half they need to address. Furthermore, `restore()` keeps going on per-record errors (lines 126-128, 165-167, etc.) — there is no abort threshold, no "if >50% failed, stop and report." The contract-method existence checks are scattered: `canonicalImport` is checked at line 114-115 BEFORE any mutation (good), but `artifactImport` check at line 138-141 happens INSIDE the snapshot loop — by then entities have already been written.
**Recommendation:** Add `options.abortThreshold?: number` (default undefined = best-effort, current behavior). When non-zero, abort after N total errors. Add `result.fatallyIncomplete: boolean` set when any per-record error array is non-empty so callers don't need to count. Hoist ALL `ImportSnapshotNotSupportedError` checks to the top of `restore()` — fail-fast if any required contract method is missing on `stores.ledger`/`stores.canonical`/`stores.artifact` BEFORE the entity loop starts, not after partial writes.
**Evidence:**
```
backup.ts:177-178   if (data.events.length > 0 && typeof ledgerImportEvent !== 'function') {
                        throw new ImportSnapshotNotSupportedError('ledger', 'importEvent');
backup.ts:127       result.entities.errors.push(`Entity ${entity.id}: ${err.message}`);  // continues
backup.ts:138-141   if (typeof artifactImport !== 'function') {
                        throw new ImportSnapshotNotSupportedError('artifact', 'importSnapshot');
                    }                                                                       // entities loop already ran
```

### STORES-B-012 — `LocalArtifactStore.importSnapshot` does not validate content matches contentHash
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/adapters/local/local-artifact-store.ts:150-200`
**Description:** `importSnapshot(metadata, content)` validates `metadata.contentHash` shape via `isValidContentHash` (good — STORES-006 fix) but does NOT recompute `sha256(content)` and compare against `metadata.contentHash`. The caller (`backup.ts:150-156`) does this verification before invoking, but the contract method itself is a public surface that a future caller might invoke directly without that check. A tampered backup whose metadata says `contentHash=abc...` but whose actual content bytes hash to `def...` would be silently accepted — and then `getContent(id)` would return content that doesn't match `artifact.contentHash`, breaking the content-addressing invariant.
**Recommendation:** Either: (a) have `importSnapshot` recompute and compare the hash itself, throwing `ContentHashMismatchError` on disagreement; or (b) document on the contract that the caller is responsible and `getContent` is the only validation point — but then add a `verify()` check that walks all artifacts and recomputes their hashes. Option (a) is cheaper and more defensible.
**Evidence:**
```
local-artifact-store.ts:150-156   async importSnapshot(metadata: Artifact, content: Buffer): Promise<Artifact> {
                                       if (!isValidContentHash(metadata.contentHash)) {
                                           throw new InvalidContentHashError(String(metadata.contentHash));
                                       }
                                       // no createHash('sha256').update(content).digest('hex') === metadata.contentHash
```

### STORES-B-013 — `LocalLedgerStore.events` array unbounded — append-only ledger has no rotation / archival hook
**Severity:** MEDIUM
**Category:** future-proofing / degradation
**File:** `src/adapters/local/local-ledger-store.ts:17-29,165-175`
**Description:** Every `append()` rewrites the entire events array. For a long-lived cluster with N events, every append is O(N) serialization + write. At N=100k a single append could take seconds; at N=1M it crosses minutes. Worse, the in-memory `this.events: ProvenanceEvent[]` holds the entire history. There is no rotation, no archive-and-compact, no "events older than X are moved to events-archive-2026Q1.json." The contract has no `archive(beforeTimestamp)` or `compact()` method.
**Recommendation:** Add `archive(beforeTimestamp: string): Promise<{ archived: number; archiveFile: string }>` to LedgerStore contract. Implementation: move events with `timestamp < beforeTimestamp` into a sibling `events-<year>Q<n>.json` archive, keep parent-chain references intact via a forwarding pointer or by ensuring `trace()` reads both files. This is future-proofing — not a v0.1 issue but a v0.2 design conversation we should be having now.
**Evidence:**
```
local-ledger-store.ts:20    private events: ProvenanceEvent[];
local-ledger-store.ts:40-41 this.events.push(full);
                            this.persistEvents();      // writes full array each time
```

### STORES-B-014 — `doctor()` and `verify()` orphan-mutation surfacing is silently limit-capped
**Severity:** MEDIUM
**Category:** observability
**File:** `src/ops/doctor.ts:209-249`, `src/ops/verify.ts:153-189`
**Description:** Carry-over confirmed — the `no_orphaned_mutations` check WAS added in Wave A3 (good). But the implementation reads `listEvents({ action: 'mutation_orphaned', limit: 100 })` — limit 100. If 500 mutations are orphaned, doctor reports "100 orphaned mutation event(s) recorded." with no indication that this is capped. Operator runs `doctor` again to see if it's improving and sees the same 100. Same pattern in `verify.ts:158` with the `limit` parameter (default 100 there too).
**Recommendation:** Drop the `limit` on the orphan check or raise to a sentinel high value, then report `${orphanCount}+ orphaned mutation event(s) (sampled, may be more)` when count === limit. Or do a separate `count(action='mutation_orphaned')` query (requires contract addition — `LedgerStore.count(filter?: LedgerFilter)`). Add a "trend" field — `firstSeenAt` / `lastSeenAt` — so operators can tell if the orphan stream is ongoing or historical.
**Evidence:**
```
doctor.ts:218-227    const orphanedEvents = await stores.ledger.listEvents({ action: 'mutation_orphaned', limit: 100 });
                     const orphanCount = orphanedEvents.length;
                     if (orphanCount > 0) {
                         checks.push({
                             name: 'no_orphaned_mutations',
                             ...
                             message: `${orphanCount} orphaned mutation event(s) recorded. ...`,
verify.ts:158        const orphanedEvents = await stores.ledger.listEvents({ action: 'mutation_orphaned', limit });
```

### STORES-B-015 — `LocalLedgerStore.trace()` missing cycle detection — infinite loop on tampered parent chain
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/adapters/local/local-ledger-store.ts:67-78`
**Description:** `trace()` walks `parentEventId` from a starting event. There is no `visited: Set<string>` guard. A tampered ledger where event A has `parentEventId = B` and B has `parentEventId = A` produces an infinite loop — the function never returns. Since the events are loaded from a JSON file that the audit found could be corrupted by a multi-process race (STORES-B-001) or a tampered backup (STORES-B-003), the assumption "parent chain is a DAG" is not enforced.
**Recommendation:** Add `const seen = new Set<string>()`; inside the loop check `if (seen.has(current.id)) { /* log + break */ }`; add `seen.add(current.id)` before walking parent. On cycle detected, return the chain so far PLUS attach a typed warning (or throw `CyclicProvenanceChainError`). Document the invariant.
**Evidence:**
```
local-ledger-store.ts:67-78   async trace(eventId: string): Promise<ProvenanceEvent[]> {
                                  const chain: ProvenanceEvent[] = [];
                                  let current = this.events.find((e) => e.id === eventId);
                                  while (current) {
                                      chain.push(current);
                                      if (!current.parentEventId) break;
                                      current = this.events.find((e) => e.id === current!.parentEventId);
                                  }
                                  return chain;
                              }
```

### STORES-B-016 — Wave A3 `optional-cast` dead-code in `backup.ts` confirmed — fallback unreachable since contract promotion
**Severity:** MEDIUM
**Category:** future-proofing (dead-code)
**File:** `src/ops/backup.ts:113,138,175,195`
**Description:** Carry-over V1-001 confirmed. All four import hooks (`importSnapshot` on canonical, `importSnapshot` on artifact, `importEvent` and `importReceipt` on ledger) are now REQUIRED on the contracts (canonical-store.ts:26, artifact-store.ts:27, ledger-store.ts:30, ledger-store.ts:38). The optional-cast `(stores.canonical as { importSnapshot?: ... }).importSnapshot` and the subsequent `typeof ... !== 'function'` checks can never fire against a TypeScript-compiled adapter — they only catch a hypothetical adapter passed in via `any`. The `ImportSnapshotNotSupportedError` exists primarily as documentation now.
**Recommendation:** Either: (a) delete the optional-cast type assertions and rely on the contract types directly — `await stores.canonical.importSnapshot(entity)` straight up; or (b) keep the runtime checks but add a comment explaining they are belt-and-suspenders for runtime-injected stores. Option (a) is cleaner; the contract's load-bearing role is now type-checked. If keeping, widen the R5 ast-grep rule to catch new optional-method-cast sites.
**Evidence:**
```
backup.ts:113   const canonicalImport = (stores.canonical as { importSnapshot?: (entity: Entity) => Promise<Entity> }).importSnapshot;
backup.ts:114   if (typeof canonicalImport !== 'function') {
canonical-store.ts:26   importSnapshot(entity: Entity): Promise<Entity>;   // required on contract
```

### STORES-B-017 — `createCluster` doesn't validate `postgresUrl` format — malformed URL fails at first-query time
**Severity:** MEDIUM
**Category:** defensive / observability
**File:** `src/adapters/factory.ts:44-65`
**Description:** Carry-over confirmed. The factory checks `config.postgresUrl` is truthy (line 45-50) but does not parse-validate it. `new Pool({ connectionString: 'not-a-url' })` does NOT throw immediately — it throws later on first query, with a generic ECONNREFUSED-ish error that doesn't point at the config. A typo in `postgres://localhst:5432/db` (note: localhst not localhost) is invisible until the first canonical store query lands.
**Recommendation:** In `createCluster`, after the truthy check, do `try { new URL(config.postgresUrl); } catch { throw new Error('postgresUrl is not a valid URL: ...'); }`. Verify protocol is `postgres:` or `postgresql:`. Provide a `validatePostgresUrl(url): { ok: boolean; reason?: string }` helper so the CLI can pre-check before invoking. Document fail-fast vs. fail-on-first-use semantics in the factory JSDoc.
**Evidence:**
```
factory.ts:44-52   if (canonicalBackend === 'postgres') {
                       if (!config.postgresUrl) {
                           throw new Error('DB_CLUSTER_POSTGRES_URL is required ...');
                       }
                       const pool = new Pool({ connectionString: config.postgresUrl });  // accepts any string
```

### STORES-B-018 — `doctor()` Postgres-table check hardcodes `'canonical_entities'` — drift risk vs schema.ts
**Severity:** MEDIUM
**Category:** future-proofing
**File:** `src/ops/doctor.ts:147-183`, `src/ops/migrations.ts:25-28`
**Description:** The Postgres health check queries `information_schema.tables WHERE table_name = 'canonical_entities'`. The hardcoded table name lives in `src/adapters/postgres/schema.ts:6` as `CANONICAL_TABLE` constant. Two sources of truth = drift risk. When migration 002 adds a new required table, the doctor check won't notice its absence. Similar duplication in `ops/migrations.ts:25-28` where `required = ['canonical_entities']` is its own hardcoded list.
**Recommendation:** Import `CANONICAL_TABLE` from the schema module: `import { CANONICAL_TABLE } from '../adapters/postgres/schema.js'`. Better: introduce a `getRequiredTables(): string[]` registry on the schema module that all consumers (`doctor`, `migrations.checkMigrationStatus`, anything else) reference. When migration 002 ships, only the schema registry changes; doctor/migrations stay correct automatically.
**Evidence:**
```
doctor.ts:149-150     `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'canonical_entities') AS exists`,
schema.ts:6           export const CANONICAL_TABLE = 'canonical_entities';
ops/migrations.ts:25  const required = ['canonical_entities'];
```

### STORES-B-019 — `rebuildIndex` atomic swap reassigns all `IndexRecord.id`s — undocumented stability semantics
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/ops/rebuild.ts:40-111`, `src/adapters/local/local-index-store.ts:89-103`
**Description:** `rebuildIndex` stages records as `Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>` and `replaceAll()` assigns fresh `randomUUID()`s to each one. A consumer holding an `IndexRecord.id` from before the rebuild — caching a search-result ID, or storing it as a key in an external system — finds that ID gone after every rebuild. Since the index is derivative, this may be by-design. But the contract doesn't say "id is not stable across rebuilds" anywhere, so callers could reasonably expect persistence. The `sourceId` IS stable across rebuilds; if external systems should reference index records they should be told to use `sourceId + sourceStore` as the natural key.
**Recommendation:** Document on `IndexStore.replaceAll` and `IndexRecord.id` that `id` is NOT stable across rebuilds — use `sourceStore + sourceId` as the natural key for external references. Or, optionally, change `replaceAll` to preserve `id` when `(sourceStore, sourceId)` matches an existing record — but this adds complexity and the "index can be blown away" property is the whole point of derivative.
**Evidence:**
```
rebuild.ts:52-58       staged.push({
                           sourceId: entity.id,
                           sourceStore: 'canonical',
                           text: `${entity.kind}: ${entity.name}`,
                           metadata: { kind: entity.kind, ...entity.attributes },
                       });
local-index-store.ts:90-100  async replaceAll(records: ...) {
                                 ...
                                 for (const r of records) {
                                     const full: IndexRecord = { id: randomUUID(), ... };
```

### STORES-B-020 — `as any` in doctor.ts:152 erases Postgres-row typing
**Severity:** LOW
**Category:** defensive
**File:** `src/ops/doctor.ts:152`
**Description:** `const exists = (result.rows[0] as any).exists;` — the only `as any` in the ops layer. The query returns a boolean column named `exists`; `result.rows[0]` is `Record<string, unknown>` by pg's typings. The `as any` defeats the type-check that would catch a typo in the column name.
**Recommendation:** Type the row: `const row = result.rows[0] as { exists: boolean }; const exists = row.exists;`. Or use a generic: `await pool.query<{ exists: boolean }>(...)`. Removes the `any` while keeping the runtime behavior.
**Evidence:**
```
doctor.ts:151-152    `SELECT EXISTS (...) AS exists`,
                     );
                     const exists = (result.rows[0] as any).exists;
```

### STORES-B-021 — `appendReceipt` / `append` spread-order allows caller to override `id` / `timestamp` / `committedAt`
**Severity:** LOW
**Category:** defensive
**File:** `src/adapters/local/local-ledger-store.ts:34-39,80-89`
**Description:** `{ id: randomUUID(), committedAt: ..., ...receipt }` — the spread happens AFTER the assignments, so if `receipt` (typed `Omit<Receipt, 'id' | 'committedAt'>`) somehow carries an `id` or `committedAt` (via `as Receipt` cast or runtime-injected object), those values override the generated ones. Compare to `append()` at line 34-39 where the spread also happens before owner is set — same pattern, same risk. For id/committedAt this is a quiet bug: spread order matters.
**Recommendation:** Move the generated fields AFTER the spread: `{ ...receipt, id: randomUUID(), committedAt: new Date().toISOString() }`. Same fix in `append()` at line 34-39 for `id` and `timestamp` (owner is already correctly post-spread).
**Evidence:**
```
local-ledger-store.ts:81-85   const full: Receipt = {
                                  id: randomUUID(),
                                  committedAt: new Date().toISOString(),
                                  ...receipt,                          // could overwrite id/committedAt
                              };
local-ledger-store.ts:34-39   const full: ProvenanceEvent = {
                                  id: randomUUID(),
                                  timestamp: new Date().toISOString(),
                                  ...event,                            // could overwrite id/timestamp
                                  owner: 'ledger',                     // owner safely post-spread
                              };
```

### STORES-B-022 — `persist()` methods on local adapters do not handle write failure
**Severity:** LOW
**Category:** defensive
**File:** `src/adapters/local/local-artifact-store.ts:223-228`, `src/adapters/local/local-canonical-store.ts:128-133`, `src/adapters/local/local-index-store.ts:126-131`, `src/adapters/local/local-ledger-store.ts:165-175`
**Description:** Unlike `ingest` and `importSnapshot` which have try/catch around tmp+rename with cleanup, the `persist()` methods write to tmpPath then renames with no error handling. If `writeFileSync(tmpPath, ...)` throws (disk full / permission), there is no cleanup of a partial tmp file. If `renameSync` throws (cross-device, perm), same. Combined with STORES-B-001 (fixed tmp name) this is how orphan `.tmp` files accumulate.
**Recommendation:** Wrap the persist() bodies in try/catch with best-effort `unlinkSync(tmpPath)` cleanup mirroring the pattern at line 113-124 in `LocalArtifactStore.ingest`. Rethrow the original error.
**Evidence:**
```
local-artifact-store.ts:223-228   private persist(): void {
                                      const arr = Array.from(this.artifacts.values());
                                      const tmpPath = `${this.metaPath}.tmp`;
                                      writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
                                      renameSync(tmpPath, this.metaPath);
                                  }
```

### STORES-B-023 — `rebuildIndex` swallows artifact-staging failures into `errors[]` — caller using "no-throw" gets partial index
**Severity:** LOW
**Category:** observability
**File:** `src/ops/rebuild.ts:65-96,104-108`
**Description:** Per-artifact failures (most likely `InvalidContentHashError` from a tampered artifacts.json) get pushed to `errors[]` and the artifact is silently NOT included in the rebuilt index. Then `replaceAll(staged)` runs with the staged (incomplete) list — the index is missing the failed artifact. From the operator's view, doctor() will then say "index is healthy, N records" but search results won't find the affected artifact. The errors array does carry the signal, but a caller using the boolean "did rebuild succeed" — `result.errors.length === 0` — sees the issue. A caller using "did rebuild return without throwing" does not.
**Recommendation:** Add `ok: boolean` to `RebuildResult` set to `errors.length === 0`. Document semantics: "non-empty errors means the index is partial — affected sourceIds are missing." Consider a `--strict` mode option that throws after the loop if any staging errors occurred, so callers can fail-fast instead of needing to inspect errors array.
**Evidence:**
```
rebuild.ts:93-96   } catch (err: any) {
                       errors.push(`Failed to stage artifact ${artifact.id}: ${err.message}`);
                       // staged array does not get this artifact, but loop continues
                   }
rebuild.ts:10-15   export interface RebuildResult {
                       rebuilt: number;
                       removed: number;
                       errors: string[];
                       dryRun: boolean;
                       // no `ok` field
                   }
```

### STORES-B-024 — `Postgres.list()` lacks deterministic tie-breaker — pagination is non-deterministic on equal timestamps
**Severity:** LOW
**Category:** defensive
**File:** `src/adapters/postgres/postgres-canonical-store.ts:28-54,64-76`
**Description:** `ORDER BY created_at ASC` is a single-column sort. Two entities created in the same `create()` call get `created_at = $5, updated_at = $5` using the same JS timestamp (`new Date().toISOString()`). For two such entities, the sort tie is broken by Postgres in implementation-defined order; pagination with `LIMIT n OFFSET m` can return the same row twice or miss rows.
**Recommendation:** Add `, id ASC` as a tie-breaker: `ORDER BY created_at ASC, id ASC`. Deterministic without performance cost (id is the PRIMARY KEY).
**Evidence:**
```
postgres-canonical-store.ts:46      sql += ` ORDER BY created_at ASC`;
                                    if (filter?.limit) {
                                        sql += ` LIMIT $${paramIndex++}`;
postgres-canonical-store.ts:67-71   const id = randomUUID();
                                    const now = new Date().toISOString();
                                    const result = await this.pool.query(
                                        `INSERT INTO ${CANONICAL_TABLE} (..., $5, $5) ...`,
```

### STORES-B-025 — `Postgres.create()` passes ISO string to TIMESTAMPTZ — round-trip via string is fragile
**Severity:** LOW
**Category:** defensive
**File:** `src/adapters/postgres/postgres-canonical-store.ts:64-76,94-100`
**Description:** `const now = new Date().toISOString()` is passed as `$5` for both created_at and updated_at columns. pg coerces the string back into a TIMESTAMPTZ on the server side. Round-trip: JS Date → ISO string → server parse → TIMESTAMPTZ. If the JS string format ever drifts (e.g., a non-Z-suffixed local time slipped in via a test), the server parses it as local time and you get TZ-offset bugs. Cleaner: pass the Date directly (`params.push(new Date())`) and let pg's binary protocol handle TZ.
**Recommendation:** Replace `const now = new Date().toISOString()` with `const now = new Date()` and pass the Date object. pg's driver handles TIMESTAMPTZ correctly. Same change at update() line 95.
**Evidence:**
```
postgres-canonical-store.ts:68-74   const now = new Date().toISOString();
                                    const result = await this.pool.query(
                                        `INSERT INTO ${CANONICAL_TABLE} (... created_at, updated_at)
                                         VALUES (..., $5, $5) ...`,
                                        [id, input.kind, input.name, JSON.stringify(input.attributes), now],
                                    );
```

### STORES-B-026 — `update()` throws bare `Error` with no typed code — non-actionable to callers
**Severity:** LOW
**Category:** observability
**File:** `src/adapters/local/local-canonical-store.ts:72-74`, `src/adapters/postgres/postgres-canonical-store.ts:101-103`
**Description:** Both local and Postgres `update()` throw `new Error('Entity not found: ${id}')` when the entity doesn't exist. Callers wanting to distinguish "not found" from "Postgres down" / "other I/O" must `err.message.startsWith('Entity not found')` — string-matching against error messages. There's already a typed-error pattern (`CorruptStoreError`, `InvalidContentHashError`) — extend it.
**Recommendation:** Add an `EntityNotFoundError extends Error` (and `ArtifactNotFoundError`, etc.) to `src/adapters/local/errors.ts` (or a shared `src/contracts/errors.ts` since both adapters need it). Throw the typed version. Same fix in `PostgresCanonicalStore.update` at line 102.
**Evidence:**
```
local-canonical-store.ts:71-74    const existing = this.entities.get(id);
                                   if (!existing) {
                                       throw new Error(`Entity not found: ${id}`);
                                   }
postgres-canonical-store.ts:101-103  if (result.rows.length === 0) {
                                         throw new Error(`Entity not found: ${id}`);
                                     }
```

### STORES-B-027 — `replaceAll()` mutates in-memory before persist — partial-state on disk-full
**Severity:** LOW
**Category:** defensive
**File:** `src/adapters/local/local-index-store.ts:89-103`
**Description:** `this.records = next; this.persist();` — the in-memory map is mutated BEFORE persist completes. If persist throws (disk full mid-rebuild), the process now has an in-memory index that does not match the on-disk file. A subsequent `search()` returns records that won't survive a restart. The store has no rollback. Less severe than the artifact store version (STORES-B-008) because the index is derivative — operator can rebuild — but doctor() can't detect this divergence because both reachability and count succeed.
**Recommendation:** Build `next` and call a static helper `writeJsonAtomic(this.filePath, Array.from(next.values()))` BEFORE `this.records = next`. On write failure, the old `this.records` is unchanged; throw and let the caller retry. Apply same pattern to the other adapters' write paths.
**Evidence:**
```
local-index-store.ts:101-102    this.records = next;
                                this.persist();
```

### STORES-B-028 — `pool.on('error', ...)` handler missing — idle-client errors crash process
**Severity:** LOW
**Category:** defensive
**File:** `src/adapters/factory.ts:52-66`
**Description:** Subset of STORES-B-006 worth calling out separately because it's a known `pg` gotcha. From node-postgres docs: "When a client emits an error before it is removed from the pool, this error will be emitted on the pool object." Without `pool.on('error', handler)` an idle TCP RST from a load balancer that drops idle connections crashes the Node process with an unhandled error event.
**Recommendation:** After `const pool = new Pool(...)`, add `pool.on('error', (err, client) => { /* structured-log + bump error metric, do NOT crash */ });`. Single line, large blast-radius reduction.
**Evidence:**
```
factory.ts:52-65   const pool = new Pool({ connectionString: config.postgresUrl });
                   const canonical = new PostgresCanonicalStore(pool);
                   ...
                   return { stores: { canonical, artifact: ..., index: ..., ledger: ... }, pool };
                   // no pool.on('error', ...)
```

## Carry-over verification matrix
| ID | Present? | Proactive severity | Fix scope | New file:line |
|---|---|---|---|---|
| V1-001 backup.ts dead code | Yes — 4 sites confirmed | MEDIUM | Delete optional-cast or widen R5 rule (STORES-B-016) | `src/ops/backup.ts:113,138,175,195` |
| STORES-R006 Postgres TOCTOU | Yes — `ON CONFLICT (id) DO NOTHING` in place | LOW (no proactive escalation; conflict semantics match `importSnapshot` contract: idempotent, no-overwrite-mismatch) | No fix needed | `src/adapters/postgres/postgres-canonical-store.ts:118-148` |
| STORES-R2-006 NFD tokenizer | Out of scope (kernel-domain `src/indexing/`) | n/a | Coordinate with Kernel agent | n/a |
| STORES-R2-007 .tmp race | Yes — confirmed present at 8+ sites | HIGH (STORES-B-001) | Random tmp suffix + startup cleanup | local-canonical:130, local-ledger:166,172, local-index:128, local-artifact:109,171,225 |
| STORES-R2-008 silent duplicate-drop | Yes — confirmed in 4 import* methods | HIGH (STORES-B-003) | Content-compare on duplicate id | local-ledger:117-129,135-144, local-canonical:94-97, local-artifact:155-158 |
| STORES-R2-005 importSnapshot atomic write | Yes — atomic tmp+rename in place for ingest + importSnapshot | LOW (sibling `persist()` paths still lack try/catch — STORES-B-022) | Wrap persist() in try/catch | local-artifact:223-228 + 3 others |
| Postgres adapter schema versioning | Yes — no migrations registry table | HIGH (STORES-B-005) | Add migrations registry table | `src/adapters/postgres/migrations/` |
| doctor() orphan-mutation surfacing | Yes — added in Wave A3, silently limit-capped at 100 | MEDIUM (STORES-B-014) | Drop/raise limit + sentinel rendering | `src/ops/doctor.ts:218`, `src/ops/verify.ts:158` |
| health.ts worst-of priority | Yes — priority list correct (corrupt > unreachable > missing > stale > degraded > unverified > healthy) | LOW (no issue) | n/a | `src/ops/health.ts:38-43` |
| Postgres adapter observability metrics | None present | MEDIUM (STORES-B-010) | Add metrics hook + poolStats | `src/adapters/postgres/postgres-canonical-store.ts` |
| factory.ts postgres URL malformed | Truthy check only | MEDIUM (STORES-B-017) | URL parse validation | `src/adapters/factory.ts:44-52` |

## Domain summary

This domain is in solid shape after Wave A3 — the architectural fixes from re-audit-2 (contract-level required `importSnapshot`/`importEvent`/`importReceipt`, atomic tmp+rename for content writes, `replaceAll` on index, `ON CONFLICT` for Postgres TOCTOU, orphan-mutation surfacing in doctor) are all present and correct at HEAD `71ba55c`. The proactive-health concerns that remain are mostly about ROBUSTNESS UNDER STRESS that A3 wasn't scoped to address: multi-process write races (STORES-B-001), unbounded ledger growth + O(N^2) writes (STORES-B-002, B-013), Postgres pool hardening (STORES-B-006, B-028), and migration-versioning futureproofing (STORES-B-005).

Top 3 HIGH findings:
1. **STORES-B-001** — fixed `.tmp` suffix across all four local adapters is a multi-writer corruption bug; carries the bug-report meta-pattern (silent data loss with no downstream check).
2. **STORES-B-002** — `LocalLedgerStore` rewrites entire array on every append; O(N^2) cost and a single bad write nukes the entire append-only ledger.
3. **STORES-B-005** — Postgres has 1 migration and no `db_cluster_migrations` table; v0.2 has no safe path forward without designing this NOW.

Findings totals: 8 HIGH, 11 MEDIUM, 9 LOW, 3 classified as `should-have-been-stage-a` (STORES-B-001 multi-process .tmp race, STORES-B-003 silent duplicate-id swallow, STORES-B-015 trace() infinite loop on cyclic parent chain — these are runtime correctness bugs that the v2 ensemble could have caught with the cross-boundary-information-flow or invariant-test-completeness lenses, not proactive-health concerns).

No carry-over was materially worse than its Wave A3 classification. The two carry-overs that escalated to HIGH (B-001 from STORES-R2-007, B-003 from STORES-R2-008) were already noted as deferred items in Wave A3's re-audit-2 §11; A3 chose to ship without them. Stage B reclassifies them as proactive-health HIGH because the silent-data-loss failure modes are not detected by any downstream verifier in the cluster.
