/*
 * ClusterTruthInspector — a single drop-in React component.
 *
 * Inspects ONE object in a db-cluster and answers:
 *   1. Which store owns it.
 *   2. Whether the visible record is source truth or a derivative projection.
 *   3. What related objects exist across the cluster.
 *   4. Why an index record exists.
 *   5. What provenance path supports the object.
 *   6. What receipts modified it.
 *   7. Whether the index is fresh, stale, missing, or rebuildable.
 *
 * Mock data is inline; no fetch, no backend.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Store metadata — the four-store substrate.  Order matters: this is the
// vertical order of lanes in the cross-store map.
// ─────────────────────────────────────────────────────────────────────────────
const STORES = [
  { id: 'canonical', label: 'canonical', kind: 'source truth',  rule: 'every fact has an owner store',         color: 'canonical' },
  { id: 'artifact',  label: 'artifact',  kind: 'raw source',    rule: 'immutable by default — versions, not overwrites', color: 'artifact'  },
  { id: 'index',     label: 'index',     kind: 'derivative',    rule: 'rebuildable from canonical + artifact', color: 'index'     },
  { id: 'ledger',    label: 'ledger',    kind: 'append-only',   rule: 'provenance + receipts, never mutated',  color: 'ledger'    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Mock cluster contents.  Three inspectable objects + provenance events.
// ─────────────────────────────────────────────────────────────────────────────
const OBJECTS = {
  'cluster://entity/concept/federated-truth': {
    uri: 'cluster://entity/concept/federated-truth',
    id: 'ent_01HQ7K6Z9R4M3F8X2VWNJP5BTC',
    type: 'entity',
    owner: 'canonical',
    truth: 'source',
    name: 'Federated Truth',
    kind: 'concept',
    createdAt: '2026-05-21T14:08:11Z',
    updatedAt: '2026-05-23T09:42:50Z',
    attributes: {
      definition: 'A coherent surface over specialized truth stores.',
      domain: 'architecture',
      maturity: 'phase-1',
    },
    related: [
      { uri: 'cluster://artifact/source/evidence-md-v1', edge: 'evidence' },
      { uri: 'cluster://index/record/truth-001',         edge: 'indexed-by' },
    ],
    badges: ['source truth', 'command-gated'],
    indexStatus: 'fresh',
    rebuildable: true,
  },
  'cluster://artifact/source/evidence-md-v1': {
    uri: 'cluster://artifact/source/evidence-md-v1',
    id: 'art_01HQ7K6V2Y8Q3P4R5S6T7U8V9W',
    type: 'artifact',
    owner: 'artifact',
    truth: 'source',
    name: 'evidence-md',
    kind: 'markdown',
    filename: 'evidence.md',
    contentHash: 'sha256:a3f1c9…7bd2',
    sizeBytes: 4_128,
    version: 1,
    ingestedAt: '2026-05-21T14:08:09Z',
    related: [
      { uri: 'cluster://entity/concept/federated-truth', edge: 'linked-to' },
      { uri: 'cluster://index/record/truth-001',         edge: 'sourced-by' },
    ],
    badges: ['source truth', 'append-only'],
    indexStatus: 'fresh',
    rebuildable: true,
  },
  'cluster://index/record/truth-001': {
    uri: 'cluster://index/record/truth-001',
    id: 'idx_01HQ7K7A1B2C3D4E5F6G7H8J9K',
    type: 'index_record',
    owner: 'index',
    truth: 'derivative',
    name: 'truth-001',
    sourceStore: 'canonical',
    sourceId: 'ent_01HQ7K6Z9R4M3F8X2VWNJP5BTC',
    text: 'federated truth · phase-1 · cluster surface',
    metadata: { tokens: 7, lang: 'en' },
    indexedAt: '2026-05-23T09:42:51Z',
    related: [
      { uri: 'cluster://entity/concept/federated-truth', edge: 'projects' },
      { uri: 'cluster://artifact/source/evidence-md-v1', edge: 'derived-from' },
    ],
    badges: ['derivative', 'rebuildable'],
    indexStatus: 'fresh',
    rebuildable: true,
  },
};

const EVENTS = [
  { id: 'evt_001', t: '2026-05-21T14:08:09Z', action: 'artifact_ingested',  actor: 'cli-user',  subject: 'cluster://artifact/source/evidence-md-v1',  detail: 'evidence.md · 4,128 bytes · sha256:a3f1c9…' },
  { id: 'evt_002', t: '2026-05-21T14:08:11Z', action: 'entity_created',     actor: 'cli-user',  subject: 'cluster://entity/concept/federated-truth',   detail: 'kind=concept · name="Federated Truth"' },
  { id: 'evt_003', t: '2026-05-22T11:14:32Z', action: 'evidence_linked',    actor: 'cli-user',  subject: 'cluster://entity/concept/federated-truth',   detail: 'artifact:evidence-md-v1 → entity' },
  { id: 'evt_004', t: '2026-05-23T09:40:02Z', action: 'mutation_proposed',  actor: 'agent:claude', subject: 'cluster://entity/concept/federated-truth', detail: 'update_entity · attributes.maturity = "phase-1"' },
  { id: 'evt_005', t: '2026-05-23T09:42:50Z', action: 'mutation_committed', actor: 'cli-user',  subject: 'cluster://entity/concept/federated-truth',   detail: 'cmd_42 · validated · committed by kernel' },
];

const RECEIPTS = [
  { id: 'rcp_a1', commandId: 'cmd_01', verb: 'ingest_artifact', summary: 'ingested evidence.md',                          committedAt: '2026-05-21T14:08:09Z', linkedEvent: 'evt_001' },
  { id: 'rcp_a2', commandId: 'cmd_02', verb: 'create_entity',   summary: 'created concept/federated-truth',                committedAt: '2026-05-21T14:08:11Z', linkedEvent: 'evt_002' },
  { id: 'rcp_a3', commandId: 'cmd_03', verb: 'link_evidence',   summary: 'linked evidence-md-v1 → federated-truth',        committedAt: '2026-05-22T11:14:32Z', linkedEvent: 'evt_003' },
  { id: 'rcp_a4', commandId: 'cmd_42', verb: 'update_entity',   summary: 'set attributes.maturity = "phase-1"',            committedAt: '2026-05-23T09:42:50Z', linkedEvent: 'evt_005' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Small primitives
// ─────────────────────────────────────────────────────────────────────────────

const STORE_DOT = {
  canonical: 'bg-canonical',
  artifact:  'bg-artifact',
  index:     'bg-index',
  ledger:    'bg-ledger',
};
const STORE_TEXT = {
  canonical: 'text-canonical',
  artifact:  'text-artifact',
  index:     'text-index',
  ledger:    'text-ledger',
};
const STORE_BG_SOFT = {
  canonical: 'bg-canonical-soft border-canonical-line',
  artifact:  'bg-artifact-soft border-artifact-line',
  index:     'bg-index-soft border-index-line',
  ledger:    'bg-ledger-soft border-ledger-line',
};
const STORE_STROKE = {
  canonical: '#e8b54a',
  artifact:  '#5ec2e6',
  index:     '#b08cf5',
  ledger:    '#7fcf9f',
};

function Badge({ kind = 'neutral', children, title }) {
  const map = {
    'source truth':  'bg-canonical-soft text-canonical border-canonical-line',
    'derivative':    'bg-index-soft text-index border-index-line',
    'append-only':   'bg-ledger-soft text-ledger border-ledger-line',
    'command-gated': 'bg-ink-850 text-ink-200 border-ink-700',
    'rebuildable':   'bg-ink-850 text-ink-300 border-ink-700',
    'neutral':       'bg-ink-850 text-ink-300 border-ink-700',
    'warn':          'bg-warn-soft text-warn border-warn-line',
    'danger':        'bg-danger-soft text-danger border-danger-line',
    'ok':            'bg-ok-soft text-ok border-ok-line',
  };
  const cls = map[kind] || map.neutral;
  return (
    <span
      title={title}
      className={`mono inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.06em] leading-none px-1.5 py-1 rounded-[3px] border ${cls}`}
    >
      {children}
    </span>
  );
}

function StoreBadge({ store }) {
  return (
    <span className={`mono inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] leading-none px-2 py-1 rounded-[3px] border ${STORE_BG_SOFT[store]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${STORE_DOT[store]}`}></span>
      <span className={STORE_TEXT[store]}>{store}</span>
      <span className="text-ink-500">store</span>
    </span>
  );
}

function FreshnessPill({ status }) {
  if (status === 'fresh')   return <Badge kind="ok"><span className="w-1.5 h-1.5 rounded-full bg-ok inline-block animate-pulse"></span>index · fresh</Badge>;
  if (status === 'stale')   return <Badge kind="warn"><span className="w-1.5 h-1.5 rounded-full bg-warn inline-block"></span>index · stale</Badge>;
  if (status === 'missing') return <Badge kind="danger"><span className="w-1.5 h-1.5 rounded-full bg-danger inline-block"></span>index · missing</Badge>;
  return <Badge kind="neutral">index · {status}</Badge>;
}

function KV({ k, v, mono = true, accent }) {
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-ink-850/80 last:border-b-0">
      <div className="mono text-[10.5px] uppercase tracking-[0.08em] text-ink-500 w-[88px] shrink-0 pt-0.5">{k}</div>
      <div className={`text-[12.5px] ${mono ? 'mono' : ''} ${accent || 'text-ink-200'} break-all`}>{v}</div>
    </div>
  );
}

function SectionHead({ children, hint, right }) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="mono text-[10.5px] uppercase tracking-[0.16em] text-ink-400">{children}</h3>
        {hint && <span className="text-[11px] text-ink-500">{hint}</span>}
      </div>
      {right}
    </div>
  );
}

function Panel({ children, className = '' }) {
  return (
    <div className={`bg-ink-900 border border-ink-800 rounded-md shadow-inset-hair ${className}`}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-store map — the heart of the visualization.
//
// Four horizontal swim lanes (canonical / artifact / index / ledger).
// The focal object sits as a filled node in its owner lane.
// Related objects appear as outlined nodes in their lanes,
// connected by curved lines.
// Ledger events tick across the ledger lane chronologically.
// ─────────────────────────────────────────────────────────────────────────────

function StoreLanesMap({ focal, onPick, sourceOnly }) {
  // SURFACE-B-005 (Wave B1-Amend): defensively guard `focal.related ?? []`
  // so a focal object without a `related` array renders the map without
  // the related-edges entries instead of throwing.
  const plotted = [
    { uri: focal.uri, owner: focal.owner, label: shortLabel(focal), focal: true, truth: focal.truth },
    ...(focal.related ?? []).map((r) => {
      const o = OBJECTS[r.uri];
      return { uri: r.uri, owner: o?.owner, label: shortLabel(o ?? { uri: r.uri }), edge: r.edge, focal: false, truth: o?.truth };
    }),
  ];
  // assign x positions per store lane based on appearance order
  const byStore = {};
  for (const s of STORES) byStore[s.id] = [];
  plotted.forEach((p) => byStore[p.owner].push(p));

  const width = 720;
  const height = 240;
  const laneH = height / STORES.length;
  // Compute x for each plotted node — distribute within available area (leave room for lane label)
  const xStart = 130;
  const xEnd = width - 30;

  const positions = {};
  plotted.forEach((p, i) => {
    // distribute across full plot width regardless of lane, to encourage diagonals between lanes
    const t = plotted.length === 1 ? 0.5 : i / (plotted.length - 1);
    const x = xStart + (xEnd - xStart) * t;
    const laneIdx = STORES.findIndex((s) => s.id === p.owner);
    const y = laneIdx * laneH + laneH / 2;
    positions[p.uri] = { x, y, ...p };
  });

  // Render ledger lane events as small ticks
  const ledgerLaneIdx = STORES.findIndex((s) => s.id === 'ledger');
  const ledgerY = ledgerLaneIdx * laneH + laneH / 2;
  const eventsToShow = EVENTS;
  const eventXs = eventsToShow.map((_, i) => xStart + (xEnd - xStart) * (i / (eventsToShow.length - 1)));

  // For the focal node, also draw a vertical drop line to ledger to express
  // "every change to this object lives in the ledger".
  const focalPos = positions[focal.uri];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} className="block">
        {/* lane backgrounds + labels */}
        {STORES.map((s, i) => {
          const y = i * laneH;
          const hideLane = sourceOnly && s.id === 'index';
          return (
            <g key={s.id} opacity={hideLane ? 0.25 : 1}>
              <rect x="0" y={y + 4} width={width} height={laneH - 8}
                    fill="#0d0f13" stroke="#1a1d24" strokeDasharray="2 4" />
              {/* lane label block */}
              <rect x="0" y={y + 4} width="112" height={laneH - 8} fill="#0b0d10" stroke="#1a1d24" />
              <circle cx="14" cy={y + laneH / 2} r="3" fill={STORE_STROKE[s.id]} />
              <text x="26" y={y + laneH / 2 - 5} fontFamily="JetBrains Mono" fontSize="10.5"
                    fontWeight="600" fill={STORE_STROKE[s.id]} style={{ letterSpacing: '0.06em' }}>
                {s.label.toUpperCase()}
              </text>
              <text x="26" y={y + laneH / 2 + 9} fontFamily="JetBrains Mono" fontSize="9.5"
                    fill="#6b7282">{s.kind}</text>
              {/* dashed connector tail at right edge to suggest the lane continues */}
              <line x1={width - 12} y1={y + laneH / 2} x2={width} y2={y + laneH / 2}
                    stroke="#262b34" strokeDasharray="2 3" />
            </g>
          );
        })}

        {/* connecting edges: focal → each related */}
        {plotted.filter((p) => !p.focal && !(sourceOnly && p.owner === 'index')).map((p) => {
          const a = positions[focal.uri];
          const b = positions[p.uri];
          // a curved path: control point pulled toward the midpoint vertically
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dy = b.y - a.y;
          const cx1 = mx;
          const cy1 = a.y + dy * 0.4;
          const cx2 = mx;
          const cy2 = a.y + dy * 0.6;
          const stroke = STORE_STROKE[p.owner];
          return (
            <g key={p.uri}>
              <path
                d={`M ${a.x} ${a.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${b.x} ${b.y}`}
                fill="none" stroke={stroke} strokeOpacity="0.55" strokeWidth="1.25"
              />
              {/* edge label */}
              <text x={mx} y={my - 4} fontFamily="JetBrains Mono" fontSize="9.5"
                    textAnchor="middle" fill="#8a91a1">{p.edge}</text>
            </g>
          );
        })}

        {/* ledger event ticks */}
        {eventsToShow.map((e, i) => (
          <g key={e.id}>
            <line x1={eventXs[i]} y1={ledgerY - 6} x2={eventXs[i]} y2={ledgerY + 6}
                  stroke="#7fcf9f" strokeOpacity={e.subject === focal.uri ? 1 : 0.45}
                  strokeWidth={e.subject === focal.uri ? 1.6 : 1} />
            <circle cx={eventXs[i]} cy={ledgerY} r={e.subject === focal.uri ? 2.6 : 1.6}
                    fill="#7fcf9f" fillOpacity={e.subject === focal.uri ? 1 : 0.55} />
          </g>
        ))}

        {/* drop line from focal to its ledger trail */}
        {focalPos && focal.owner !== 'ledger' && (
          <line x1={focalPos.x} y1={focalPos.y} x2={focalPos.x} y2={ledgerY}
                stroke="#7fcf9f" strokeOpacity="0.35" strokeDasharray="2 3" />
        )}

        {/* nodes */}
        {plotted.map((p) => {
          if (sourceOnly && p.owner === 'index') return null;
          const pos = positions[p.uri];
          const stroke = STORE_STROKE[p.owner];
          return (
            <g key={p.uri} style={{ cursor: p.focal ? 'default' : 'pointer' }}
               onClick={() => !p.focal && onPick(p.uri)}>
              {/* outer glow ring for focal */}
              {p.focal && (
                <circle cx={pos.x} cy={pos.y} r="12" fill="none" stroke={stroke} strokeOpacity="0.25" strokeWidth="3" />
              )}
              <circle cx={pos.x} cy={pos.y} r={p.focal ? 6.5 : 5}
                      fill={p.focal ? stroke : '#0f1115'}
                      stroke={stroke} strokeWidth={p.focal ? 1.5 : 1.5} />
              {/* truth glyph: filled = source, hollow square = derivative */}
              {p.truth === 'derivative' && !p.focal && (
                <rect x={pos.x - 2} y={pos.y - 2} width="4" height="4" fill={stroke} fillOpacity="0.35" />
              )}
              <text x={pos.x} y={pos.y - 14} fontFamily="JetBrains Mono" fontSize="10.5"
                    textAnchor="middle" fill={p.focal ? '#e2e5ec' : '#a8aebc'} fontWeight={p.focal ? 600 : 400}>
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
      {/* legend */}
      <div className="absolute right-3 top-2 mono text-[10px] text-ink-500 flex items-center gap-3">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-canonical"></span>source</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 border border-index inline-block" style={{background:'#0f1115'}}></span>derivative</span>
        <span className="flex items-center gap-1.5"><span className="w-px h-2 bg-ledger"></span>event</span>
      </div>
    </div>
  );
}

function shortLabel(o) {
  // produce a compact display label for the lane map
  if (o.type === 'entity')       return `${o.kind}/${o.name.toLowerCase().replace(/\s+/g, '-')}`;
  if (o.type === 'artifact')     return `${o.filename}@v${o.version}`;
  if (o.type === 'index_record') return o.name;
  return o.uri.split('/').pop();
}

// ─────────────────────────────────────────────────────────────────────────────
// Right column: provenance timeline + receipts
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_GLYPH = {
  artifact_ingested:   '⊕',
  entity_created:      '◇',
  evidence_linked:     '⇌',
  mutation_proposed:   '⇢',
  mutation_committed:  '✓',
};

function ProvenanceTimeline({ focal, expanded, onToggle, receipts }) {
  const events = EVENTS;
  return (
    <div className="space-y-2">
      {events.map((e, i) => {
        const onFocal = e.subject === focal.uri;
        const receipt = receipts.find((r) => r.linkedEvent === e.id);
        const isProposed = e.action === 'mutation_proposed';
        return (
          <div key={e.id}
               className={`relative pl-7 pr-2 py-2 rounded ${onFocal ? 'bg-ink-875' : 'hover:bg-ink-875/60'} border border-transparent ${onFocal ? 'border-ink-800' : ''}`}>
            {/* spine */}
            {i < events.length - 1 && (
              <span className="absolute left-[10px] top-7 bottom-[-8px] w-px bg-ink-800"></span>
            )}
            {/* node */}
            <span className={`absolute left-[5px] top-[10px] w-[11px] h-[11px] rounded-full border ${onFocal ? 'bg-ledger border-ledger' : isProposed ? 'bg-ink-900 border-warn' : 'bg-ink-900 border-ink-650'}`}>
              <span className="absolute inset-1 rounded-full bg-ink-925"></span>
            </span>
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`mono text-[10.5px] ${onFocal ? 'text-ledger' : 'text-ink-300'}`}>
                <span className="opacity-60 mr-1">{ACTION_GLYPH[e.action] || '·'}</span>{e.action}
              </span>
              {isProposed && <Badge kind="warn">proposed</Badge>}
              {e.action === 'mutation_committed' && <Badge kind="ok">committed</Badge>}
            </div>
            <div className="mono text-[10.5px] text-ink-500">
              {fmtTime(e.t)} · <span className="text-ink-400">{e.actor}</span>
            </div>
            {(expanded || onFocal) && (
              <div className="mt-1.5 mono text-[11px] text-ink-300 leading-snug">{e.detail}</div>
            )}
            {receipt && (expanded || onFocal) && (
              <div className="mt-1.5 flex items-center gap-2 mono text-[10.5px]">
                <span className="text-ok">receipt</span>
                <span className="text-ink-400">{receipt.id}</span>
                <span className="text-ink-500">·</span>
                <span className="text-ink-400">{receipt.verb}</span>
              </div>
            )}
          </div>
        );
      })}
      <button onClick={onToggle}
              className="w-full mt-2 py-1.5 mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400 hover:text-ink-100 border border-ink-800 rounded hover:border-ink-700 transition">
        {expanded ? 'collapse trace' : 'expand full trace'}
      </button>
    </div>
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action drawer panels (Explain Index / Propose Mutation)
// ─────────────────────────────────────────────────────────────────────────────

function ExplainIndexPanel({ focal, onClose }) {
  // SURFACE-B-005 (Wave B1-Amend): guard `focal.related ?? []` so an
  // object that has no `related` array still resolves an idxRel (null)
  // instead of crashing in `.find`.
  const idxRel = (focal.related ?? []).find((r) => OBJECTS[r.uri]?.owner === 'index');
  const idx = idxRel ? OBJECTS[idxRel.uri] : focal.owner === 'index' ? focal : null;
  return (
    <div className="border border-index-line/60 bg-index-soft/40 rounded-md">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-index-line/50">
        <div className="flex items-center gap-2">
          <span className="mono text-[10.5px] uppercase tracking-[0.12em] text-index">explain index record</span>
          <Badge kind="derivative">derivative</Badge>
          <Badge kind="rebuildable">rebuildable</Badge>
        </div>
        <button onClick={onClose} className="mono text-[10.5px] text-ink-500 hover:text-ink-200">close ×</button>
      </div>
      {idx ? (
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-1">
          <div>
            <KV k="record"  v={idx.uri} accent="text-index" />
            <KV k="derived from" v={`${idx.sourceStore || OBJECTS[focal.uri].owner}/${idx.sourceId || focal.id}`} />
            <KV k="text"    v={`"${idx.text || shortLabel(focal)}"`} />
            <KV k="indexed" v={fmtTime(idx.indexedAt || focal.updatedAt || focal.ingestedAt)} />
          </div>
          <div className="text-[12.5px] text-ink-300 leading-relaxed">
            <p className="mb-2">
              This record exists <span className="text-index mono">because</span> an owned object was ingested into{' '}
              <span className="mono text-canonical">canonical</span> /{' '}
              <span className="mono text-artifact">artifact</span> and the kernel projected a
              discoverability entry into the <span className="mono text-index">index</span> store.
            </p>
            <p className="text-ink-400">
              The index is <span className="text-ink-100">never source truth</span>. Deleting it does not lose data — it can be rebuilt from the owner stores by running <span className="mono text-ink-200">db-cluster reindex</span>.
            </p>
          </div>
        </div>
      ) : (
        <div className="p-4 mono text-[12px] text-ink-400">No index record projects this object.</div>
      )}
    </div>
  );
}

function ProposeMutationPanel({ focal, onClose }) {
  const [verb, setVerb] = React.useState('update_entity');
  const [field, setField] = React.useState('attributes.maturity');
  const [value, setValue] = React.useState('"phase-2"');
  const verbs = ['update_entity', 'link_evidence', 'reindex', 'propose_mutation'];

  const cmdJson = JSON.stringify({
    verb,
    targetStore: focal.owner,
    subject: focal.id,
    payload: tryPayload(verb, field, value),
    proposedBy: 'agent:claude',
    proposedAt: new Date().toISOString().replace(/\.\d{3}/, ''),
    status: 'proposed',
  }, null, 2);

  return (
    <div className="border border-warn-line/60 bg-warn-soft/30 rounded-md">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-warn-line/50">
        <div className="flex items-center gap-2">
          <span className="mono text-[10.5px] uppercase tracking-[0.12em] text-warn">propose mutation</span>
          <Badge kind="command-gated">command-gated</Badge>
          <span className="mono text-[10.5px] text-ink-500">preview only · no write</span>
        </div>
        <button onClick={onClose} className="mono text-[10.5px] text-ink-500 hover:text-ink-200">close ×</button>
      </div>
      <div className="grid grid-cols-[260px,1fr]">
        <div className="p-4 border-r border-ink-800 space-y-3">
          <div>
            <label className="mono text-[10px] uppercase tracking-[0.1em] text-ink-500 block mb-1">verb</label>
            <select value={verb} onChange={(e) => setVerb(e.target.value)}
                    className="w-full bg-ink-900 border border-ink-800 rounded px-2 py-1.5 mono text-[12px] text-ink-100 focus:outline-none focus:border-warn">
              {verbs.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="mono text-[10px] uppercase tracking-[0.1em] text-ink-500 block mb-1">target field</label>
            <input value={field} onChange={(e) => setField(e.target.value)}
                   className="w-full bg-ink-900 border border-ink-800 rounded px-2 py-1.5 mono text-[12px] text-ink-100 focus:outline-none focus:border-warn" />
          </div>
          <div>
            <label className="mono text-[10px] uppercase tracking-[0.1em] text-ink-500 block mb-1">new value (JSON)</label>
            <input value={value} onChange={(e) => setValue(e.target.value)}
                   className="w-full bg-ink-900 border border-ink-800 rounded px-2 py-1.5 mono text-[12px] text-ink-100 focus:outline-none focus:border-warn" />
          </div>
          <div className="pt-2 border-t border-ink-800">
            <div className="mono text-[10px] uppercase tracking-[0.1em] text-ink-500 mb-1.5">flow</div>
            <ol className="mono text-[11px] text-ink-400 space-y-1">
              <li><span className="text-warn">1.</span> AI proposes typed command</li>
              <li><span className="text-warn">2.</span> kernel validates against rules</li>
              <li><span className="text-warn">3.</span> operator commits</li>
              <li><span className="text-warn">4.</span> receipt + provenance written</li>
            </ol>
          </div>
        </div>
        <div className="p-4 bg-ink-925/70">
          <div className="flex items-center justify-between mb-2">
            <span className="mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">command preview</span>
            <span className="mono text-[10.5px] text-ink-500">/.db-cluster/queue/proposed</span>
          </div>
          <pre className="mono text-[11.5px] leading-relaxed text-ink-200 bg-ink-900 border border-ink-800 rounded p-3 overflow-auto">{cmdJson}</pre>
          <div className="flex items-center gap-2 mt-3">
            <button disabled
              className="mono text-[11px] px-3 py-1.5 rounded border border-warn-line text-warn bg-warn-soft/60 cursor-not-allowed">
              stage for commit
            </button>
            <span className="mono text-[10.5px] text-ink-500">
              commit happens via <span className="text-ink-300">db-cluster commit &lt;cmd-id&gt;</span> — the AI cannot perform this step.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
function tryPayload(verb, field, value) {
  try {
    return { field, value: JSON.parse(value) };
  } catch {
    return { field, value };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action bar
// ─────────────────────────────────────────────────────────────────────────────

function ActionButton({ icon, label, hint, onClick, tone = 'neutral', active }) {
  const tones = {
    neutral: 'border-ink-800 text-ink-200 hover:border-ink-650 hover:bg-ink-850',
    index:   'border-index-line/60 text-index hover:bg-index-soft/40',
    warn:    'border-warn-line/60 text-warn hover:bg-warn-soft/40',
    ledger:  'border-ledger-line/60 text-ledger hover:bg-ledger-soft/40',
  };
  const activeRing = active ? 'ring-1 ring-inset ring-ink-650' : '';
  return (
    <button onClick={onClick}
            className={`group flex items-start gap-2 text-left px-3 py-2.5 rounded border bg-ink-900 ${tones[tone]} ${activeRing} transition`}>
      <span className="mono text-[14px] leading-none pt-0.5">{icon}</span>
      <span>
        <span className="block mono text-[12px] leading-none">{label}</span>
        <span className="block text-[10.5px] text-ink-500 mt-1 leading-tight">{hint}</span>
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

function ClusterTruthInspector() {
  const [uri, setUri] = React.useState('cluster://entity/concept/federated-truth');
  const [sourceOnly, setSourceOnly] = React.useState(false);
  const [openDrawer, setOpenDrawer] = React.useState(null); // null | 'explain' | 'propose'
  const [traceExpanded, setTraceExpanded] = React.useState(false);
  const [hoverEdge, setHoverEdge] = React.useState(null);

  const focal = OBJECTS[uri];
  // SURFACE-B-005 (Wave B1-Amend): pre-fix the inspector crashed with
  // TypeError when given a URI not in OBJECTS (which happens when an
  // external snapshot is loaded and a relationship URI points to an
  // object not in the snapshot). The fallback render is non-throwing
  // and surfaces the unknown URI to the operator.
  if (!focal) {
    return (
      <div className="p-6 mono text-danger border border-danger-line bg-danger-soft/40 rounded-md">
        Object not found: <code className="text-ink-100">{uri}</code>
      </div>
    );
  }
  const ownerStore = STORES.find((s) => s.id === focal.owner);
  const focalEvents = EVENTS.filter((e) => e.subject === focal.uri);
  const focalReceipts = RECEIPTS.filter((r) =>
    focalEvents.some((e) => r.linkedEvent === e.id)
  );

  // Visible badges depend on object truth + freshness
  return (
    <div className="substrate-bg border border-ink-800 rounded-lg overflow-hidden shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_30px_-12px_rgba(0,0,0,0.6)]">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="bg-ink-925/95 border-b border-ink-800">
        <div className="px-5 py-3 flex items-center gap-4 flex-wrap">
          {/* URI breadcrumb */}
          <div className="flex items-center gap-1 mono text-[12.5px] flex-1 min-w-[280px]">
            <span className="text-ink-500">cluster://</span>
            {focal.uri.replace('cluster://', '').split('/').map((seg, i, arr) => (
              <React.Fragment key={i}>
                <span className={i === arr.length - 1 ? 'text-ink-100' : 'text-ink-300'}>{seg}</span>
                {i < arr.length - 1 && <span className="text-ink-600">/</span>}
              </React.Fragment>
            ))}
            <button
              className="ml-2 mono text-[10.5px] text-ink-500 hover:text-ink-200 px-1.5 py-0.5 border border-ink-800 rounded"
              onClick={() => navigator.clipboard?.writeText(focal.uri)}
              title="copy stable cluster URI"
            >copy uri</button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Badge kind="neutral"><span className="text-ink-500 mr-1">type</span><span className="text-ink-100">{focal.type}</span></Badge>
            <StoreBadge store={focal.owner} />
            {focal.badges?.map((b) => <Badge key={b} kind={b}>{b}</Badge>)}
            <FreshnessPill status={focal.indexStatus} />
            {focal.rebuildable && <Badge kind="neutral" title="this object's index record can be deleted and rebuilt from owner stores">rebuildable</Badge>}
          </div>
        </div>

        {/* Doctrine strip — short, present, never preachy */}
        <div className="px-5 py-2 border-t border-ink-850 bg-ink-900/50 flex items-center justify-between gap-4 flex-wrap">
          <div className="mono text-[10.5px] text-ink-500 flex items-center gap-4 flex-wrap">
            <span><span className="text-canonical">●</span> {ownerStore.rule}</span>
            <span className="text-ink-700">│</span>
            <span><span className="text-ledger">●</span> mutations cross a typed command boundary</span>
            <span className="text-ink-700">│</span>
            <span><span className="text-index">●</span> indexes are derivative — never source truth</span>
          </div>
          <label className="flex items-center gap-2 mono text-[11px] text-ink-400 cursor-pointer select-none">
            <span className={`relative inline-block w-7 h-4 rounded-full transition ${sourceOnly ? 'bg-canonical/60' : 'bg-ink-800'}`}>
              <span className={`absolute top-0.5 ${sourceOnly ? 'left-3.5' : 'left-0.5'} w-3 h-3 rounded-full bg-ink-100 transition-all`}></span>
            </span>
            <input type="checkbox" className="hidden" checked={sourceOnly} onChange={(e) => setSourceOnly(e.target.checked)} />
            <span>show source truth only</span>
            <span className="text-ink-600">·</span>
            <span className="text-ink-500">{sourceOnly ? 'hiding index projections' : 'showing derivatives'}</span>
          </label>
        </div>
      </div>

      {/* ── Body: 3 columns ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-[260px,1fr,340px] min-h-[640px]">

        {/* ── Left column: identity ─────────────────────────────────────── */}
        <aside className="border-r border-ink-800 bg-ink-900/40 p-4 space-y-5">
          <div>
            <SectionHead hint="this object">identity</SectionHead>
            <div className="space-y-0">
              <KV k="name" v={focal.name} accent="text-ink-100" mono={false} />
              <KV k="id"   v={focal.id} />
              <KV k="type" v={focal.type} />
              {focal.kind && <KV k="kind" v={focal.kind} />}
              {focal.filename && <KV k="file" v={`${focal.filename} · v${focal.version}`} />}
              {focal.contentHash && <KV k="hash" v={focal.contentHash} />}
              {focal.sizeBytes != null && <KV k="size" v={`${focal.sizeBytes.toLocaleString()} bytes`} />}
            </div>
          </div>

          <div>
            <SectionHead hint="who owns this fact">owner store</SectionHead>
            <div className={`rounded border ${STORE_BG_SOFT[focal.owner]} p-3`}>
              <div className="flex items-center justify-between mb-1.5">
                <span className={`mono text-[12px] ${STORE_TEXT[focal.owner]} font-semibold`}>{focal.owner}</span>
                <span className="mono text-[10px] text-ink-500 uppercase tracking-wider">{ownerStore.kind}</span>
              </div>
              <p className="text-[11.5px] text-ink-300 leading-snug">{ownerStore.rule}.</p>
            </div>
          </div>

          <div>
            <SectionHead hint="this view is">truth status</SectionHead>
            {focal.truth === 'source' ? (
              <div className="flex items-start gap-2 p-3 rounded border border-canonical-line/60 bg-canonical-soft/40">
                <span className="mono text-canonical text-[16px] leading-none">●</span>
                <div className="text-[11.5px] text-ink-200 leading-snug">
                  <div className="mono text-canonical text-[11.5px] mb-0.5">source truth</div>
                  This record is the owned fact. The cluster will resolve queries against it directly.
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 p-3 rounded border border-index-line/60 bg-index-soft/40">
                <span className="mono text-index text-[12px] leading-none">▢</span>
                <div className="text-[11.5px] text-ink-200 leading-snug">
                  <div className="mono text-index text-[11.5px] mb-0.5">derivative projection</div>
                  This record is rebuildable from its owner store. Editing it directly is not a meaningful operation.
                </div>
              </div>
            )}
          </div>

          <div>
            <SectionHead hint="cross-store edges">related</SectionHead>
            <ul className="space-y-1">
              {/* SURFACE-B-005 (Wave B1-Amend): guard related[] with ?? [] */}
              {(focal.related ?? []).map((r) => {
                const o = OBJECTS[r.uri];
                const hidden = sourceOnly && o?.owner === 'index';
                return (
                  <li key={r.uri}>
                    <button
                      onClick={() => !hidden && setUri(r.uri)}
                      onMouseEnter={() => setHoverEdge(r.uri)}
                      onMouseLeave={() => setHoverEdge(null)}
                      disabled={hidden}
                      className={`group w-full text-left flex items-center gap-2 px-2 py-1.5 rounded border transition
                        ${hidden ? 'border-ink-850 opacity-40 cursor-not-allowed'
                                 : hoverEdge === r.uri ? 'border-ink-650 bg-ink-850' : 'border-ink-850 hover:border-ink-700 hover:bg-ink-850/70'}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${STORE_DOT[o.owner]} shrink-0`}></span>
                      <span className="mono text-[10.5px] text-ink-500 w-[68px] shrink-0">{r.edge}</span>
                      <span className={`mono text-[11px] ${STORE_TEXT[o.owner]} truncate`}>{shortLabel(o)}</span>
                      <span className="ml-auto mono text-[10px] text-ink-600 group-hover:text-ink-400">→</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 mono text-[10.5px] text-ink-500">selecting an edge re-inspects that object.</div>
          </div>
        </aside>

        {/* ── Center column ────────────────────────────────────────────── */}
        <section className="p-5 space-y-5 overflow-hidden">

          {/* Object detail header */}
          <div className="flex items-start justify-between">
            <div>
              <div className="mono text-[10.5px] uppercase tracking-[0.16em] text-ink-500 mb-1">{focal.type} · owned by {focal.owner}</div>
              <h2 className="text-[20px] font-semibold text-ink-100 tracking-tight">{focal.name}</h2>
              {focal.attributes?.definition && (
                <p className="text-[13px] text-ink-300 mt-1 max-w-[64ch]">{focal.attributes.definition}</p>
              )}
            </div>
            <div className="text-right mono text-[10.5px] text-ink-500 leading-relaxed">
              <div>created  <span className="text-ink-300">{fmtTime(focal.createdAt || focal.ingestedAt || focal.indexedAt)}</span></div>
              <div>updated  <span className="text-ink-300">{fmtTime(focal.updatedAt || focal.indexedAt || focal.ingestedAt)}</span></div>
            </div>
          </div>

          {/* Cross-store lane map */}
          <Panel className="p-4">
            <SectionHead
              hint={sourceOnly ? 'index lane suppressed' : 'four stores · one substrate'}
              right={
                <div className="mono text-[10.5px] text-ink-500">click any node to re-inspect</div>
              }
            >cross-store map</SectionHead>
            <StoreLanesMap focal={focal} onPick={setUri} sourceOnly={sourceOnly} />
          </Panel>

          {/* Attributes / payload detail */}
          <Panel className="p-4">
            <SectionHead hint={focal.truth === 'source' ? 'owned fact · canonical view' : 'projection · resolves to owner'}>
              record
            </SectionHead>
            <div className="grid grid-cols-2 gap-x-6">
              <div>
                {/* SURFACE-B-005 (Wave B1-Amend): guard focal.attributes ?? {} */}
                {focal.type === 'entity' && Object.entries(focal.attributes ?? {}).map(([k, v]) => (
                  <KV key={k} k={k} v={String(v)} />
                ))}
                {focal.type === 'artifact' && (
                  <>
                    <KV k="filename"     v={focal.filename} />
                    <KV k="mime"         v="text/markdown" />
                    <KV k="version"      v={`v${focal.version}`} />
                    <KV k="content hash" v={focal.contentHash} />
                  </>
                )}
                {focal.type === 'index_record' && (
                  <>
                    <KV k="source store" v={focal.sourceStore} />
                    <KV k="source id"    v={focal.sourceId} />
                    <KV k="text"         v={`"${focal.text}"`} />
                    <KV k="tokens"       v={String(focal.metadata?.tokens)} />
                  </>
                )}
              </div>
              <div>
                <KV k="uri"   v={focal.uri} accent={STORE_TEXT[focal.owner]} />
                <KV k="owner" v={focal.owner} accent={STORE_TEXT[focal.owner]} />
                <KV k="truth" v={focal.truth} accent={focal.truth === 'source' ? 'text-canonical' : 'text-index'} />
                <KV k="index" v={
                  <span className="inline-flex items-center gap-2">
                    <span className="text-ok">●</span><span>{focal.indexStatus}</span>
                    <span className="text-ink-600">·</span>
                    <span className="text-ink-400">{focal.rebuildable ? 'rebuildable' : 'not rebuildable'}</span>
                  </span>
                } />
              </div>
            </div>
            {focal.truth === 'derivative' && (
              <div className="mt-3 flex items-start gap-2 text-[11.5px] text-ink-400 border-t border-ink-850 pt-3">
                <span className="mono text-warn">!</span>
                <p>
                  You are viewing a <span className="text-index">derivative</span> record. The cluster will not treat this as truth.
                  To inspect the owned fact, follow <span className="mono text-ink-200">derived-from</span> or <span className="mono text-ink-200">projects</span>.
                </p>
              </div>
            )}
          </Panel>

          {/* Drawer panels live here */}
          {openDrawer === 'explain' && <ExplainIndexPanel focal={focal} onClose={() => setOpenDrawer(null)} />}
          {openDrawer === 'propose' && <ProposeMutationPanel focal={focal} onClose={() => setOpenDrawer(null)} />}

        </section>

        {/* ── Right column: provenance & receipts ───────────────────────── */}
        <aside className="border-l border-ink-800 bg-ink-900/40 p-4 overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <SectionHead hint="append-only ledger">provenance trace</SectionHead>
          </div>
          <ProvenanceTimeline
            focal={focal}
            expanded={traceExpanded}
            onToggle={() => setTraceExpanded((v) => !v)}
            receipts={RECEIPTS}
          />

          <div className="mt-5">
            <SectionHead hint={`${focalReceipts.length} for this object · ${RECEIPTS.length} cluster-wide`}>receipts</SectionHead>
            <div className="space-y-1.5">
              {RECEIPTS.map((r) => {
                const onFocal = focalReceipts.includes(r);
                return (
                  <div key={r.id}
                       className={`px-2.5 py-2 rounded border ${onFocal ? 'border-ok-line/60 bg-ok-soft/30' : 'border-ink-850 bg-ink-900/50'}`}>
                    <div className="flex items-center gap-2 mono text-[10.5px]">
                      <span className={onFocal ? 'text-ok' : 'text-ink-400'}>{r.id}</span>
                      <span className="text-ink-600">·</span>
                      <span className="text-ink-400">{r.verb}</span>
                    </div>
                    <div className="text-[11.5px] text-ink-300 mt-0.5 leading-snug">{r.summary}</div>
                    <div className="mono text-[10px] text-ink-500 mt-1">{fmtTime(r.committedAt)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      {/* ── Action bar ────────────────────────────────────────────────── */}
      <div className="border-t border-ink-800 bg-ink-925/95 px-5 py-3">
        <div className="flex items-center gap-3 mb-2.5">
          <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-ink-500">safe actions</span>
          <span className="mono text-[10.5px] text-ink-600">— all mutations routed through the kernel</span>
        </div>
        <div className="grid grid-cols-5 gap-2">
          <ActionButton icon="↘" label="resolve" hint="follow URI → owner record"
                        onClick={() => {}} />
          <ActionButton icon="≡" label="trace provenance" hint="expand full event path" tone="ledger"
                        active={traceExpanded}
                        onClick={() => setTraceExpanded((v) => !v)} />
          <ActionButton icon="?" label="explain index" hint="why does the index record exist" tone="index"
                        active={openDrawer === 'explain'}
                        onClick={() => setOpenDrawer((d) => d === 'explain' ? null : 'explain')} />
          <ActionButton icon="↻" label="rebuild index" hint="delete & re-derive from owner stores"
                        onClick={() => {}} />
          <ActionButton icon="⇢" label="propose mutation" hint="typed command · AI may propose · operator commits"
                        tone="warn"
                        active={openDrawer === 'propose'}
                        onClick={() => setOpenDrawer((d) => d === 'propose' ? null : 'propose')} />
        </div>
        <div className="mt-2.5 mono text-[10.5px] text-ink-500">
          <span className="text-ink-400">db-cluster</span> inspect <span className="text-ink-300">{focal.id}</span>
          <span className="text-ink-700"> · </span>
          <span className="text-ink-400">db-cluster</span> trace <span className="text-ink-300">{focal.id}</span>
        </div>
      </div>
    </div>
  );
}

// expose to global so the demo bootstrap script can find it
window.ClusterTruthInspector = ClusterTruthInspector;
