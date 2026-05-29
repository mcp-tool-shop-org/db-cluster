/**
 * Wave S2-A1 — Integrity contracts & types regression net.
 *
 * This is the SHARED CONTRACT that Fix Agents 2–5 implement against. It pins,
 * in isolation (imports ONLY from `src/types/**` and `src/contracts/**`), the
 * invariants the rest of the wave depends on:
 *
 *  - PROV-004 — `computeIntegrityHash` is the single source of truth for ledger
 *    tamper-evidence. It must be deterministic w.r.t. key insertion order,
 *    sensitive to any content field (including `prevHash`), and must EXCLUDE
 *    the record's own `integrityHash` field from the hashed content.
 *  - `canonicalSerialize` must produce stable, key-sorted output recursively
 *    (nested objects sorted; arrays order-preserved).
 *  - The promoted type contracts: `Entity.version` is required;
 *    `Receipt.integrityHash` / `ProvenanceEvent.integrityHash` are required;
 *    `CanonicalStore.create()` rejects a caller-supplied `version`. These are
 *    the `@ts-expect-error` "FULL invariant" proofs — they fail the `tsc` /
 *    `npm run lint` gate if the field is ever demoted back to optional/absent.
 *
 * Isolation note: this file deliberately does NOT import adapters, kernel, or
 * ops. It compiles and passes while the downstream implementations are still
 * red (they don't yet stamp the new fields). That is expected — Agents 2–5
 * make the rest of the tree green.
 *
 * Type-check note: `vitest run` strips types (esbuild) and does NOT enforce the
 * `@ts-expect-error` directives below — those are enforced by `tsc --noEmit`
 * (`npm run lint`) / the release gate. Each negative case is therefore ALSO
 * written so the surrounding expression evaluates at runtime, keeping the file
 * exercised under `vitest run` while the directive guards the type contract.
 */

import { describe, it, expect } from 'vitest';
import { canonicalSerialize, computeIntegrityHash } from '../src/types/integrity.js';
import type { Entity } from '../src/types/entity.js';
import type { Receipt } from '../src/types/receipt.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { CanonicalStore } from '../src/contracts/canonical-store.js';

// A well-formed Receipt content object, expressed as a plain record so we can
// permute its key insertion order freely (the type-level proofs live in their
// own block below).
function receiptContentA(): Record<string, unknown> {
    return {
        id: 'rcp-1',
        commandId: 'cmd-1',
        committedAt: '2026-05-28T00:00:00.000Z',
        resultSummary: 'Created entity foo.',
        affectedIds: ['ent-1', 'ent-2'],
        provenanceEventId: 'evt-1',
        prevHash: 'a'.repeat(64),
        integrityHash: 'IGNORED-SELF-HASH',
    };
}

