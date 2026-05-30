/**
 * Wave V2 — A5 cross-cutting regression.
 *  - SDK-002: the opaque cursor codec is opaque, round-trips, defensive, and
 *    encodes ONLY V1's numeric offset (no internal ids → not an oracle).
 *  - The per-element-redaction completeness gate (R13) exists and is registered
 *    in the runner (which iterates an explicit RULES array, not a glob).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeCursor, decodeCursor } from '../src/types/page.js';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('Wave V2 — cross-cutting (cursor codec + completeness gate)', () => {
    it('SDK-002: the opaque cursor round-trips, is opaque, and is defensive', () => {
        const c = encodeCursor(5);
        expect(typeof c).toBe('string');
        expect(c).not.toBe('5'); // opaque — not the raw numeric offset
        expect(decodeCursor(c)).toBe(5); // round-trip
        expect(decodeCursor(undefined)).toBe(0); // absent → offset 0
        expect(decodeCursor('not-a-valid-cursor!!!')).toBe(0); // malformed → 0 (never throws)
        expect(decodeCursor(encodeCursor(-3))).toBe(0); // negative clamped to 0
    });

    it('SDK-002: the cursor encodes ONLY the offset — no internal ids leak', () => {
        const decoded = Buffer.from(encodeCursor(40), 'base64url').toString('utf-8');
        expect(decoded).toBe('{"o":40}'); // nothing but the offset
    });

    it('VERSIONS-001: the per-element-redaction completeness gate (R13) exists and is registered', () => {
        expect(existsSync(join(ROOT, 'scripts/checks/R13-version-read-without-per-element-redaction.yml'))).toBe(true);
        const runner = read('scripts/completeness-checks.mjs');
        expect(runner.includes('R13-version-read-without-per-element-redaction.yml')).toBe(true);
    });
});
