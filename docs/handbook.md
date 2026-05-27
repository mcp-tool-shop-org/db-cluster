# db-cluster Handbook

`db-cluster` is an AI-native database cluster: specialized truth stores connected by identity, index, provenance, policy, operations, and command-gated mutation law.

This handbook is the canonical operator and developer guide. It covers what `db-cluster` is, how to use it, and why its laws matter.

---

## 1. Product thesis

### 1.1 One-sentence definition

`db-cluster` is a federated database cluster for AI-facing truth: canonical records, artifacts, derivative indexes, provenance ledgers, policy boundaries, and command-gated mutation exposed through CLI, SDK, MCP, and dashboard inspection.

### 1.2 What it is not

| Not this | Why |
|----------|-----|
| RAG framework | Evidence bundles resolve to owner truth, not similarity search outputs |
| Vector database | Index is derivative — it can be deleted and rebuilt |
| AI SQL assistant | No natural-language writes, no text-to-SQL |
| Chatbot over a database | No conversational interface, no model calls in the kernel |
| Generic CRUD | All mutations go through typed command lifecycle |
| Just an MCP server | MCP is an access surface, not the product |
| Dashboard product | Dashboard inspects truth, it is not a metrics UI |
| Governance middleware | The cluster stores truth; governance is built-in, not bolted-on |
| Memory layer | Explicit governance, not implicit storage |
| repo-knowledge replacement | Parallel substrate, not auto-replacement |

### 1.3 Core product law

> The cluster is the product.
> The kernel, index, MCP, dashboard, and policy layers are support systems.

### 1.4 Why AI needs this

AI systems struggle with databases when truth, schema meaning, provenance, mutation authority, and permissions are implicit. Standard databases store rows. `db-cluster` stores truth with ownership, provenance, and policy boundaries that AI agents can reason about without guessing.

The core problem:

- AI cannot verify its own claims without traceable source truth
- AI should not mutate state directly — it must propose and be governed
- AI needs to know what it does not know (missing context, stale data)
- AI needs different stores for different truth shapes (entities vs documents vs events)

---

## 2. Mental model

### 2.1 The four-store spine

| Store | Owns | Does not own |
|-------|------|--------------|
| **Canonical** | entities, stable state, durable records | artifacts, index truth, provenance |
| **Artifact** | raw/source documents, files, evidence | canonical facts |
| **Index** | derivative discovery records | source truth (rebuildable) |
| **Ledger** | provenance events, commands, receipts, audit | mutable business state |

Each store exists because it preserves a different truth shape. Canonical records need stable IDs and updates. Artifacts are immutable source material. Indexes are derivative and rebuildable. Ledger events are append-only history.

### 2.2 Support layers

| Layer | Role |
|-------|------|
| Cluster URI | Stable cross-store identity (`cluster://store/id`) |
| Kernel | Routes, validates, coordinates across stores |
| Index | Discoverability — never truth |
| Retrieval planner | Assembles evidence bundles from index → owner truth |
| Provenance graph | Why/how/what changed — traceable history |
| Command runtime | Safe mutation lifecycle (propose → validate → approve → commit) |
| Policy engine | Access control, redaction, trust boundaries |
| Operations toolkit | doctor, verify, rebuild, backup, restore |
| Dashboard | Truth inspection surface |
| CLI / SDK / MCP | Access surfaces (all enforce the same laws) |

### 2.3 Golden rule

> Every surfaced object should be able to answer: who owns me, why do I exist, what supports me, what changed me, and what policy controls me?

---

## 3. Architecture overview

### 3.1 Cluster object model

| Object | Store | Purpose |
|--------|-------|---------|
| `Entity` | canonical | Stable state records (facts, claims, decisions, phases) |
| `Artifact` | artifact | Immutable source documents, files, generated outputs |
| `IndexRecord` | index | Derivative discovery entry pointing to owner truth |
| `ProvenanceEvent` | ledger | Who did what, when, why, to which object |
| `Command` | ledger | Typed mutation proposal with lifecycle state |
| `Receipt` | ledger | Proof that a mutation was committed |
| `EvidenceBundle` | (computed) | Structured retrieval result with provenance + freshness |
| `ProvenanceGraph` | (computed) | Node/edge trace of object history |

### 3.2 Cluster URI model

Every object has a stable address:

```
cluster://canonical/<entity-id>
cluster://artifact/<artifact-id>
cluster://index/<index-record-id>
cluster://ledger/<event-or-receipt-id>
```

Properties:
- **Stable identity** — URIs do not change when indexes rebuild
- **Owner-store resolution** — resolving a URI always returns owner truth, never index projection
- **Cross-store links** — provenance events reference subjects by URI

### 3.3 Kernel verbs

The kernel coordinates all operations. It does not replace the stores.

