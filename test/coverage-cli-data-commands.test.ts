/**
 * Coverage — CLI data commands (src/cli.ts).
 *
 * Drives the built `dist/cli.js` as a child process against a real cluster in
 * a temp directory and asserts on exit code, stdout/stderr and the store
 * state the command leaves behind: ingest, entity, link, find, inspect,
 * resolve, retrieve, explain-retrieval, trace / why / lineage / trace-bundle,
 * the command lifecycle (propose / validate / approve / reject / commit /
 * compensate / inspect-command), receipts, versions, list-commands and the
 * `index` subcommands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_JS = join(import.meta.dirname, '..', 'dist', 'cli.js');

interface Out { status: number | null; stdout: string; stderr: string }

function cli(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Out {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    delete env.DB_CLUSTER_CANONICAL_BACKEND;
    delete env.DB_CLUSTER_POSTGRES_URL;
    delete env.DB_CLUSTER_DIR;
    delete env.DB_CLUSTER_OPERATOR;
    delete env.NO_COLOR;
    for (const [k, v] of Object.entries(extraEnv)) {
        if (v === undefined) delete env[k]; else env[k] = v;
    }
    const r = spawnSync(process.execPath, [CLI_JS, ...args], { cwd, env, encoding: 'utf-8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ok(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Out {
    const r = cli(cwd, args, extraEnv);
    expect(r.status, `${args.join(' ')}\n${r.stderr}`).toBe(0);
    return r;
}

function grab(out: string, re: RegExp): string {
    const m = re.exec(out);
    expect(m, `pattern ${re} not found in:\n${out}`).not.toBeNull();
    return m![1]!;
}

function proposeJson(cwd: string, actor: string, command: unknown): string {
    const r = ok(cwd, ['--actor', actor, 'propose', JSON.stringify(command)]);
    return grab(r.stdout, /Proposed command: (\S+)/);
}

describe('CLI data commands', { timeout: 60_000 }, () => {
    let dir: string;
    let artifactId: string;
    let artifactIndexId: string;
    let artifactReceiptId: string;
    let entityId: string;
    let entityReceiptId: string;
    let linkProvenanceId: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-cli-data-'));
        ok(dir, ['init']);
        writeFileSync(join(dir, 'evidence.md'), '# Evidence\n\nfederated truth stores');
        const ing = ok(dir, ['--actor', 'alice', 'ingest', 'evidence.md']);
        artifactId = grab(ing.stdout, /artifact:\s+(\S+)/);
        artifactIndexId = grab(ing.stdout, /indexed:\s+(\S+)/);
        artifactReceiptId = grab(ing.stdout, /receipt:\s+(\S+)/);
        const ent = ok(dir, ['--actor', 'alice', 'entity', 'create', '--kind', 'concept', '--name', 'Federated Truth', '--attr', '{"confidence":"high"}']);
        entityId = grab(ent.stdout, /id:\s+(\S+)/);
        entityReceiptId = grab(ent.stdout, /receipt:\s+(\S+)/);
        const link = ok(dir, ['--actor', 'alice', 'link', '--artifact', artifactId, '--entity', entityId]);
        linkProvenanceId = grab(link.stdout, /provenance:\s+(\S+)/);
    });

    afterAll(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    describe('ingest', () => {
        it('reports the artifact, hash prefix and index/receipt ids, and stores the content', () => {
            const f = join(dir, 'notes.txt');
            writeFileSync(f, 'plain notes');
            const r = ok(dir, ['ingest', 'notes.txt']);
            expect(r.stdout).toContain('Ingested: notes.txt');
            expect(r.stdout).toMatch(/version:\s+1/);
            expect(r.stdout).toMatch(/hash:\s+[0-9a-f]{12}\.\.\./);
            const id = grab(r.stdout, /artifact:\s+(\S+)/);
            const resolved = ok(dir, ['resolve', `cluster://artifact/${id}`]);
            expect(resolved.stdout).toContain('"filename": "notes.txt"');
            expect(resolved.stdout).toContain('"sizeBytes": 11');
        });

        it.each([
            ['doc.md', 'text/markdown'],
            ['doc.txt', 'text/plain'],
            ['doc.json', 'application/json'],
            ['doc.pdf', 'application/pdf'],
            ['doc.html', 'text/html'],
            ['doc.ts', 'text/javascript'],
            ['doc.js', 'text/javascript'],
            ['doc.bin', 'application/octet-stream'],
        ])('guesses the mime type of %s as %s', (name, mime) => {
            writeFileSync(join(dir, name), `content of ${name}`);
            const r = ok(dir, ['ingest', name]);
            const id = grab(r.stdout, /artifact:\s+(\S+)/);
            const resolved = ok(dir, ['resolve', `cluster://artifact/${id}`]);
            expect(resolved.stdout).toContain(`"mimeType": "${mime}"`);
        });

        it('uses only the last path segment as the stored filename', () => {
            writeFileSync(join(dir, 'nested.md'), 'nested');
            const r = ok(dir, ['ingest', './nested.md']);
            expect(r.stdout).toContain('Ingested: nested.md');
        });

        it('exits 1 with a File not found message for a missing file', () => {
            const r = cli(dir, ['ingest', 'does-not-exist.md']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('File not found:');
            expect(r.stderr).toContain('does-not-exist.md');
        });
    });

    describe('entity create', () => {
        it('prints the new entity ids and stores the attributes', () => {
            const r = ok(dir, ['entity', 'create', '--kind', 'claim', '--name', 'Claim One', '--attr', '{"a":1}']);
            expect(r.stdout).toContain('Created entity: claim/Claim One');
            const id = grab(r.stdout, /id:\s+(\S+)/);
            expect(r.stdout).toMatch(/indexed:\s+\S+/);
            expect(r.stdout).toMatch(/receipt:\s+\S+/);
            const inspected = ok(dir, ['inspect', id]);
            expect(inspected.stdout).toContain('attributes: {"a":1}');
        });

        it('defaults --attr to an empty object', () => {
            const r = ok(dir, ['entity', 'create', '--kind', 'claim', '--name', 'No Attrs']);
            const id = grab(r.stdout, /id:\s+(\S+)/);
            expect(ok(dir, ['inspect', id]).stdout).toContain('attributes: {}');
        });

        it('rejects invalid --attr JSON with a positioned caret and a shape hint (exit 1)', () => {
            const r = cli(dir, ['entity', 'create', '--kind', 'k', '--name', 'n', '--attr', '{"a":}']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Invalid JSON for --attr:');
            expect(r.stderr).toContain('Input near position');
            expect(r.stderr).toContain('^');
            expect(r.stderr).toContain('Expected shape for --attr: {"key":"value"}');
            expect(r.stderr).toContain('jq .');
        });

        it('rejects a blank name with COMMAND_VALIDATION_FAILED (exit 65) and writes no entity', () => {
            const before = JSON.parse(ok(dir, ['stats', '--json']).stdout).entities as number;
            const r = cli(dir, ['entity', 'create', '--kind', 'note', '--name', '']);
            expect(r.status).toBe(65);
            expect(r.stderr.length).toBeGreaterThan(0);
            const after = JSON.parse(ok(dir, ['stats', '--json']).stdout).entities as number;
            expect(after).toBe(before);
        });

        it('emits a structured error object on stdout under --json (CLI-008)', () => {
            const r = cli(dir, ['rebuild', 'index', '--json', '--yes'], { DB_CLUSTER_CANONICAL_BACKEND: 'mysql' });
            expect(r.status).toBe(78);
            const body = JSON.parse(r.stdout.trim().split('\n').pop()!);
            expect(body.error.code).toBe('INVALID_BACKEND_CONFIG');
            expect(typeof body.error.message).toBe('string');
            expect(body.error.hint).toContain('DB_CLUSTER_CANONICAL_BACKEND');
        });

        it('requires --kind and --name', () => {
            const r = cli(dir, ['entity', 'create', '--kind', 'k']);
            expect(r.status).not.toBe(0);
            expect(r.stderr).toContain("required option '--name <name>'");
        });
    });

    describe('link', () => {
        it('records provenance and a receipt', () => {
            const l = ok(dir, ['link', '--artifact', artifactId, '--entity', entityId]);
            expect(l.stdout).toContain(`Linked: artifact ${artifactId} → entity ${entityId}`);
            expect(l.stdout).toMatch(/provenance:\s+\S+/);
            expect(l.stdout).toMatch(/receipt:\s+\S+/);
        });

        it('exits 1 with NOT_FOUND guidance for an unknown artifact', () => {
            const r = cli(dir, ['link', '--artifact', 'no-such-artifact', '--entity', entityId]);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('no-such-artifact');
            expect(r.stderr).toContain('→ try:');
        });
    });

    describe('find / inspect', () => {
        it('lists matching index records with resolved entities and artifacts', () => {
            const r = ok(dir, ['find', 'federated']);
            expect(r.stdout).toMatch(/Found \d+ index record\(s\) for "federated":/);
            expect(r.stdout).toContain('Resolved entities:');
            expect(r.stdout).toContain(`concept/Federated Truth (${entityId})`);
        });

        it('lists resolved artifacts when the query matches an artifact', () => {
            const r = ok(dir, ['find', 'evidence']);
            expect(r.stdout).toContain('Resolved artifacts:');
            expect(r.stdout).toContain(`evidence.md v1 (${artifactId})`);
        });

        it('honours --limit and --offset', () => {
            const all = ok(dir, ['find', 'federated', '--limit', '50']);
            const total = Number(grab(all.stdout, /Found (\d+) index record/));
            expect(total).toBeGreaterThanOrEqual(1);
            const limited = ok(dir, ['find', 'federated', '--limit', '1']);
            expect(grab(limited.stdout, /Found (\d+) index record/)).toBe('1');
            const skipped = ok(dir, ['find', 'federated', '--limit', '50', '--offset', String(total)]);
            expect(grab(skipped.stdout, /Found (\d+) index record/)).toBe('0');
        });

        it('reports zero hits for an unmatched query without resolved sections', () => {
            const r = ok(dir, ['find', 'zzzzqqqq-nothing']);
            expect(r.stdout).toContain('Found 0 index record(s)');
            expect(r.stdout).not.toContain('Resolved entities:');
            expect(r.stdout).not.toContain('Resolved artifacts:');
        });

        it('inspect prints owner truth for an entity', () => {
            const r = ok(dir, ['inspect', entityId]);
            expect(r.stdout).toContain('Entity: concept/Federated Truth');
            expect(r.stdout).toContain(`id:         ${entityId}`);
            expect(r.stdout).toContain('owner:      canonical');
            expect(r.stdout).toContain('attributes: {"confidence":"high"}');
        });

        it('inspect of an unknown id exits 1 with a NOT_FOUND hint', () => {
            const r = cli(dir, ['inspect', 'bogus-id']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('bogus-id');
            expect(r.stderr).toContain('→ try:');
        });
    });

    describe('resolve', () => {
        it('resolves a canonical URI to sanitized owner truth', () => {
            const r = ok(dir, ['resolve', `cluster://canonical/${entityId}`]);
            expect(r.stdout).toContain(`Resolved: cluster://canonical/${entityId}`);
            expect(r.stdout).toContain('store: canonical');
            expect(r.stdout).toContain('"name": "Federated Truth"');
            expect(r.stdout).toContain('"_sourceType": "owner-truth"');
        });

        it('resolves an artifact URI without leaking storagePath', () => {
            const r = ok(dir, ['resolve', `cluster://artifact/${artifactId}`]);
            expect(r.stdout).toContain('store: artifact');
            expect(r.stdout).toContain('"filename": "evidence.md"');
            expect(r.stdout).not.toContain('storagePath');
            expect(r.stdout).toContain('_contentPolicy');
        });

        it('resolves a receipt URI', () => {
            const r = ok(dir, ['resolve', `cluster://receipt/${entityReceiptId}`]);
            expect(r.stdout).toContain('store: receipt');
            expect(r.stdout).toContain('"resultSummary": "Created entity: concept/Federated Truth"');
        });

        it('resolves an index URI as a derivative', () => {
            const r = ok(dir, ['resolve', `cluster://index/${artifactIndexId}`]);
            expect(r.stdout).toContain('store: index');
            expect(r.stdout).toContain('"sourceStore": "artifact"');
            expect(r.stdout).toContain('"_sourceType": "derivative"');
        });

        it('resolves a ledger URI', () => {
            const r = ok(dir, ['resolve', `cluster://ledger/${linkProvenanceId}`]);
            expect(r.stdout).toContain('store: ledger');
            expect(r.stdout).toContain('"id": "' + linkProvenanceId + '"');
        });

        it('exits 65 for a malformed URI and 1 for an unknown object', () => {
            const bad = cli(dir, ['resolve', 'not a uri']);
            expect(bad.status).toBe(65);
            expect(bad.stderr).toContain('→ try:');
            const missing = cli(dir, ['resolve', 'cluster://canonical/bogus']);
            expect(missing.status).toBe(1);
            expect(missing.stderr).toContain('bogus');
        });

        it('exits 1 telling the operator to init when there is no cluster', () => {
            const empty = mkdtempSync(join(tmpdir(), 'cov-cli-empty-'));
            try {
                const r = cli(empty, ['resolve', 'cluster://canonical/x']);
                expect(r.status).toBe(1);
                expect(r.stderr).toContain('No cluster found. Run `db-cluster init` first.');
                expect(existsSync(join(empty, '.db-cluster'))).toBe(false);
            } finally {
                try { rmSync(empty, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        });
    });

    describe('retrieve / explain-retrieval', () => {
        it('prints an evidence bundle with resolved entities, confidence and freshness', () => {
            const r = ok(dir, ['retrieve', 'federated']);
            expect(r.stdout).toMatch(/Evidence Bundle: \S+/);
            expect(r.stdout).toContain('query:     "federated"');
            expect(r.stdout).toMatch(/entities:\s+[1-9]/);
            expect(r.stdout).toContain('fresh:     YES');
            expect(r.stdout).toContain('Resolved entities:');
            expect(r.stdout).toContain(`cluster://canonical/${entityId} — concept/Federated Truth`);
            expect(r.stdout).toContain('Confidence boundaries:');
        });

        it('lists resolved artifacts for an artifact hit', () => {
            const r = ok(dir, ['retrieve', 'evidence', '--limit', '5', '--offset', '0']);
            expect(r.stdout).toContain('Resolved artifacts:');
            expect(r.stdout).toContain(`cluster://artifact/${artifactId} — evidence.md v1`);
        });

        it('reports an unverified confidence boundary when nothing matches', () => {
            const r = ok(dir, ['retrieve', 'zzzzqqqq-nothing']);
            expect(r.stdout).toMatch(/entities:\s+0/);
            expect(r.stdout).toMatch(/index:\s+0 candidates/);
            expect(r.stdout).toContain('[unverified] No index records matched the query');
            expect(r.stdout).not.toContain('Resolved entities:');
            expect(r.stdout).not.toContain('Missing context:');
        });

        it('reports stale index records and missing context after the owner entity is removed', () => {
            // A second cluster so the shared one stays intact.
            const d2 = mkdtempSync(join(tmpdir(), 'cov-cli-stale-'));
            try {
                ok(d2, ['init']);
                const e = ok(d2, ['entity', 'create', '--kind', 'note', '--name', 'Ghost']);
                const id = grab(e.stdout, /id:\s+(\S+)/);
                const entitiesFile = join(d2, '.db-cluster', 'canonical', 'entities.json');
                const raw = JSON.parse(readFileSync(entitiesFile, 'utf-8'));
                const rest = Array.isArray(raw) ? raw.filter((x: { id: string }) => x.id !== id) : raw;
                writeFileSync(entitiesFile, JSON.stringify(rest));
                const stale = ok(d2, ['index', 'stale']);
                expect(stale.stdout).toMatch(/Stale records \(\d+\):/);
                expect(stale.stdout).toContain(`source: canonical/${id}`);
                expect(stale.stdout).toContain('cause:  Source entity deleted');
                const bundle = ok(d2, ['retrieve', 'ghost']);
                expect(bundle.stdout).toMatch(/entities:\s+0/);
                expect(bundle.stdout).toContain('Missing context:');
                expect(bundle.stdout).toContain(`[high] Index record references entity ${id} but it no longer exists in canonical store`);
                expect(bundle.stdout).toContain('[partial] Some index candidates could not be resolved');
            } finally {
                try { rmSync(d2, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        });

        it('explain-retrieval prints the explanation summary', () => {
            const r = ok(dir, ['explain-retrieval', 'federated', '--limit', '5']);
            expect(r.stdout.trim().length).toBeGreaterThan(0);
            expect(r.stdout.toLowerCase()).toContain('federated');
        });
    });

    describe('provenance', () => {
        it('trace prints a navigable backward trace for an entity', () => {
            const r = ok(dir, ['trace', `cluster://canonical/${entityId}`]);
            expect(r.stdout).toContain(`Provenance trace from: cluster://canonical/${entityId}`);
            expect(r.stdout).toContain('Direction: backward');
            expect(r.stdout).toContain('[entity_created_by]');
        });

        it('trace --graph emits the graph as JSON honouring --direction and --depth', () => {
            const r = ok(dir, ['trace', `cluster://canonical/${entityId}`, '--graph', '--direction', 'bidirectional', '--depth', '3']);
            const graph = JSON.parse(r.stdout);
            expect(graph.direction).toBe('bidirectional');
            expect(Array.isArray(graph.nodes)).toBe(true);
            expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
            expect(Array.isArray(graph.edges)).toBe(true);
        });

        it('why gives a compact explanation', () => {
            const r = ok(dir, ['why', `cluster://canonical/${entityId}`]);
            expect(r.stdout).toContain('concept: Federated Truth (entity in canonical)');
            expect(r.stdout).toContain('Created by: entity_created');
        });

        it('lineage traces bidirectionally and includes the index derivative', () => {
            const r = ok(dir, ['lineage', `cluster://canonical/${entityId}`, '--depth', '4']);
            expect(r.stdout).toContain('Direction: bidirectional');
            expect(r.stdout).toContain('[index_record_derived_from]');
        });

        it('trace-bundle traces a retrieved bundle, as text and as --graph JSON', () => {
            const text = ok(dir, ['trace-bundle', 'federated', '--limit', '5']);
            expect(text.stdout).toContain('Provenance trace from: bundle://');
            const g = ok(dir, ['trace-bundle', 'federated', '--graph', '--direction', 'backward']);
            const graph = JSON.parse(g.stdout);
            expect(graph.nodes.length).toBeGreaterThanOrEqual(1);
        });

        it('trace, why and lineage reject a malformed URI with exit 65', () => {
            for (const sub of ['trace', 'why', 'lineage']) {
                const r = cli(dir, [sub, 'nonsense']);
                expect(r.status, `${sub}: ${r.stderr}`).toBe(65);
                expect(r.stderr).toContain('cluster://');
            }
        });
    });

    describe('command lifecycle', () => {
        const update = (id: string, name: string) => ({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: id, patch: { name } },
        });

        it('propose does not write; validate prints the checks; commit applies the change', () => {
            const before = ok(dir, ['stats', '--json']);
            const id = proposeJson(dir, 'alice', update(entityId, 'Federated Truth v2'));
            expect(JSON.parse(ok(dir, ['stats', '--json']).stdout).receipts)
                .toBe(JSON.parse(before.stdout).receipts);
            expect(ok(dir, ['inspect', entityId]).stdout).toContain('Federated Truth');
            expect(ok(dir, ['inspect', entityId]).stdout).not.toContain('v2');

            const v = ok(dir, ['--actor', 'bob', 'validate', id]);
            expect(v.stdout).toContain(`Validated: ${id}`);
            expect(v.stdout).toContain('status: validated');
            expect(v.stdout).toMatch(/✓ verb_present/);

            const a = ok(dir, ['--actor', 'bob', 'approve', id, '--note', 'looks right']);
            expect(a.stdout).toContain('status:     approved');
            expect(a.stdout).toContain('approvedBy: bob');
            expect(a.stdout).toContain('note:       looks right');

            const c = ok(dir, ['--actor', 'bob', 'commit', id]);
            expect(c.stdout).toContain(`Committed: ${id}`);
            expect(c.stdout).toContain('status:  committed');
            expect(c.stderr).not.toContain('WARNING');
            expect(ok(dir, ['inspect', entityId]).stdout).toContain('Federated Truth v2');
        });

        it('commit walks validate and approve itself and warns when proposer and committer match', () => {
            const id = proposeJson(dir, 'carol', update(entityId, 'Federated Truth v3'));
            const c = ok(dir, ['--actor', 'carol', 'commit', id]);
            expect(c.stderr).toContain('WARNING: proposer (carol) is the same as operator (carol)');
            expect(c.stdout).toContain('Committed:');
            expect(ok(dir, ['inspect', entityId]).stdout).toContain('Federated Truth v3');
        });

        it('commit of a validated command only approves then commits', () => {
            const id = proposeJson(dir, 'dave', update(entityId, 'Federated Truth v4'));
            ok(dir, ['--actor', 'erin', 'validate', id]);
            const c = ok(dir, ['--actor', 'erin', 'commit', id]);
            expect(c.stdout).toContain('status:  committed');
            const cmd = JSON.parse(ok(dir, ['inspect-command', id]).stdout);
            expect(cmd.status).toBe('committed');
            expect(cmd.approvedBy).toBe('erin');
        });

        it('--self-approve alone refuses to auto-walk and leaves the command proposed (exit 1)', () => {
            const id = proposeJson(dir, 'frank', update(entityId, 'Federated Truth v5'));
            const c = cli(dir, ['--actor', 'frank', 'commit', id, '--self-approve']);
            expect(c.status).toBe(1);
            expect(c.stderr).toContain('--self-approve set. Same identity (frank) proposed and committed');
            expect(c.stderr).toContain('Pass --accept-soft-duty-bypass to acknowledge.');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('proposed');
        });

        it('--self-approve with --accept-soft-duty-bypass walks the lifecycle and says so', () => {
            const id = proposeJson(dir, 'gina', update(entityId, 'Federated Truth v6'));
            const c = ok(dir, ['--actor', 'gina', 'commit', id, '--self-approve', '--accept-soft-duty-bypass']);
            expect(c.stderr).toContain('walking validate→approve→commit under a single actor (gina)');
            expect(c.stdout).toContain('Committed:');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('committed');
        });

        it('commit of an unknown command id exits 1 with COMMAND_NOT_FOUND guidance', () => {
            const r = cli(dir, ['commit', 'no-such-command']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('no-such-command');
            expect(r.stderr).toContain('→ try:');
        });

        it('approve of a proposed (unvalidated) command is an illegal transition (exit 1)', () => {
            const id = proposeJson(dir, 'hank', update(entityId, 'unused'));
            const r = cli(dir, ['--actor', 'ivy', 'approve', id]);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('→ try:');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('proposed');
        });

        it('reject records the reason and makes the command terminal', () => {
            const id = proposeJson(dir, 'jack', update(entityId, 'rejected-name'));
            const r = ok(dir, ['--actor', 'kim', 'reject', id, '--reason', 'not needed']);
            expect(r.stdout).toContain(`Rejected: ${id}`);
            expect(r.stdout).toContain('status:   rejected');
            expect(r.stdout).toContain('reason:   not needed');
            const again = cli(dir, ['--actor', 'kim', 'commit', id]);
            expect(again.status).toBe(1);
            expect(ok(dir, ['inspect', entityId]).stdout).not.toContain('rejected-name');
        });

        it('reject requires --reason', () => {
            const r = cli(dir, ['reject', 'whatever']);
            expect(r.status).not.toBe(0);
            expect(r.stderr).toContain("required option '--reason <text>'");
        });

        it('propose with invalid JSON exits 1 with a command-shaped hint', () => {
            const r = cli(dir, ['propose', '{"verb": ']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Invalid JSON for command JSON:');
            expect(r.stderr).toContain('"verb":"create_entity"');
        });

        it('a payload that fails verb validation is rejected terminally (exit 1) and writes nothing', () => {
            const before = JSON.parse(ok(dir, ['stats', '--json']).stdout).entities as number;
            const id = proposeJson(dir, 'nina', {
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: '' },
            });
            const v = cli(dir, ['--actor', 'omar', 'validate', id]);
            expect(v.status).toBe(1);
            expect(v.stderr).toContain('create_entity requires kind and name');
            expect(v.stderr).toContain('→ try:');
            const c = cli(dir, ['--actor', 'omar', 'commit', id]);
            expect(c.status).toBe(1);
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('rejected');
            expect(JSON.parse(ok(dir, ['stats', '--json']).stdout).entities).toBe(before);
        });

        it('inspect-command prints the full lifecycle record as JSON', () => {
            const id = proposeJson(dir, 'lee', update(entityId, 'lee-name'));
            const cmd = JSON.parse(ok(dir, ['inspect-command', id]).stdout);
            expect(cmd).toMatchObject({ id, verb: 'update_entity', targetStore: 'canonical', proposedBy: 'lee', status: 'proposed' });
        });

        it('inspect-command of an unknown id exits 1', () => {
            const r = cli(dir, ['inspect-command', 'nope']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('nope');
        });
    });

    describe('receipts / versions / list-commands', () => {
        it('receipts lists id and command for each receipt and honours --limit', () => {
            const r = ok(dir, ['receipts']);
            expect(r.stdout).toMatch(/Receipts \(\d+\):/);
            expect(r.stdout).toContain(`id:      ${artifactReceiptId}`);
            expect(r.stdout).toMatch(/command: \S+/);
            const one = ok(dir, ['receipts', '--limit', '1']);
            expect(one.stdout).toContain('Receipts (1):');
        });

        it('receipts reports an empty ledger', () => {
            const d2 = mkdtempSync(join(tmpdir(), 'cov-cli-norcpt-'));
            try {
                ok(d2, ['init']);
                expect(ok(d2, ['receipts']).stdout).toContain('No receipts found.');
            } finally {
                try { rmSync(d2, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        });

        it('versions lists every retained version oldest-first, as text and JSON', () => {
            const text = ok(dir, ['versions', entityId]);
            expect(text.stdout).toMatch(new RegExp(`Versions of ${entityId} \\(\\d+\\):`));
            expect(text.stdout).toContain('v1  concept/Federated Truth');
            const json = JSON.parse(ok(dir, ['versions', entityId, '--json']).stdout);
            expect(Array.isArray(json)).toBe(true);
            expect(json[0].version).toBe(1);
            expect(json[json.length - 1].version).toBeGreaterThan(1);
        });

        it('versions of an unknown entity prints a no-versions notice; --quiet silences it', () => {
            const r = ok(dir, ['versions', 'unknown-entity']);
            expect(r.stdout).toContain('No versions found for entity unknown-entity.');
            const q = ok(dir, ['--quiet', 'versions', 'unknown-entity']);
            expect(q.stdout).toBe('');
            const j = ok(dir, ['versions', 'unknown-entity', '--json']);
            expect(JSON.parse(j.stdout)).toEqual([]);
        });

        it('list-commands lists, filters by --status and emits JSON', () => {
            const all = ok(dir, ['list-commands']);
            expect(all.stdout).toMatch(/Commands \(\d+\):/);
            expect(all.stdout).toContain('[committed] ingest_artifact → artifact');
            const proposed = JSON.parse(ok(dir, ['list-commands', '--status', 'proposed', '--json']).stdout);
            expect(proposed.length).toBeGreaterThan(0);
            expect(proposed.every((c: { status: string }) => c.status === 'proposed')).toBe(true);
            const none = ok(dir, ['list-commands', '--status', 'compensated']);
            expect(none.stdout).toContain('No commands found.');
        });
    });

    describe('compensate', () => {
        const mkCommitted = (name: string) => {
            const id = proposeJson(dir, 'mia', {
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId, patch: { name } },
            });
            ok(dir, ['--actor', 'mia', 'commit', id]);
            return id;
        };

        it('refuses without --yes when stdin is not a TTY and changes nothing', () => {
            const id = mkCommitted('comp-1');
            const r = cli(dir, ['--actor', 'ned', 'compensate', id, '--reason', 'oops']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Refusing to compensate: stdin is not a TTY. Pass --yes to confirm non-interactively.');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('committed');
        });

        it('--dry-run previews without mutating or snapshotting', () => {
            const id = mkCommitted('comp-2');
            const r = ok(dir, ['--actor', 'ned', 'compensate', id, '--reason', 'preview', '--dry-run']);
            expect(r.stdout).toContain('Dry run (no mutation performed).');
            expect(r.stdout).toContain(`Would compensate: ${id}`);
            expect(r.stdout).toContain('Reason:           preview');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('committed');
        });

        it('--dry-run is silent under --quiet', () => {
            const id = mkCommitted('comp-3');
            const r = ok(dir, ['--quiet', '--actor', 'ned', 'compensate', id, '--reason', 'x', '--dry-run']);
            expect(r.stdout).toBe('');
        });

        it('--yes compensates, takes an auto-snapshot first and reports both commands', () => {
            const id = mkCommitted('comp-4');
            const r = ok(dir, ['--actor', 'ned', 'compensate', id, '--reason', 'wrong name', '--yes']);
            expect(r.stderr).toMatch(/Auto-snapshot saved to: .*compensate/);
            expect(r.stdout).toContain(`Compensated: ${id}`);
            expect(r.stdout).toContain('original status: compensated');
            expect(r.stdout).toMatch(/compensating:\s+\S+/);
            expect(r.stdout).toContain('reason:          wrong name');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('compensated');
            const snaps = readdirSync(join(dir, '.db-cluster', 'auto-snapshots')).filter((n) => n.includes('compensate'));
            expect(snaps.length).toBeGreaterThanOrEqual(1);
            const file = join(dir, '.db-cluster', 'auto-snapshots', snaps[0]!, 'cluster-snapshot.json');
            const snap = JSON.parse(readFileSync(file, 'utf-8'));
            expect(Array.isArray(snap.entities)).toBe(true);
        });

        it('--force is accepted as an alias and --quiet silences banner and result', () => {
            const id = mkCommitted('comp-5');
            const r = ok(dir, ['--quiet', '--actor', 'ned', 'compensate', id, '--reason', 'q', '--force']);
            expect(r.stdout).toBe('');
            expect(r.stderr).not.toContain('Auto-snapshot saved');
            expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).status).toBe('compensated');
        });

        it('--log-level warn suppresses the auto-snapshot banner but still compensates', () => {
            const id = mkCommitted('comp-6');
            const r = ok(dir, ['--log-level', 'warn', '--actor', 'ned', 'compensate', id, '--reason', 'w', '--yes']);
            expect(r.stderr).not.toContain('Auto-snapshot saved');
            expect(r.stdout).toContain('Compensated:');
        });

        it('compensating an uncommitted command fails with the snapshot path and undo hint', () => {
            const id = proposeJson(dir, 'mia', {
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId, patch: { name: 'never-committed' } },
            });
            const r = cli(dir, ['--actor', 'ned', 'compensate', id, '--reason', 'r', '--yes']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('→ undo: compensation is permanently recorded');
            expect(r.stderr).toContain('Auto-snapshot saved to:');
        });
    });

    describe('index subcommands', () => {
        it('status reports totals per store', () => {
            const r = ok(dir, ['index', 'status']);
            expect(r.stdout).toContain('Index status:');
            expect(r.stdout).toMatch(/total records: \d+/);
            expect(r.stdout).toMatch(/stale:\s+ok/);
            expect(r.stdout).toMatch(/artifact: \d+/);
            expect(r.stdout).toMatch(/canonical: \d+/);
        });

        it('explain describes an index record and its source', () => {
            const r = ok(dir, ['index', 'explain', artifactIndexId]);
            expect(r.stdout).toContain(`Index record: ${artifactIndexId}`);
            expect(r.stdout).toContain(`source:       artifact/${artifactId}`);
            expect(r.stdout).toContain('sourceExists: true');
            expect(r.stdout).toContain('stale:        false');
        });

        it('explain of an unknown record exits 1 with a hint', () => {
            const r = cli(dir, ['index', 'explain', 'nope']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Not found in index store: nope');
            expect(r.stderr).toContain('→ try:');
        });

        it('stale reports a clean index', () => {
            const d2 = mkdtempSync(join(tmpdir(), 'cov-cli-clean-'));
            try {
                ok(d2, ['init']);
                ok(d2, ['entity', 'create', '--kind', 'note', '--name', 'Solid']);
                expect(ok(d2, ['index', 'stale']).stdout).toContain('No stale index records.');
            } finally {
                try { rmSync(d2, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        });

        it('rebuild --dry-run previews and rebuild --yes recreates the records with a receipt', () => {
            const dry = ok(dir, ['index', 'rebuild', '--dry-run']);
            expect(dry.stdout).toContain('Dry run (no mutation performed). Would rebuild the index from owner stores.');
            const dryQuiet = ok(dir, ['--quiet', 'index', 'rebuild', '--dry-run']);
            expect(dryQuiet.stdout).toBe('');

            const real = ok(dir, ['--actor', 'ned', 'index', 'rebuild', '--yes']);
            expect(real.stderr).toMatch(/Auto-snapshot saved to: .*index-rebuild/);
            expect(real.stdout).toMatch(/Index rebuilt: \d+ record\(s\) from owner stores\./);
            expect(real.stdout).toMatch(/provenance:\s+\S+/);
            expect(real.stdout).toMatch(/receipt:\s+\S+/);
            expect(ok(dir, ['index', 'stale']).stdout).toContain('No stale index records.');

            const quiet = ok(dir, ['--quiet', 'index', 'rebuild', '--force']);
            expect(quiet.stdout).toBe('');
        });

        it('rebuild refuses without --yes when stdin is not a TTY', () => {
            const r = cli(dir, ['index', 'rebuild']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Refusing to index rebuild: stdin is not a TTY. Pass --yes to confirm non-interactively.');
        });
    });
});
