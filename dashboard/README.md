# Dashboard — ClusterTruthInspector

A truth-inspection dashboard for db-cluster. Visualizes cluster ownership, provenance, policy, operations, and mutation law.

## Readiness model (SURFACE-B-015 fix)

The dashboard bootstrap loads two scripts asynchronously: `ClusterTruthInspector.jsx` (via Babel-in-the-browser) and `lib/apply-redaction.js` (via native ES module). Pre-Wave-B1-Amend the mount loop polled only for `window.ClusterTruthInspector` — any consumer that loaded a component depending on `window.applyRedaction` (e.g. `PolicyViewToggle`) hit an intermittent race on first render when the ESM script had not yet executed.

The mount loop now polls for BOTH `window.ClusterTruthInspector` AND `window.applyRedaction` before calling `ReactDOM.createRoot(...).render(...)`. Consumers that add new components depending on the shared redaction lib do NOT need to add their own readiness check — the bootstrap waits for the global before mounting.

If you extend the demo with additional async-loaded globals, add them to the readiness predicate in `index.html`'s bootstrap script. The readiness loop's max-tries cap is 50 (≈2.5s) — if a script fails to load within that window the root renders a visible error message instead of hanging silently.

## What this is

An **inspector** over cluster truth. It makes the four-store substrate visible:

- **canonical** — source truth (entities)
- **artifact** — raw source truth (immutable files)
- **index** — derivative (rebuildable projections)
- **ledger** — append-only (provenance + receipts)

## What this is NOT

- A CRUD admin panel
- A generic database dashboard
- A replacement for the CLI, SDK, or MCP server

## Running locally

Open `index.html` in a browser. No build step required — uses CDN React + Babel.

The component renders with inline demo data by default. To render from a dogfood snapshot:

```html
<script src="data/dogfood-snapshot.json" type="application/json" id="cluster-data"></script>
```

## Screenshots

See `screenshots/` for reference renders.

## Architecture

The UI consumes `DashboardObject` — a shaped model produced by `src/dashboard/inspector-data.ts` from kernel verbs. The component never reads raw adapter stores.
