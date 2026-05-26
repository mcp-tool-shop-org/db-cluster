# Dashboard — ClusterTruthInspector

A truth-inspection dashboard for db-cluster. Visualizes cluster ownership, provenance, policy, operations, and mutation law.

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
