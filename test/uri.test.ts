import { describe, it, expect } from 'vitest';
import {
    parseClusterUri,
    formatClusterUri,
    isClusterUri,
    uriForObject,
    ClusterUriError,
} from '../src/uri/index.js';

describe('Cluster URI model', () => {
    describe('parseClusterUri', () => {
        it('parses canonical URI', () => {
            const uri = parseClusterUri('cluster://canonical/entity-123');
            expect(uri.store).toBe('canonical');
            expect(uri.id).toBe('entity-123');
            expect(uri.raw).toBe('cluster://canonical/entity-123');
        });

        it('parses artifact URI', () => {
            const uri = parseClusterUri('cluster://artifact/abc-def');
            expect(uri.store).toBe('artifact');
            expect(uri.id).toBe('abc-def');
        });

        it('parses index URI', () => {
            const uri = parseClusterUri('cluster://index/rec-001');
            expect(uri.store).toBe('index');
            expect(uri.id).toBe('rec-001');
        });

        it('parses ledger URI', () => {
            const uri = parseClusterUri('cluster://ledger/event-42');
            expect(uri.store).toBe('ledger');
            expect(uri.id).toBe('event-42');
        });

        it('parses receipt URI', () => {
            const uri = parseClusterUri('cluster://receipt/rcp-99');
            expect(uri.store).toBe('receipt');
            expect(uri.id).toBe('rcp-99');
        });

        it('preserves complex IDs with slashes', () => {
            const uri = parseClusterUri('cluster://artifact/content/sha256/abc123');
            expect(uri.store).toBe('artifact');
            expect(uri.id).toBe('content/sha256/abc123');
        });

        it('throws on empty string', () => {
            expect(() => parseClusterUri('')).toThrow(ClusterUriError);
        });

        it('throws on missing scheme', () => {
            expect(() => parseClusterUri('canonical/entity-1')).toThrow(ClusterUriError);
        });

        it('throws on wrong scheme', () => {
            expect(() => parseClusterUri('http://canonical/entity-1')).toThrow(ClusterUriError);
        });

        it('throws on unknown store', () => {
            expect(() => parseClusterUri('cluster://memory/id-1')).toThrow(ClusterUriError);
        });

        it('throws on missing ID', () => {
            expect(() => parseClusterUri('cluster://canonical/')).toThrow(ClusterUriError);
        });
    });

    describe('formatClusterUri', () => {
        it('formats canonical URI', () => {
            expect(formatClusterUri('canonical', 'e-1')).toBe('cluster://canonical/e-1');
        });

        it('formats artifact URI', () => {
            expect(formatClusterUri('artifact', 'a-2')).toBe('cluster://artifact/a-2');
        });

        it('formats receipt URI', () => {
            expect(formatClusterUri('receipt', 'r-3')).toBe('cluster://receipt/r-3');
        });

        it('throws on empty ID', () => {
            expect(() => formatClusterUri('canonical', '')).toThrow(ClusterUriError);
        });

        it('throws on invalid store', () => {
            expect(() => formatClusterUri('fake' as any, 'id')).toThrow(ClusterUriError);
        });
    });

    describe('isClusterUri', () => {
        it('returns true for valid URIs', () => {
            expect(isClusterUri('cluster://canonical/x')).toBe(true);
            expect(isClusterUri('cluster://artifact/y')).toBe(true);
            expect(isClusterUri('cluster://index/z')).toBe(true);
            expect(isClusterUri('cluster://ledger/w')).toBe(true);
            expect(isClusterUri('cluster://receipt/v')).toBe(true);
        });

        it('returns false for invalid URIs', () => {
            expect(isClusterUri('')).toBe(false);
            expect(isClusterUri('http://canonical/x')).toBe(false);
            expect(isClusterUri('cluster://fake/x')).toBe(false);
            expect(isClusterUri('not a uri')).toBe(false);
        });
    });

    describe('uriForObject', () => {
        it('derives URI from entity', () => {
            expect(uriForObject({ id: 'e-1', owner: 'canonical' })).toBe('cluster://canonical/e-1');
        });

        it('derives URI from artifact', () => {
            expect(uriForObject({ id: 'a-1', owner: 'artifact' })).toBe('cluster://artifact/a-1');
        });

        it('derives URI from index record', () => {
            expect(uriForObject({ id: 'i-1', owner: 'index' })).toBe('cluster://index/i-1');
        });

        it('derives URI from provenance event', () => {
            expect(uriForObject({ id: 'p-1', owner: 'ledger' })).toBe('cluster://ledger/p-1');
        });

        it('throws on unknown owner', () => {
            expect(() => uriForObject({ id: 'x', owner: 'unknown' })).toThrow(ClusterUriError);
        });
    });

    describe('roundtrip', () => {
        it('format → parse → format is stable', () => {
            const stores = ['canonical', 'artifact', 'index', 'ledger', 'receipt'] as const;
            for (const store of stores) {
                const formatted = formatClusterUri(store, `test-id-${store}`);
                const parsed = parseClusterUri(formatted);
                expect(parsed.store).toBe(store);
                expect(parsed.id).toBe(`test-id-${store}`);
                expect(formatClusterUri(parsed.store, parsed.id)).toBe(formatted);
            }
        });
    });
});
