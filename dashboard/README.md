# Dashboard — ClusterTruthInspector

A truth-inspection dashboard for db-cluster. Visualizes cluster ownership, provenance, policy, operations, and mutation law. Renders in any modern browser; no build step required.

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

## Architecture

The UI consumes `DashboardObject` — a shaped model produced by `src/dashboard/inspector-data.ts` from kernel verbs. The component **never reads raw adapter stores** — Architecture law #2 (indexes are derivative) is enforced at the dashboard layer too.

Every component takes a `state: ComponentState<T>` prop that distinguishes the four load states the panel can be in:

```typescript
import type { ComponentState } from '@mcptoolshop/db-cluster/types';

type ComponentState<T> =
    | { status: 'loading' }
    | { status: 'empty'; reason: 'no_data' | 'no_match' | 'all_filtered_by_policy' }
    | { status: 'error'; envelope: AiErrorEnvelope }
    | { status: 'ready'; data: T };
```

The panel renders a skeleton for `loading`, an empty-state hint for `empty`, an error envelope for `error`, and the live data for `ready`. Returning `null` from a panel on missing data is forbidden (SURFACE-C-017 closed in Wave C1-Amend).

## Components

### `<ClusterTruthInspector />` (root)

The top-level inspector. Hosts `StoreLanesMap` + `ProvenanceTimeline` + `ExplainIndexPanel`.

**Props:**

| Prop | Type | Required | Description |
|---|---|---|---|
| `data` | `DashboardObject[]` | Yes | Array of shaped cluster objects from `inspector-data.ts`. |
| `state` | `ComponentState<DashboardObject[]>` | No | Override the auto-derived state with an explicit load state. |
| `principal` | `Principal` | No | Principal whose policy view is rendered. Defaults to the operator view. |

**Mount in a host app:**

```html
<div id="cluster-inspector"></div>
<script type="text/babel" data-presets="env,react" src="ClusterTruthInspector.jsx"></script>
<script>
  // After scripts load (see Readiness model below):
  ReactDOM.createRoot(document.getElementById('cluster-inspector'))
    .render(React.createElement(ClusterTruthInspector, { data: clusterData }));
</script>
```

### `<OperationsPanel />`

Cluster health + integrity at a glance. Renders doctor/verify output, mutation_orphaned counts, repair suggestions.

**Props:**

| Prop | Type | Required | Description |
|---|---|---|---|
| `opsData` | `OpsModel` | Yes | Output of `buildOpsModel(doctor, verify)` from `src/dashboard/ops-model.ts`. |
| `state` | `ComponentState<OpsModel>` | No | Explicit load state. |
| `onRepairAction` | `(action: RepairSuggestion) => void` | No | Click handler for repair-suggestion buttons. Wire to a CLI invocation in a host app. |

**Empty-state:** when `opsData.checks` is empty, renders "No diagnostics yet — run `db-cluster doctor`." (was: returns `null`, pre-Wave-C1-Amend).

### `<CommandPreviewPanel />`

Command lifecycle visualization. Shows proposed / validated / approved / committed / rejected status alongside the payload preview.

**Props:**

| Prop | Type | Required | Description |
|---|---|---|---|
| `command` | `Command` | Yes | The command (from `inspectCommand` / `listReceipts`). |
| `state` | `ComponentState<Command>` | No | Explicit load state. |

### `<PolicyViewToggle />`

Renders the same `DashboardObject` from four principal views: operator / agent / observer / external. Applies `applyRedaction(obj, view)` from `dashboard/lib/apply-redaction.js`.

**Props:**

| Prop | Type | Required | Description |
|---|---|---|---|
| `object` | `DashboardObject` | Yes | The object to render. |
| `view` | `'operator' \| 'agent' \| 'observer' \| 'external'` | Yes | The principal view. |

**Redaction marker rendering:** the panel uses `isRedactedMarker(value)` from `@mcptoolshop/db-cluster/types` to detect redacted fields and render the `[Access restricted]` placeholder — never `[object Object]` JSON literals.

## Screenshots

See `screenshots/` for reference renders:

- `01-default.png` — `<ClusterTruthInspector />` mounted with inline demo data; default operator view shows the canonical / artifact / index / ledger lanes populated + the provenance timeline strip beneath them.
- `02-full.png` — full-page render with `<OperationsPanel />` + `<CommandPreviewPanel />` + `<PolicyViewToggle />` all visible; demonstrates the at-a-glance layout when every panel has data.
- `03-full2.png` — alternate full-page render with a different cluster snapshot loaded; shows the inspector handling a larger entity set (entity count > demo defaults).
- `04-hq.png` — high-resolution capture suitable for README / docs / marketing use; same layout as `02-full.png` rendered at 2x device-pixel-ratio.

## Readiness model (SURFACE-B-015 fix)

The dashboard bootstrap loads two scripts asynchronously: `ClusterTruthInspector.jsx` (via Babel-in-the-browser) and `lib/apply-redaction.js` (via native ES module). Pre-Wave-B1-Amend the mount loop polled only for `window.ClusterTruthInspector` — any consumer that loaded a component depending on `window.applyRedaction` (e.g. `PolicyViewToggle`) hit an intermittent race on first render when the ESM script had not yet executed.

The mount loop now polls for BOTH `window.ClusterTruthInspector` AND `window.applyRedaction` before calling `ReactDOM.createRoot(...).render(...)`. Consumers that add new components depending on the shared redaction lib do NOT need to add their own readiness check — the bootstrap waits for the global before mounting.

If you extend the demo with additional async-loaded globals, add them to the readiness predicate in `index.html`'s bootstrap script. The readiness loop's max-tries cap is 50 (≈2.5s) — if a script fails to load within that window the root renders a visible error message instead of hanging silently.

## Code example: minimal host-app mount

```html
<!DOCTYPE html>
<html>
<head>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script type="module" src="lib/apply-redaction.js"></script>
  <script type="text/babel" data-presets="env,react" src="ClusterTruthInspector.jsx"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    // Fetch cluster snapshot from a host endpoint (see scripts/dashboard-snapshot.ts).
    fetch('/api/cluster-snapshot.json')
      .then(r => r.json())
      .then(clusterData => {
        ReactDOM.createRoot(document.getElementById('root'))
          .render(<ClusterTruthInspector data={clusterData} />);
      });
  </script>
</body>
</html>
```

## Related

- `src/dashboard/inspector-data.ts` — produces `DashboardObject` from kernel verbs.
- `src/dashboard/ops-model.ts` — produces `OpsModel` from doctor/verify output.
- `src/types/component-state.ts` — `ComponentState<T>` discriminated union.
- `src/types/ai-envelope.ts` — `AiErrorEnvelope` shape (used in `error` state).
- `dashboard/lib/apply-redaction.js` — runtime redaction adapter.
- `scripts/dashboard-snapshot.ts` — generates static JSON snapshots from a live cluster.
