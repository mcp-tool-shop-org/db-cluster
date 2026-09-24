/**
 * ClusterUriError and ResolveError carry their own code, remediation hint
 * and retryable flag, like the other adapter-layer typed errors.
 *
 * Neither used to carry any. The MCP boundary mapped them by class name
 * (BUILTIN_ERROR_CODES in src/mcp/sanitize.ts), but the CLI keys on
 * `err.code`, so a malformed URI exited 1 with no hint instead of
 * INVALID_CLUSTER_URI's 65, and `resolve` on a missing ID printed no hint.
 * The live CLI exits are asserted in wave-c1-tests-exit-codes.test.ts; this
 * file pins the error shapes and proves the MCP envelopes did not change.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { redactError } from '../src/mcp/sanitize.js';
import { ClusterResolver, ResolveError } from '../src/resolver/index.js';
import type { ClusterStore } from '../src/uri/cluster-uri.js';
import {
    ClusterUriError,
    formatClusterUri,
    parseClusterUri,
    uriForObject,
} from '../src/uri/cluster-uri.js';

// The hints MCP already sent for these codes (TYPED_ERROR_ENRICHMENT). The
// classes now carry them, so the CLI prints what MCP hosts already saw.
const URI_HINT = 'URI must match `cluster://<store>/<id>`. Re-form the URI and retry.';
const RESOLVE_HINT =
    'The cluster URI does not resolve. Confirm the store name and ID with `db-cluster find <query>`.';

function thrownBy(call: () => unknown): unknown {
    try {
        call();
    } catch (err) {
        return err;
    }
    throw new Error('expected the call to throw');
}

describe('ClusterUriError carries INVALID_CLUSTER_URI', () => {
    it.each<[string, () => unknown]>([
        ['a malformed URI', () => parseClusterUri('not a uri')],
        ['an unknown store', () => parseClusterUri('cluster://nope/123')],
        ['formatting an unknown store', () => formatClusterUri('nope' as ClusterStore, 'x')],
        ['formatting an empty id', () => formatClusterUri('canonical', '')],
        ['deriving a URI for an unknown owner', () => uriForObject({ id: 'x', owner: 'nope' })],
    ])('%s', (_label, call) => {
        const err = thrownBy(call);
        expect(err).toBeInstanceOf(ClusterUriError);
        expect(err).toMatchObject({
            code: 'INVALID_CLUSTER_URI',
            retryable: false,
            remediationHint: URI_HINT,
        });
    });
});

describe('ResolveError carries RESOLVE_NOT_FOUND', () => {
    it('a well-formed URI that names nothing', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'uri-errors-typed-'));
        try {
            const resolver = new ClusterResolver(createLocalCluster(dir));
            const err = await resolver.resolve('cluster://canonical/missing-id').catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ResolveError);
            expect(err).toMatchObject({
                code: 'RESOLVE_NOT_FOUND',
                retryable: false,
                remediationHint: RESOLVE_HINT,
                uri: 'cluster://canonical/missing-id',
                message: 'Entity not found: missing-id',
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the MCP envelopes are unchanged', () => {
    // Before, redactError took the code from BUILTIN_ERROR_CODES and the hint
    // and retryable flag from TYPED_ERROR_ENRICHMENT. Now the error supplies
    // all three itself; the envelope an MCP host receives must not move.
    it('ClusterUriError', () => {
        expect(redactError(thrownBy(() => parseClusterUri('not a uri')))).toEqual({
            code: 'INVALID_CLUSTER_URI',
            message: 'Invalid cluster URI: not a uri',
            retryable: false,
            remediation_hint: URI_HINT,
            context: { errorClass: 'ClusterUriError' },
        });
    });

    it('ResolveError', () => {
        expect(redactError(new ResolveError('cluster://canonical/missing-id', 'Entity not found: missing-id'))).toEqual({
            code: 'RESOLVE_NOT_FOUND',
            message: 'Entity not found: missing-id',
            retryable: false,
            remediation_hint: RESOLVE_HINT,
            context: { errorClass: 'ResolveError' },
        });
    });
});
