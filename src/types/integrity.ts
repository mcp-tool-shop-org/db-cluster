/**
 * Integrity — THE SINGLE SOURCE OF TRUTH for ledger tamper-evidence.
 *
 * Wave S2-A1 (Protocol-v2 amend) — findings PROV-001 / PROV-004.
 *
 * Receipts and ProvenanceEvents are append-only ledger records. To make the
 * ledger *tamper-evident* (not merely append-only) every record carries an
 * `integrityHash` over its own content, and an optional `prevHash` binding it
 * to the immediately-preceding record in the same ledger file (a hash-chain).
 *
 * This module is the ONLY place that knows how a record's content is
 * serialized and hashed. If a writer and a verifier ever serialized
 * differently — a stray key-order difference, a `JSON.stringify` here vs a
 * hand-rolled concatenation there — the chain would silently fail to verify
 * (false tamper alarms) or silently accept tampered records (missed alarms).
 * Both adapters (writers) and ops/verify (readers) MUST route through
 * {@link computeIntegrityHash} so the bytes that go in always match the bytes
 * that come out.
 *
 * Contract for downstream implementers (Agents 2–5):
 *  - The adapter stamps `integrityHash` on `append()` / `appendReceipt()`
 *    AFTER assembling the full record (post-spread, alongside `id` /
 *    `timestamp` / `owner`), exactly like the existing stamp pattern.
 *  - `prevHash` is the `integrityHash` of the record written immediately
 *    before this one in the same ledger file. The FIRST record in a file is
 *    the genesis record and has `prevHash === undefined`.
 *  - On read, `getEvent` / `getReceipt` recompute `computeIntegrityHash` on
 *    the stored record and throw a typed integrity error when it does not
 *    match the stored `integrityHash` (PROV-004). `verify` additionally walks
 *    the `prevHash` chain end-to-end.
 *  - `importEvent` / `importReceipt` preserve the original `integrityHash` and
 *    `prevHash` verbatim (they restore a snapshot; the hash already commits to
 *    the content, so re-stamping would defeat tamper detection).
 *
 * ─── SECURITY SCOPE: tamper-EVIDENT, NOT tamper-PROOF (read this) ────────────
 *
 * The `integrityHash` is an UNKEYED SHA-256 over each record's canonical
 * content, chained via `prevHash`. That gives genuine tamper-EVIDENCE against:
 *   - accidental corruption (bit-rot, truncated / partial writes),
 *   - reordering, and records inserted or deleted out of sequence,
 *   - casual single-record hand-edits (the recomputed hash no longer matches).
 *
 * It is NOT tamper-PROOF cryptographic anti-forgery. The hash function and
 * `computeIntegrityHash` ship in this package and use no secret. An actor who
 * possesses this package can edit OR delete a ledger record, recompute its
 * `integrityHash`, and re-stamp every FORWARD record's `prevHash` +
 * `integrityHash` so the whole chain re-verifies CLEAN. There is therefore no
 * defence here against a knowledgeable package-holder who chooses to forge the
 * ledger — only against accidental damage and unsophisticated edits.
 *
 * The anti-forgery upgrade — a keyed HMAC over an operator-held secret, or
 * external chain-head anchoring / signing of the tail hash — is NOT in v1.0.0.
 * It is the tracked path for a later wave; the unkeyed chain is the locked
 * v1.0.0 contract. Do NOT add crypto in this module without that wave.
 *
 * Read-time scope (V2-002): single-record reads — `getEvent` / `getReceipt` —
 * recompute the hash on read and throw on a mismatch (verify-on-read). BULK
 * reads — `listEvents` / `listReceipts` / `trace` — do NOT recompute integrity
 * per record (they return records as stored). To get tamper-evidence over a SET
 * of records, run `verify()`, which walks the whole chain end-to-end.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';

/**
 * The record field that holds the tamper-evidence hash. It is EXCLUDED from
 * the hashed content (a hash cannot commit to itself). Every other field —
 * including `prevHash`, `id`, and everything in `attributes` / `detail` — is
 * part of the hashed content.
 */
const INTEGRITY_HASH_KEY = 'integrityHash';