| Verb | Type | Effect |
|------|------|--------|
| `ingestArtifact` | write | Store artifact + index + provenance |
| `createEntity` | write | Store entity + index + provenance |
| `linkEvidence` | write | Link artifact as evidence for entity |
| `findSources` | read | Search index → resolve to owner truth |
| `retrieveBundle` | read | Structured evidence bundle |
| `traceObject` | read | Provenance graph |
| `why` | read | Compact explanation of existence |
| `proposeMutation` | staged | Create command (no store write) |
| `validateMutation` | staged | Check command semantics |
| `approveMutation` | staged | Operator gate |
| `commitMutation` | write | Execute command → receipt + provenance |
| `compensateMutation` | write | Correct without erasing |
| `doctor` | read | Cluster health diagnosis |
| `verify` | read | Data consistency proof |
| `backup` | read | Export cluster state |
| `restore` | write | Import cluster state |
| `rebuildIndex` | write | Reconstruct index from owner truth |

---

## 4. Quickstart

### 4.1 Install

```bash
npm install db-cluster
```

### 4.2 Initialize a cluster

```bash
db-cluster init
```

Creates `.db-cluster/` in the current directory:

```
.db-cluster/
├── canonical/    # entity records
├── artifacts/    # source documents
├── index/        # derivative discovery
├── ledger/       # provenance + receipts
└── commands/     # mutation lifecycle state
```

### 4.3 Ingest an artifact

```bash
db-cluster ingest ./evidence.md
```

The file is stored immutably. An index record is created for discoverability. A provenance event records the ingestion.

### 4.4 Create a canonical entity

```bash
db-cluster entity create --kind fact --name "LLMs need structured mutation boundaries"
```

### 4.5 Link evidence

```bash
db-cluster link --entity-id <entity-id> --artifact-id <artifact-id>
```

Creates a provenance event linking the artifact as supporting evidence for the entity.

### 4.6 Retrieve evidence

```bash
db-cluster retrieve "mutation boundaries"
```

Returns a structured evidence bundle: resolved entities, resolved artifacts, freshness, gaps, confidence.

### 4.7 Trace provenance

```bash
db-cluster trace cluster://canonical/<entity-id>
db-cluster why cluster://canonical/<entity-id>
```

### 4.8 Propose and commit a mutation

```bash
# Propose (no store write)
db-cluster propose '{"verb":"update_entity","targetStore":"canonical","payload":{"entityId":"...","patch":{"name":"Corrected name"}},"proposedBy":"developer"}'

# Validate
db-cluster validate <command-id>

# Approve
db-cluster approve <command-id> --by operator --note "Reviewed"

# Commit (writes to store, emits receipt)
db-cluster commit <command-id>

# View receipts
db-cluster receipts
```

### 4.9 Verify health

```bash
db-cluster doctor    # diagnose
db-cluster verify    # prove invariants
```

---

## 5. Retrieval and evidence bundles

### 5.1 Why retrieval is not search

Search returns text matches. `db-cluster` retrieval returns **evidence bundles** — structured results that resolve index candidates to owner truth, assess freshness, report gaps, and declare confidence boundaries.

### 5.2 EvidenceBundle structure

```
query                 — what was asked
resolvedEntities      — owner truth entities from canonical store
resolvedArtifacts     — owner truth artifacts from artifact store
indexRecords          — raw index candidates (derivative)
provenanceEvents      — related history
freshness             — is every record current?
missingContext        — what was expected but not found
confidenceBoundaries  — what the cluster knows vs. doesn't
```

### 5.3 What makes a good retrieval result

