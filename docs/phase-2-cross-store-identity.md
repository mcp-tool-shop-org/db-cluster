# Phase 2 — Cross-Store Identity and Rebuildable Index

## Goal

> Turn the working cluster into a navigable cluster: stable cluster URIs, explicit owner resolution, index rebuild command, stale-index detection, and explainable cross-store identity.

Phase 1 proved the cluster works.  
Phase 2 makes the cluster **addressable, rebuildable, and explainable.**

## Success sentence

> The cluster can tell you what exists, where it lives, who owns it, why it is indexed, and whether the index still matches source truth.

## Build Waves

### Wave 1 — Cluster URI model

Define the `cluster://` URI scheme and parsing/formatting:
- `cluster://canonical/<id>`
- `cluster://artifact/<id>`
- `cluster://index/<id>`
- `cluster://ledger/<id>` (events)
- `cluster://receipt/<id>`

Every persisted object can be addressed by URI. URIs are not opaque — they encode the owner store.

### Wave 2 — Resolver spine

`resolve(uri)` returns the owner-store object, not an index projection.
- Works for all four stores + receipts
- Returns typed result with owner metadata
- Resolves batch URIs efficiently
- Errors honestly when URI points to missing truth

### Wave 3 — Index rebuild command

- `kernel.rebuildIndex()` — clear index, re-index from canonical/artifact/ledger truth
- `db-cluster index rebuild` CLI command
- `db-cluster index status` CLI command (counts, staleness estimate)
- Provenance event for rebuild operations

### Wave 4 — Index explain/status

- `kernel.explainIndex(recordId)` — why does this record exist? what owned truth does it derive from?
- `db-cluster index explain <record-id>` CLI command
- Stale detection: compare index record metadata against source truth freshness
- `db-cluster index stale` — list records that don't match source truth

### Wave 5 — Proof tests

- URI roundtrip tests (parse → format → resolve)
- Resolver returns owner truth, not index projection
- Rebuild produces identical index
- Stale detection catches edits that bypass index
- Explain traces to owner store
- Cross-store identity stable across restart

## Non-Negotiable Laws

1. URIs encode ownership — the store name is in the URI scheme
2. Resolution always goes to the owner store, never the index
3. Index rebuild is total — clear then re-derive from truth stores
4. Explain must name the source truth, not just say "indexed"
5. Stale detection compares against owner-store state, not cached projections

## Drift traps

- Do not let URIs become opaque GUIDs without store context
- Do not let resolve() fall back to index when owner-store lookup fails
- Do not let explain return "exists in index" without naming the owner truth
- Do not build a URI registry that becomes another store