/**
 * Deterministic, recursive, key-sorted serialization of a record's content.
 *
 * Rules (load-bearing — writer and verifier MUST agree byte-for-byte):
 *  - Objects: keys sorted ascending by Unicode code point (`Array.prototype.sort`
 *    default order), then serialized recursively. Insertion order is therefore
 *    irrelevant — `{b:1,a:2}` and `{a:2,b:1}` produce identical output.
 *  - Arrays: order is PRESERVED (arrays are ordered data); each element
 *    serialized recursively.
 *  - Primitives (string / number / boolean): JSON-encoded via `JSON.stringify`
 *    (so strings are quoted + escaped, numbers/booleans render canonically).
 *  - `null`: the literal `null`.
 *  - `undefined` and functions: treated as absent. An object property whose
 *    value is `undefined` is OMITTED from the serialization entirely (it does
 *    not appear as a key). This is what makes an optional `prevHash` that is
 *    `undefined` (genesis record) serialize identically to one that was never
 *    set — the chain link is "no predecessor" in both cases.
 *  - `bigint`: serialized as its base-10 string form (JSON cannot encode
 *    bigint; we render it deterministically rather than throw).
 *
 * Total / defensive: never throws on missing optional fields or on the value
 * shapes a ledger record can legitimately hold.
 */
export function canonicalSerialize(value: unknown): string {
    if (value === null) {
        return 'null';
    }

    const valueType = typeof value;

    if (valueType === 'undefined' || valueType === 'function') {
        // Caller-level guard: a top-level `undefined`/function has no content.
        // (Object properties holding these are dropped in the object branch
        // below; this branch only fires for a top-level call.)
        return 'null';
    }

    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
        // JSON.stringify renders NaN / Infinity as `null`, which is the
        // standard JSON behaviour and is deterministic — acceptable here.
        return JSON.stringify(value);
    }

    if (valueType === 'bigint') {
        // JSON cannot encode bigint; render its exact base-10 form.
        return (value as bigint).toString();
    }

    if (Array.isArray(value)) {
        // Arrays preserve order; each element recursively serialized.
        return `[${value.map((element) => canonicalSerialize(element)).join(',')}]`;
    }

    if (valueType === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record)
            // Drop keys whose value is `undefined` or a function: they carry no
            // content and would otherwise make serialization depend on whether
            // an optional field was explicitly set to `undefined` vs omitted.
            .filter((key) => {
                const v = record[key];
                return typeof v !== 'undefined' && typeof v !== 'function';
            })
            .sort();
        const body = keys
            .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
            .join(',');
        return `{${body}}`;
    }

    // Symbols and any other exotic type: no meaningful content. Defensive
    // fallback keeps the function total.
    return 'null';
}

/**
 * Tamper-evidence hash for a ledger record (Receipt | ProvenanceEvent).
 *
 * `= sha256_hex( canonicalSerialize(record WITHOUT its own integrityHash field) )`.
 *
 * The record's `prevHash` IS included in the hashed content (so tampering with
 * the chain link is detected). All other content fields are included. Only the
 * `integrityHash` key itself is stripped before hashing — a hash cannot commit
 * to itself. The result is deterministic regardless of key insertion order
 * (see {@link canonicalSerialize}).
 *
 * Total / defensive: accepts any record shape, including one that does not yet
 * carry an `integrityHash` (the pre-stamp state at write time) or whose
 * `prevHash` is absent (a genesis record). Never throws on missing optional
 * fields.
 *
 * @param record  The ledger record's content. The caller may pass the record
 *                with or without an existing `integrityHash`; either way that
 *                field is excluded from the hash so the value is stable across
 *                the write (pre-stamp) and read (post-stamp) sides.
 * @returns       Lowercase 64-char hex SHA-256 digest of the canonical
 *                serialization.
 */
export function computeIntegrityHash(record: Record<string, unknown>): string {
    // Shallow-copy and strip ONLY the integrityHash key. Everything else —
    // prevHash, id, timestamp/committedAt, owner, detail/attributes, etc. — is
    // part of the committed content.
    const { [INTEGRITY_HASH_KEY]: _omitSelfHash, ...content } = record;
    void _omitSelfHash;
    return createHash('sha256').update(canonicalSerialize(content)).digest('hex');
}