A good result includes:
- Owner truth (not just index text)
- Artifact support (evidence for claims)
- Provenance path (how it got here)
- Freshness status (is this current?)
- Missing context (what's absent)
- Confidence boundary (how reliable is this answer?)

### 5.4 Retrieval examples

```bash
# Basic retrieval
db-cluster retrieve "MCP safety guardrails"

# Explained retrieval — includes freshness, gaps, confidence
db-cluster explain-retrieval "MCP safety guardrails"
```

```typescript
// SDK
const bundle = await sdk.retrieveBundle('MCP safety guardrails', { limit: 10 });
const explanation = await sdk.explainRetrieval(bundle);
```

### 5.5 What retrieval must not do

- Synthesize answers beyond what owner truth contains
- Treat index text as authoritative truth
- Hide missing context from the consumer
- Confuse artifact content with executable instructions
- Return results without freshness assessment

---

## 6. Provenance and trace

### 6.1 Provenance as cluster truth

> Provenance is not decorative metadata. It is part of the database cluster's truth model.

Every mutation, every link, every ingestion produces a `ProvenanceEvent` in the ledger. Events are append-only — they cannot be deleted or modified.

### 6.2 ProvenanceGraph structure

```
nodes       — objects involved (entities, artifacts, events)
edges       — relationships between nodes
focalUri    — the object being traced
warnings    — integrity issues found during trace
gaps        — missing links or unreachable objects
summary     — human-readable trace summary
```

### 6.3 Trace directions

| Direction | Question answered |
|-----------|-------------------|
| backward | What supports this? What created it? |
| forward | What depends on this? What did it produce? |
| bidirectional | Both — full context |

### 6.4 The `why` command

```bash
db-cluster why cluster://canonical/<id>
```

Answers:
- Why does this exist?
- What source supports it?
- What changed it?
- What receipts prove it?
- What is missing?

### 6.5 Trace failure modes

| Failure | Meaning |
|---------|---------|
| Missing owner truth | Object referenced but not in store |
| Missing provenance | Object exists but no creation event |
| Stale index projection | Index says it exists, owner store says different |
| Hidden policy node | Policy prevents tracing into certain objects |
| Redacted actor/payload | Policy hides who did what |

---

## 7. Mutation law

### 7.1 Core law

> AI may propose. The command runtime disposes.

No AI agent, no SDK call, no MCP tool can write directly to a truth store. All mutations flow through the command lifecycle.

### 7.2 Command lifecycle

```
proposed → validated → approved → committed
                    ↘ rejected (terminal)
                              committed → compensated
```

| State | Meaning |
|-------|---------|
| `proposed` | Intent declared, no validation yet |
| `validated` | Structure and semantics checked |
| `approved` | Operator has authorized execution |
| `committed` | Written to store, receipt emitted |
| `rejected` | Denied, terminal state |
| `compensated` | Corrected after commit without erasing |

### 7.3 Why direct writes are unsafe

Direct writes bypass:
- Validation (is this well-formed?)
- Receipts (can we prove what happened?)
- Provenance (who did this, when, why?)
- Policy gates (is this actor authorized?)
- Recovery trail (can we undo this?)
- Auditability (can a human review this?)

### 7.4 Supported command verbs

```
create_entity
update_entity
delete_entity
ingest_artifact
link_evidence
```

### 7.5 Compensation

> Compensation corrects history without erasing history.

When a committed mutation turns out to be wrong, compensation creates a new command that reverses the effect while preserving the full audit trail. The original commit remains in the ledger.

```bash
db-cluster compensate <command-id> --by operator --reason "Name was incorrect"
```

---

## 8. Policy, permissions, and redaction

### 8.1 What policy controls

Capabilities — quick reference; the canonical type union and the
`PolicyMatch.capabilities` filter live in
[`docs/policy-and-redaction.md`](policy-and-redaction.md):

| Capability | Meaning |
|-----------|---------|
| `discover_existence` | Can this principal know the object exists? |
| `read_owner_truth` | Can they read the full object? |
| `read_derivative` | Can they read index projections? |
| `trace_provenance` | Can they see the audit trail? |
| `propose_mutation` | Can they propose changes? |
| `validate_command` | Can they trigger validation? |
| `approve_command` | Can they authorize execution? |
| `reject_command` | Can they deny changes? |
| `commit_command` | Can they execute mutations? |
| `compensate_command` | Can they correct past mutations? |
| `read_receipts` | Can they see proof of operations? |
| `explain_retrieval` | Can they see retrieval explanations? |

### 8.2 Principals and trust zones

A `Principal` is any actor in the system. The canonical type definition and
the full `Capability` union live in
[`docs/policy-and-redaction.md`](policy-and-redaction.md) — that is the
single source of truth and the consumer doc you should link to from new
material. The Principal shape (id, name, roles[], trustZone, optional
metadata) is small enough that the handbook used to restate it; that was
removed in Wave B1-Amend so a future Capability addition only requires one
doc edit, not six.

Trust zones:

| Zone | Typical use |
|------|-------------|
| `internal` | Operators, full access |
| `agent` | AI agents — read + propose, no commit |
| `external` | Restricted consumers, limited read |

### 8.3 Policy decisions

Every operation produces a policy decision:

```
allow / deny
reason          — why this decision
matched policy  — which rule fired
redaction       — what to strip/mask
visibility      — can the object's existence be disclosed?
approval        — does this operation require operator sign-off?
```

### 8.4 Redaction targets

| Target | Effect |
|--------|--------|
| Artifact content | File contents hidden |
| Entity attributes | Sensitive fields masked |
| Command payload | Mutation details stripped |
| Provenance actors | Who-did-what hidden |
| Receipt details | Operation proof redacted |
| Index source URI | Object location hidden |

Redaction behaviors: `strip` (remove), `mask` (replace with `[REDACTED]`), `summarize` (replace with summary), `hash` (replace with SHA-256).

### 8.5 Existence leakage

Denying access is not enough. The system must also control whether an object's **existence** is disclosed. A `discover_existence` check runs before any other capability check.

### 8.6 Policy commands

```bash
# Explain effective policy for a principal + resource
db-cluster policy explain --principal '{"id":"agent","name":"Agent","roles":["reader","proposer"],"trustZone":"agent"}' --resource 'cluster://canonical/entity-id'

# Test multiple policy actions without executing
db-cluster policy test --principal '{"id":"external","name":"External","roles":["reader"],"trustZone":"external"}' --capability read_owner_truth --store canonical
```

---

## 9. Operations and recovery

### 9.1 Why operations are part of the product

A database cluster must survive damage. Recovery is not optional — it is product behavior. Doctor, verify, rebuild, backup, and restore are first-class operations, not afterthoughts.

### 9.2 Doctor vs verify

| Command | Purpose | Mutates? |
|---------|---------|----------|
| `doctor` | Diagnose health — reachability, freshness, configuration | No |
| `verify` | Prove invariants — data consistency, referential integrity | No |

### 9.3 Operational commands

```bash
db-cluster doctor                  # Full health assessment
db-cluster verify                  # Data consistency proof
db-cluster rebuild index           # Reconstruct index from owner truth
db-cluster rebuild index --dry-run # Preview what would be rebuilt
db-cluster backup                  # Export cluster state to JSON
db-cluster backup -o ./backup.json # Export to specific file
db-cluster restore ./backup.json   # Import cluster state
db-cluster stores verify           # Check backend connectivity
db-cluster stores migrate          # Run pending migrations
db-cluster migration-status        # Check Postgres schema state
db-cluster verify-schema           # Validate physical backend schema
```

### 9.4 Health states

| State | Meaning |
|-------|---------|
| `healthy` | All checks pass |
| `degraded` | Functional but impaired (stale index, missing non-critical data) |
| `stale` | Data exists but freshness cannot be confirmed |
| `missing` | Expected data not found |
| `corrupt` | Data exists but fails integrity checks |
| `unreachable` | Backend cannot be contacted |
| `unverified` | Checks have not been run |

### 9.5 Backup and restore

Backup exports:
- All canonical entities
- All artifacts (with content, base64-encoded)
- All provenance events
- All receipts
- Command queue state

Restore imports the backup and verifies integrity. Index is rebuilt from restored owner truth.

### 9.6 Common damage scenarios

Each scenario lists the verify-symptom (what `doctor`/`verify` says), the verify-recovery (commands to run), and the escalate column (when to bail). For full step-by-step procedures see `docs/runbooks/`.

| Scenario | Verify-symptom | Verify-recovery | Escalate | Runbook |
|---|---|---|---|---|
| Deleted index | `doctor` reports `index` in `missing` status; `rebuild check` returns 0 records | `db-cluster rebuild check`; if expected-total > 0, `db-cluster rebuild index` | If rebuild reports stale records post-rebuild, the canonical/artifact stores have inconsistent owner truth | [index-stale.md](runbooks/index-stale.md) |
| Stale index projection | `doctor` reports `index` in `stale`; `rebuild check` returns `possiblyStale > 0` | `db-cluster rebuild index --dry-run` then `db-cluster rebuild index` | If `verify --sample 200` post-rebuild still reports inconsistencies, escalate | [index-stale.md](runbooks/index-stale.md) |
| Corrupt store file | `doctor` reports a store in `corrupt`; CLI exit 70 with `CORRUPT_STORE` | Restore from backup; if backup unavailable AND file is `pending-commands.json`/index, excise; otherwise stop | Multiple stores corrupt simultaneously (filesystem failure); recurrence after restore | [corrupt-store.md](runbooks/corrupt-store.md) |
| Command queue corrupt | CLI exit 70 with `COMMAND_QUEUE_CORRUPT` or `COMMAND_QUEUE_PERSISTENCE_LOST` | Restore from backup that includes `pending-commands.json` + `command-queue-marker`; OR delete both files to re-cold-start (loses pending commands) | If pending commands are load-bearing and no backup exists | [corrupt-store.md](runbooks/corrupt-store.md) (Command queue section) |
| Orphan mutations | `doctor` reports `mutation_orphaned > 0`; CLI exit 70 with `RECEIPT_FAILED` | `db-cluster doctor --json` to confirm; backfill receipt OR restore from pre-orphan backup; do NOT blindly retry | More than 5 orphans accumulating, OR cascading `verify` failures | [orphan-mutations.md](runbooks/orphan-mutations.md) |
| Missing artifact | `doctor` reports `artifact_count_mismatch`; `verify` reports broken artifact reference | `db-cluster restore` from backup | If backup also missing the artifact, the source content is lost — escalate | [corrupt-store.md](runbooks/corrupt-store.md) |
| Missing receipt | `doctor` reports `mutation_orphaned`, OR `db-cluster receipts` shows gap | `db-cluster restore` from backup that includes the receipt; OR re-record via compensating receipt if audit allows | Multiple missing receipts across the same time window suggests ledger corruption | [orphan-mutations.md](runbooks/orphan-mutations.md) |
| Broken provenance link | `verify` reports `provenance_subject_missing`; CLI exit 70 with `PROVENANCE_MISSING` | `db-cluster verify --json --sample 200` to identify all broken links; manually repair by recording compensating events | If breaks span the entire ledger window, escalate | [orphan-mutations.md](runbooks/orphan-mutations.md) |
| Ledger cycle | CLI exit 65 with `LEDGER_CYCLE_DETECTED`; error names the cycle path | Excise the cycling event by hand OR restore from backup | Cycle > 5 events deep (manual excision unsafe) | [corrupt-store.md](runbooks/corrupt-store.md) (Ledger section) |
| Postgres unreachable | `doctor` reports `canonical` in `unreachable`; logs show connection refused | `psql` to confirm reachability; check `pg_hba.conf`; restart Postgres if needed | If reachable but `verify-schema` still drifts post-migrate | [postgres-unreachable.md](runbooks/postgres-unreachable.md) |
| Postgres schema drift | `migration-status` reports missing tables; `verify-schema` reports column drift | `db-cluster stores migrate`; re-verify | If migration reports success but `verify-schema` still drifts | [postgres-unreachable.md](runbooks/postgres-unreachable.md) |
| Postgres pool exhaustion | `doctor` reports pool errors; stderr logs from `pool.on('error', ...)` | Pool re-establishes on next `db-cluster doctor`; for chronic exhaustion, increase Postgres `max_connections` OR reduce concurrent db-cluster processes | If exhaustion recurs every minute (structural network issue) | [postgres-unreachable.md](runbooks/postgres-unreachable.md) |
| Invalid policy config | CLI exit 78 with `INVALID_POLICY_CONFIG` | Validate the policy YAML / JSON against the schema in `docs/policy-and-redaction.md`; fix and retry | If the policy passes schema but still rejects all access, the policy logic is wrong | (inline — fix and retry) |
| Content hash mismatch | CLI exit 65 with `CONTENT_HASH_MISMATCH` on propose | Recompute `sha256(content)` and re-propose | If the same caller repeatedly mismatches, the caller is computing the hash wrong | (inline — fix caller) |
| Staged content tampered | CLI exit 65 with `STAGED_CONTENT_TAMPERED` on commit | Inspect the staging file (preserved for forensics); investigate the cause; remove staging file; re-propose | If tampering is intentional, this is a security incident — escalate | (inline — investigate, do NOT retry) |
| Policy-denied | CLI exit 77 with `POLICY_DENIED` | The principal lacks the named capability; request capability OR call `db-cluster policy explain` to inspect the denial | If policy explain returns no matching rule, the policy config is incomplete | (inline — request capability) |

---

## 10. Physical backends

### 10.1 Logical store law before physical backend

> Backends implement store contracts. They do not redefine store ownership.

A canonical store backed by Postgres is still a canonical store. It still owns entities. It still answers to the kernel. The backend is an implementation choice, not a product change.

### 10.2 Current backend support

| Store | Backends |
|-------|----------|
| Canonical | local filesystem, Postgres |
| Artifact | local filesystem |
| Index | local filesystem |
| Ledger | local filesystem |

### 10.3 Postgres canonical store

Setup:

```bash
export DB_CLUSTER_POSTGRES_URL="postgresql://user:pass@localhost:5432/dbcluster"
export DB_CLUSTER_CANONICAL_BACKEND="postgres"
```

Migration:

```bash
db-cluster stores migrate
db-cluster migration-status
db-cluster verify-schema
```

Local fallback: if `DB_CLUSTER_CANONICAL_BACKEND` is not set, all stores use local filesystem. Postgres is opt-in.

### 10.4 Non-goals (not yet)

- Vector backend for index store
- Graph backend for provenance
- S3 artifact backend
- Distributed replication
- Hosted control plane

---

## 11. CLI reference

### 11.1 Core commands

| Command | Purpose |
|---------|---------|
| `init` | Initialize cluster in current directory |
| `ingest <file>` | Store artifact + index |
| `entity create` | Create canonical entity |
| `entity list` | List entities |
| `link` | Link artifact as evidence |
| `find <query>` | Search index |
| `inspect <id>` | Inspect entity (owner truth) |
| `retrieve <query>` | Evidence bundle |
| `explain-retrieval <query>` | Explained evidence bundle |
| `resolve <uri>` | Resolve cluster URI to owner truth |
| `trace <uri>` | Provenance graph |
| `why <uri>` | Compact existence explanation |
| `lineage <uri>` | Full bidirectional lineage |
| `trace-bundle <query>` | Trace an entire retrieval |
| `receipts` | List mutation receipts |

### 11.2 Mutation commands

| Command | Purpose |
|---------|---------|
| `propose <json>` | Propose mutation (no store write) |
| `validate <id>` | Validate command semantics |
| `approve <id>` | Approve (operator gate) |
| `reject <id>` | Reject (terminal) |
| `commit <id>` | Execute mutation (writes to store) |
| `compensate <id>` | Correct past mutation |
| `inspect-command <id>` | View command lifecycle state |

### 11.3 Policy commands

| Command | Purpose |
|---------|---------|
| `policy explain` | Show effective policy for principal |
| `policy test` | Test policy actions (dry-run) |

### 11.4 Store and operation commands

| Command | Purpose |
|---------|---------|
| `doctor` | Cluster health diagnosis |
| `verify` | Data consistency proof |
| `rebuild index` | Reconstruct index from owner truth |
| `rebuild check` | Check for stale/orphan index records |
| `backup` | Export cluster state |
| `restore <file>` | Import cluster state |
| `stores list` | List configured backends |
| `stores verify` | Check backend connectivity |
| `stores migrate` | Run pending migrations |
| `migration-status` | Postgres schema state |
| `verify-schema` | Validate backend schema |

### 11.5 Output formats

Most operational commands support `--json` for structured output suitable for automation:

```bash
db-cluster doctor --json
db-cluster verify --json
db-cluster rebuild check --json
```

---

## 12. SDK guide

### 12.1 SDK purpose

The SDK exposes cluster verbs, not raw stores. It enforces the same laws as CLI and MCP.

### 12.2 Setup

```typescript
import { ClusterSDK } from 'db-cluster/sdk';

const sdk = new ClusterSDK({ clusterDir: '.db-cluster' });
```

With policies (PolicyEnforcedKernel wired in):

```typescript
import { ClusterSDK } from 'db-cluster/sdk';
import {
    DEFAULT_POLICIES,
    DEFAULT_TRUST_ZONES,
    DEFAULT_VISIBILITY_RULES,
} from 'db-cluster/policy';
import type { Principal } from 'db-cluster/policy';

const operator: Principal = {
    id: 'operator',
    name: 'Operator',
    roles: ['operator'],
    trustZone: 'internal',
};

const sdk = new ClusterSDK({
    clusterDir: '.db-cluster',
    policies: DEFAULT_POLICIES,
    trustZones: DEFAULT_TRUST_ZONES,
    visibilityRules: DEFAULT_VISIBILITY_RULES,
    principal: operator,
});
```

### 12.3 Retrieval

```typescript
// Index search → owner truth resolution
const result = await sdk.findSources('database architecture');

// Structured evidence bundle
const bundle = await sdk.retrieveBundle('LLM safety', { limit: 10 });

// Explanation
const explanation = await sdk.explainRetrieval(bundle);
```

### 12.4 Provenance

```typescript
// Full graph
const graph = await sdk.traceObject('cluster://canonical/<id>');

// Compact explanation
const why = await sdk.why('cluster://canonical/<id>');
```

### 12.5 Mutation lifecycle

```typescript
// Propose (no write)
const cmd = await sdk.proposeMutation({
    verb: 'update_entity',
    targetStore: 'canonical',
    payload: { entityId: '...', patch: { name: 'Updated' } },
    proposedBy: 'developer',
});

// Validate → approve → commit
await sdk.validateMutation(cmd.id);
await sdk.approveMutation(cmd.id, 'operator', 'Reviewed');
const { command, receipt } = await sdk.commitMutation(cmd.id, 'operator');

// Or compensate after commit
await sdk.compensateMutation(cmd.id, 'operator', 'Name was wrong');
```

### 12.6 Operations

```typescript
import { doctor, verify, backup, restore, createLocalCluster } from 'db-cluster';

const stores = createLocalCluster('.db-cluster');
const health = await doctor(stores);
const proof = await verify(stores);
const snapshot = await backup(stores);
await restore(newStores, snapshot);
```

### 12.7 SDK anti-patterns

| Anti-pattern | Why it's wrong |
|--------------|----------------|
| Importing raw adapters | Bypasses kernel coordination |
| Mutating store files directly | No receipts, no provenance, no policy |
| Treating index records as truth | Index is derivative and rebuildable |
| Skipping command lifecycle | Loses audit trail and operator gate |

---

## 13. MCP guide

### 13.1 MCP purpose

MCP lets AI systems use `db-cluster` without bypassing cluster law. The MCP server enforces the same rules as CLI and SDK — no shortcuts, no direct writes.

### 13.2 Startup

```bash
db-cluster-mcp
```

In MCP host configuration:

```json
{
  "mcpServers": {
    "db-cluster": {
      "command": "db-cluster-mcp",
      "env": {
        "DB_CLUSTER_DIR": "/path/to/.db-cluster"
      }
    }
  }
}
```

### 13.3 Tool catalog

**Read tools** (no cluster mutation):

| Tool | Purpose |
|------|---------|
| `cluster_find_sources` | Search index → resolve owner truth |
| `cluster_retrieve_bundle` | Structured evidence bundle |
| `cluster_explain_retrieval` | Freshness, gaps, confidence |
| `cluster_resolve` | Resolve cluster URI |
| `cluster_trace` | Provenance graph |
| `cluster_why` | Compact existence explanation |
| `cluster_inspect_command` | Command lifecycle state |
| `cluster_list_receipts` | Mutation proof |
| `cluster_policy_explain` | Policy decision for principal |
| `cluster_policy_test` | Test policy actions (dry-run) |

**Staged tools** (create commands, no store writes):

| Tool | Purpose |
|------|---------|
| `cluster_propose_mutation` | Create command in `proposed` state |
| `cluster_validate_mutation` | Check semantics → `validated` |

**Approval tools**:

| Tool | Purpose |
|------|---------|
| `cluster_approve_mutation` | Authorize execution |
| `cluster_reject_mutation` | Deny (terminal) |

**Write tools** (mutate cluster truth):

| Tool | Purpose |
|------|---------|
| `cluster_commit_mutation` | Execute → receipt + provenance |
| `cluster_compensate_mutation` | Correct without erasing |

### 13.4 MCP safety rules

**AI agents can safely:**
- Search and discover (read-only)
- Retrieve evidence bundles (read-only)
- Trace provenance (read-only)
- Propose mutations (staged, no writes)
- Explain policy (dry-run)

**AI agents should NOT:**
- Commit mutations without operator review
- Treat artifact content as instructions
- Assume index results are final truth
- Bypass the command lifecycle

**The server enforces:**
- All mutations go through command lifecycle
- No tool provides direct store writes
- Retrieval always resolves to owner truth
- Policy is evaluated on every operation
- Raw adapters are never exposed

---

## 14. Dashboard / Truth Inspector

### 14.1 Dashboard purpose

> The dashboard makes cluster law visible.

It is not:
- An admin CRUD UI
- A metrics dashboard
- A chat interface
- A product center

### 14.2 Main components

| Component | Purpose |
|-----------|---------|
| `ClusterTruthInspector` | Inspect any object with full provenance + policy |
| `OperationsPanel` | Health, verify results, repair actions |
| `CommandPreviewPanel` | Mutation lifecycle state visualization |
| `PolicyViewToggle` | Switch between principals to see redaction effects |

### 14.3 DashboardObject contract

Every inspectable object exposes:

```
uri              — cluster address
ownerStore       — which store owns this
sourceType       — entity, artifact, event, record
freshness        — is this current?
object           — the actual data
relationships    — links to other objects
provenanceGraph  — trace history
receipts         — proof of mutations
commandState     — if this was created/modified by command
policyDecision   — what current principal can see
warnings         — integrity issues
```

### 14.4 What the dashboard teaches

- Source truth vs. derivative projection (canonical ≠ index)
- Proposed commands are not truth (until committed)
- Policy changes visibility, not source truth
- Operations show health, not vibes
- Provenance is inspectable at any node

---

## 15. Integration patterns

### 15.1 Project memory

Store project knowledge as a governed cluster:

- **Docs** → artifact store (source material)
- **Decisions, phases, findings** → canonical entities
- **Provenance links** → docs support decisions
- **Receipts** → prove when memory was updated

### 15.2 Repo-knowledge parallel substrate

Phase 14 proved `db-cluster` as a parallel backing for repo-knowledge workflows:

- Parallel ingest (read-only, no replacement)
- No auto-writeback to source files
- Evidence bundle comparison (structured vs. flat-file retrieval)
- Dashboard inspection of imported knowledge
- Mutation safety for fact updates

### 15.3 Research evidence cluster

Organize research findings:

- **Papers/reports** → artifact store
- **Claims/topics** → canonical entities
- **Evidence links** → which paper supports which claim
- **Provenance trace** → how claims evolved
- **Policy redaction** → control access to sensitive findings

### 15.4 Agent-safe app database

Use `db-cluster` as an AI-facing application database:

- **App records** → canonical entities
- **User uploads** → artifact store
- **Agent proposes changes** → command lifecycle
- **Operator approves/commits** → safety gate
- **Receipts and traces** → prove what changed and why

---

## 16. Dogfood lessons

### 16.1 Phase 11 findings

Real usage revealed:
- Restore did not restore artifact content
- Command state was not shared across kernel instances
- Command-created entities did not auto-index
- Index was too name-based (missed content)

### 16.2 Phase 12 repairs

Fixed:
- Artifact restore with content and integrity verification
- Disk-backed command queue (persists across processes)
- Auto-index on command create/update
- Content-aware indexing

### 16.3 What dogfood proved

- Retrieval bundles are useful in real workflows
- Provenance makes memory inspectable and trustworthy
- Mutation law catches unsafe direct-write patterns
- Dashboard clarifies cluster state for operators
- Operations matter — clusters break and must recover

---

## 17. Design laws

### 17.1 The cluster is the product

Do not re-center around MCP, dashboard, policy, or index. Those are support layers.

### 17.2 Every fact has an owner

No fact should exist only in model prose or index metadata. Every fact lives in a specific store.

### 17.3 The index is derivative

The index can be deleted and rebuilt from canonical + artifact truth. It is never the source of truth.

### 17.4 Provenance is truth

If it cannot be traced, it is incomplete. Provenance events are append-only.

### 17.5 Mutation is command-gated

No raw write authority for AI-facing surfaces. Propose → validate → approve → commit.

### 17.6 Policy changes visibility, not truth

Redaction does not mutate source truth. It controls what a principal can see.

### 17.7 Operations are product behavior

Recovery, diagnosis, and verification are first-class features, not afterthoughts.

---

## 18. Anti-patterns

### 18.1 RAG drift

**Symptom:** Search results summarized as truth. No owner-store resolution. No provenance.

**Fix:** Use `retrieveBundle` → resolve to owner truth → check freshness → declare confidence.

### 18.2 CRUD drift

**Symptom:** Direct edit forms. No command lifecycle. No receipts.

**Fix:** All mutations through `proposeMutation` → `validateMutation` → `approveMutation` → `commitMutation`.

### 18.3 Middleware drift

**Symptom:** Kernel becomes product center. Stores become interchangeable bags.

**Fix:** The cluster is the product. The kernel coordinates, it does not own truth.

### 18.4 Dashboard drift

**Symptom:** Charts and tables instead of truth inspection. Metrics without provenance.

**Fix:** Dashboard inspects objects, traces provenance, shows policy effects.

### 18.5 MCP demo drift

**Symptom:** Too many broad tools. Natural-language writes. No command IDs.

**Fix:** Typed command lifecycle. Propose is staged-only. Commit requires ID.

### 18.6 Backend sprawl

**Symptom:** Adding vector/graph/S3 stores before proving the store law needs them.

**Fix:** Each new backend must prove it preserves a truth shape that would be weakened elsewhere.

---

## 19. Release and package boundary

### 19.1 Public package surfaces

| Import | Contents |
|--------|----------|
| `db-cluster` | Store contracts, domain types, factory, ops, URI utilities |
| `db-cluster/sdk` | ClusterSDK high-level client |
| `db-cluster/mcp` | MCP tool catalog + handler |
| `db-cluster/policy` | PolicyEnforcedKernel, redaction, defaults |
| `db-cluster/types` | All domain type re-exports |

Bins: `db-cluster` (CLI), `db-cluster-mcp` (MCP server).

### 19.2 Private/internal surfaces

Not exported (may change without notice):
- Raw adapter implementations (local stores, Postgres)
- Command queue internals
- Provenance recording helpers
- Test helpers
- Integration harness internals (repo-knowledge)
- Dashboard demo internals
- Development scripts

### 19.3 Release readiness checks

The release gate verifies:
1. Build (`tsc --noEmit`)
2. Test suite (`vitest run`)
3. Package (`npm pack` — no test/scripts/src leakage)
4. Fresh install (9-test smoke from tarball)
5. CLI/MCP smoke
6. SDK import smoke
7. Docs drift check (examples match runtime)

---

## 20. Troubleshooting

### 20.1 `doctor` reports degraded

Check:
- Is the index stale? → `db-cluster rebuild index`
- Missing provenance events? → `db-cluster verify` for details
- Missing artifact files? → Restore from backup
- Invalid Postgres schema? → `db-cluster stores migrate`
- Unreachable backend? → Check connection/env vars

### 20.2 Retrieval returns too little

Check:
- Was index rebuilt after changes? → `db-cluster rebuild index`
- Was artifact content actually indexed? → Inspect index records
- Are query terms too narrow? → Try broader terms
- Are policy rules hiding owner truth? → `db-cluster policy explain`

### 20.3 MCP cannot commit

Check:
- Does the command exist? → `cluster_inspect_command`
- Was it rejected? → Terminal state, must propose again
- Did validation pass? → `cluster_validate_mutation` first
- Does the principal have commit capability? → Check trust zone
- Is approval required? → `cluster_approve_mutation` first

### 20.4 Dashboard shows redacted nodes

Check:
- What is the current principal/role? → Policy view toggle
- Which trust zone applies? → Check principal config
- Which redaction rule fired? → `db-cluster policy explain`
- Is existence itself hidden? → `discover_existence` capability

### 20.5 Backup/restore mismatch

Check:
- Was artifact content included in backup? → Default is yes
- Was command queue restored? → Check `commands/` directory
- Was index rebuilt after restore? → `db-cluster rebuild index`
- Do checksums match? → `db-cluster verify`

---

## 21. Glossary

| Term | Definition |
|------|-----------|
| **Canonical store** | Owns entities — stable state, durable records |
| **Artifact store** | Owns raw/source documents — immutable after ingestion |
| **Index store** | Derivative discovery records — rebuildable |
| **Ledger store** | Append-only provenance events, commands, receipts |
| **Owner truth** | The actual data in its owning store (not a projection) |
| **Derivative** | Computed from owner truth, can be rebuilt (e.g., index) |
| **Evidence bundle** | Structured retrieval result: truth + freshness + gaps + confidence |
| **Provenance graph** | Node/edge trace of object history |
| **Command lifecycle** | propose → validate → approve → commit (or reject) |
| **Receipt** | Proof that a mutation was committed |
| **Compensation** | Correcting a committed mutation without erasing history |
| **Policy decision** | Allow/deny + redaction rules for a principal + operation |
| **Redaction** | Hiding sensitive data while preserving object shape |
| **Visibility** | Whether an object's existence is disclosed |
| **Trust zone** | Security boundary defining principal capabilities |
| **Cluster URI** | Stable address: `cluster://store/id` |
| **Dashboard object** | Inspectable wrapper with provenance + policy + warnings |
| **Dogfood gate** | Using the product on itself to find real bugs |

---

## 22. Appendix: Phase history

| Phase | Delivered |
|-------|-----------|
| 1 | Cluster spine — four stores, kernel, CLI |
| 2 | Cross-store identity and rebuildable index |
| 3 | Retrieval bundles with freshness + gaps |
| 4 | Provenance graphs and trace |
| 5 | Mutation law — command lifecycle |
| 6 | MCP server + SDK |
| 7 | Policy, trust boundaries, redaction |
| 8 | Postgres canonical backend |
| 9 | Operations — doctor, verify, rebuild, backup, restore |
| 10 | Developer product surface |
| 11 | Dogfood gate — real usage findings |
| 12 | Dogfood repair — restore, command queue, auto-index |
| 13 | Dashboard / Truth Inspector integration |
| 14 | Repo-knowledge integration gate |
| 15 | Release readiness and package boundary |

> The phase history matters because each layer exists to preserve the product thesis: a database cluster for AI truth.