describe('Wave S2-A1 — Integrity contracts & types', () => {
    // ─── PROV-004 — computeIntegrityHash determinism + sensitivity ─────────
    describe('PROV-004 — computeIntegrityHash', () => {
        it('S2A1-T1: identical content with different key insertion order yields an identical hash', () => {
            const ordered = receiptContentA();
            // Same content, keys inserted in a deliberately scrambled order.
            const scrambled: Record<string, unknown> = {
                integrityHash: 'IGNORED-SELF-HASH',
                provenanceEventId: 'evt-1',
                affectedIds: ['ent-1', 'ent-2'],
                prevHash: 'a'.repeat(64),
                resultSummary: 'Created entity foo.',
                committedAt: '2026-05-28T00:00:00.000Z',
                commandId: 'cmd-1',
                id: 'rcp-1',
            };
            expect(computeIntegrityHash(scrambled)).toBe(computeIntegrityHash(ordered));
        });

        it('S2A1-T2: changing a content field (resultSummary) changes the hash', () => {
            const base = receiptContentA();
            const mutated = { ...base, resultSummary: 'Created entity bar.' };
            expect(computeIntegrityHash(mutated)).not.toBe(computeIntegrityHash(base));
        });

        it('S2A1-T3: changing prevHash changes the hash (chain link is bound into content)', () => {
            const base = receiptContentA();
            const mutated = { ...base, prevHash: 'b'.repeat(64) };
            expect(computeIntegrityHash(mutated)).not.toBe(computeIntegrityHash(base));
        });

        it('S2A1-T4: the record\'s own integrityHash field is EXCLUDED from the hash', () => {
            const base = receiptContentA();
            // Set integrityHash to junk — the result must be unchanged because
            // the function strips that key before hashing.
            const junkSelfHash = { ...base, integrityHash: 'TOTALLY-DIFFERENT-JUNK' };
            expect(computeIntegrityHash(junkSelfHash)).toBe(computeIntegrityHash(base));

            // And removing it entirely (the pre-stamp write-time state) also
            // produces the same hash — proving writer and verifier agree.
            const withoutSelfHash = { ...base } as Record<string, unknown>;
            delete withoutSelfHash.integrityHash;
            expect(computeIntegrityHash(withoutSelfHash)).toBe(computeIntegrityHash(base));
        });

        it('S2A1-T5: a genesis record (prevHash undefined) hashes identically whether prevHash is omitted or explicitly undefined', () => {
            const omitted: Record<string, unknown> = {
                id: 'evt-1',
                action: 'entity_created',
                detail: {},
            };
            const explicitUndefined: Record<string, unknown> = {
                id: 'evt-1',
                action: 'entity_created',
                detail: {},
                prevHash: undefined,
            };
            expect(computeIntegrityHash(explicitUndefined)).toBe(computeIntegrityHash(omitted));
        });

        it('S2A1-T6: nested object content (detail) is hashed order-independently; changing a nested value changes the hash', () => {
            const a: Record<string, unknown> = {
                id: 'evt-1',
                detail: { kind: 'document', meta: { author: 'alice', tags: ['x', 'y'] } },
            };
            const aReordered: Record<string, unknown> = {
                detail: { meta: { tags: ['x', 'y'], author: 'alice' }, kind: 'document' },
                id: 'evt-1',
            };
            const aMutatedNested: Record<string, unknown> = {
                id: 'evt-1',
                detail: { kind: 'document', meta: { author: 'bob', tags: ['x', 'y'] } },
            };
            expect(computeIntegrityHash(aReordered)).toBe(computeIntegrityHash(a));
            expect(computeIntegrityHash(aMutatedNested)).not.toBe(computeIntegrityHash(a));
        });

        it('S2A1-T7: array order IS significant (arrays are ordered data)', () => {
            const a: Record<string, unknown> = { id: 'evt-1', affectedIds: ['ent-1', 'ent-2'] };
            const reorderedArray: Record<string, unknown> = {
                id: 'evt-1',
                affectedIds: ['ent-2', 'ent-1'],
            };
            expect(computeIntegrityHash(reorderedArray)).not.toBe(computeIntegrityHash(a));
        });

        it('S2A1-T8: output is a lowercase 64-char hex SHA-256 digest', () => {
            const hash = computeIntegrityHash(receiptContentA());
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
        });

        it('S2A1-T9: total/defensive — empty record and missing optionals do not throw', () => {
            expect(() => computeIntegrityHash({})).not.toThrow();
            expect(computeIntegrityHash({})).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    // ─── canonicalSerialize — stable key ordering ──────────────────────────
    describe('canonicalSerialize', () => {
        it('S2A1-T10: nested object keys are sorted recursively; insertion order is irrelevant', () => {
            // attributes: {b:1, a:{d:4, c:3}} — both top-level (b before a) and
            // nested (d before c) keys are out of order on input.
            const value = { attributes: { b: 1, a: { d: 4, c: 3 } } };
            const out = canonicalSerialize(value);
            // Expected: outermost key "attributes", then nested "a" before "b",
            // and within "a", "c" before "d".
            expect(out).toBe('{"attributes":{"a":{"c":3,"d":4},"b":1}}');
        });

        it('S2A1-T11: two objects differing ONLY in key insertion order serialize identically', () => {
            const lhs = canonicalSerialize({ b: 1, a: { d: 4, c: 3 } });
            const rhs = canonicalSerialize({ a: { c: 3, d: 4 }, b: 1 });
            expect(lhs).toBe(rhs);
        });

        it('S2A1-T12: arrays preserve order while their object elements are key-sorted', () => {
            const out = canonicalSerialize([{ y: 2, x: 1 }, { x: 3, y: 4 }]);
            expect(out).toBe('[{"x":1,"y":2},{"x":3,"y":4}]');
        });

        it('S2A1-T13: primitives, null, and undefined-valued keys are handled deterministically', () => {
            expect(canonicalSerialize('hi')).toBe('"hi"');
            expect(canonicalSerialize(42)).toBe('42');
            expect(canonicalSerialize(true)).toBe('true');
            expect(canonicalSerialize(null)).toBe('null');
            // A key whose value is undefined is omitted entirely.
            expect(canonicalSerialize({ a: 1, b: undefined })).toBe('{"a":1}');
        });
    });

    // ─── FULL-invariant TYPE proofs (enforced by tsc / npm run lint) ───────
    //
    // These are the contract-promotion proofs. Each `@ts-expect-error` sits on
    // an expression that is a genuine type error AFTER Wave S2-A1 (the field is
    // now required / forbidden). If a field is ever demoted, the error
    // disappears and `tsc` fails with an "unused @ts-expect-error" — surfacing
    // the regression at the type-check gate. The expressions also evaluate at
    // runtime so the block is exercised under `vitest run`.
    describe('FULL-invariant — promoted type contracts (tsc-enforced)', () => {
        it('S2A1-T14: an Entity literal missing `version` is a type error', () => {
            // @ts-expect-error — `version` is required on Entity (Wave S2-A1).
            const bad: Entity = {
                id: 'ent-1',
                kind: 'document',
                name: 'Foo',
                attributes: {},
                createdAt: '2026-05-28T00:00:00.000Z',
                updatedAt: '2026-05-28T00:00:00.000Z',
                owner: 'canonical',
            };
            // Runtime: the object exists (TS error is compile-time only).
            expect(bad.id).toBe('ent-1');
            // A correctly-shaped Entity (with version) is accepted.
            const good: Entity = { ...bad, version: 1 };
            expect(good.version).toBe(1);
        });

        it('S2A1-T15: a Receipt literal missing `integrityHash` is a type error', () => {
            // @ts-expect-error — `integrityHash` is required on Receipt (Wave S2-A1).
            const bad: Receipt = {
                id: 'rcp-1',
                commandId: 'cmd-1',
                committedAt: '2026-05-28T00:00:00.000Z',
                resultSummary: 'ok',
                affectedIds: [],
                provenanceEventId: 'evt-1',
            };
            expect(bad.id).toBe('rcp-1');
            const good: Receipt = { ...bad, integrityHash: 'a'.repeat(64) };
            expect(good.integrityHash).toHaveLength(64);
        });

        it('S2A1-T16: a ProvenanceEvent literal missing `integrityHash` is a type error', () => {
            // @ts-expect-error — `integrityHash` is required on ProvenanceEvent (Wave S2-A1).
            const bad: ProvenanceEvent = {
                id: 'evt-1',
                timestamp: '2026-05-28T00:00:00.000Z',
                action: 'entity_created',
                actorId: 'operator',
                subjectId: 'ent-1',
                subjectStore: 'canonical',
                detail: {},
                owner: 'ledger',
            };
            expect(bad.id).toBe('evt-1');
            const good: ProvenanceEvent = { ...bad, integrityHash: 'a'.repeat(64) };
            expect(good.integrityHash).toHaveLength(64);
        });

        it('S2A1-T17: passing `version` into CanonicalStore.create() input is a type error', () => {
            // The create() input type omits id | version | createdAt | updatedAt
            // | owner. A FRESH object literal that includes `version` triggers
            // excess-property checking against that exact parameter type.
            type CreateInput = Parameters<CanonicalStore['create']>[0];
            const bad: CreateInput = {
                kind: 'document',
                name: 'Foo',
                attributes: {},
                // @ts-expect-error — `version` must NOT be supplied to create() (adapter stamps it).
                version: 1,
            };
            // Runtime: the (excess) property is still present on the value.
            expect((bad as Record<string, unknown>).version).toBe(1);

            // The correct input (no version) type-checks cleanly.
            const good: CreateInput = { kind: 'document', name: 'Foo', attributes: {} };
            expect(good.kind).toBe('document');
        });

        it('S2A1-T18: CanonicalStore exposes listVersions + getVersion in the contract type', () => {
            // Type-level presence proof: these method signatures must exist on
            // the contract. A structural check that fails to compile if removed.
            type HasListVersions = CanonicalStore['listVersions'] extends (id: string) => Promise<Entity[]>
                ? true
                : false;
            type HasGetVersion = CanonicalStore['getVersion'] extends (
                id: string,
                version: number,
            ) => Promise<Entity | null>
                ? true
                : false;
            const listVersionsOk: HasListVersions = true;
            const getVersionOk: HasGetVersion = true;
            expect(listVersionsOk && getVersionOk).toBe(true);
        });
    });
});
