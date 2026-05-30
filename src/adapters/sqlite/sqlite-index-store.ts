import { randomUUID } from 'node:crypto';
import type { IndexRecord } from '../../types/index-record.js';
import type { IndexStore, IndexQuery } from '../../contracts/index-store.js';
import { SqliteDb } from './sqlite-db.js';
import { INDEX_RECORDS_TABLE } from './schema.js';

/**
 * SQLite index store — derivative discoverability index, drop-in substitutable
 * for {@link import('../local/local-index-store.js').LocalIndexStore}.
 *
 * Behavioural parity is the contract (Wave V3, agent A2). Every method mirrors
 * the local adapter's observable behaviour exactly; the only difference is the
 * persistence substrate (a SQLite table vs an in-memory Map + JSON file).
 *
 * search() returns CANDIDATES in INSERTION ORDER — it does NOT rank. The local
 * adapter iterates a Map in insertion order; here the `seq` AUTOINCREMENT PK is
 * the insertion order, so `ORDER BY seq ASC` reproduces it byte-for-byte. BM25
 * relevance ranking is a layer ABOVE search() in the retrieval planner
 * (RETR-001) and is deliberately NOT performed in this adapter.
 *
 * Parity-critical decision: the text + metadata filters run IN JS over the
 * SELECTed rows using the EXACT predicates LocalIndexStore.search uses (case-
 * folded substring against `text` OR `JSON.stringify(metadata)`, then shallow-
 * equal per metadata key). Doing this in JS rather than in SQL guarantees the
 * candidate set is identical to local — a SQL `LIKE`/`json_extract` rewrite
 * could differ in case-folding, collation, or JSON whitespace. `sourceStore`
 * IS pushed into SQL as an exact-equality prefilter (safe: exact match has no
 * collation ambiguity) so the common store-narrowed scan reads fewer rows.
 *
 * SQL SAFETY: every value is bound with `?`. The only interpolated tokens are
 * A3's compile-time table-name constants.
 */
export class SqliteIndexStore implements IndexStore {
    constructor(private readonly db: SqliteDb) {}

    async search(query: IndexQuery): Promise<IndexRecord[]> {
        // sourceStore is a safe SQL prefilter (exact equality). Everything else
        // is applied in JS over the ordered candidate set to stay byte-identical
        // to LocalIndexStore.search.
        const rows = query.sourceStore
            ? this.db.connection
                  .prepare(
                      `SELECT * FROM ${INDEX_RECORDS_TABLE} WHERE source_store = ? ORDER BY seq ASC`,
                  )
                  .all(query.sourceStore)
            : this.db.connection
                  .prepare(`SELECT * FROM ${INDEX_RECORDS_TABLE} ORDER BY seq ASC`)
                  .all();

        let results = (rows as Record<string, unknown>[]).map((r) =>
            this.rowToIndexRecord(r),
        );

        // text: keep a row if the lowercased query is a substring of either the
        // lowercased text OR the lowercased JSON of metadata. EXACT local logic.
        if (query.text) {
            const q = query.text.toLowerCase();
            results = results.filter(
                (r) =>
                    r.text.toLowerCase().includes(q) ||
                    JSON.stringify(r.metadata).toLowerCase().includes(q),
            );
        }
        // metadata: shallow-equal per key. EXACT local logic.
        if (query.metadata) {
            for (const [key, value] of Object.entries(query.metadata)) {
                results = results.filter((r) => r.metadata[key] === value);
            }
        }
        // offset/limit applied LAST over the post-filter candidate set, exactly
        // as local (RETR-005). offset absent / 0 / negative ≡ no skip.
        const offset = Math.max(0, query.offset ?? 0);
        if (query.limit) {
            results = results.slice(offset, offset + query.limit);
        } else if (offset > 0) {
            results = results.slice(offset);
        }
        return results;
    }

    async get(id: string): Promise<IndexRecord | null> {
        const row = this.db.connection
            .prepare(`SELECT * FROM ${INDEX_RECORDS_TABLE} WHERE id = ?`)
            .get(id) as Record<string, unknown> | undefined;
        return row ? this.rowToIndexRecord(row) : null;
    }

    async index(
        record: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>,
    ): Promise<IndexRecord> {
        // Stamp id / indexedAt / owner at the adapter boundary, exactly like
        // local. `seq` is assigned by AUTOINCREMENT on INSERT (= insertion order).
        const full: IndexRecord = {
            id: randomUUID(),
            ...record,
            indexedAt: new Date().toISOString(),
            owner: 'index',
        };
        this.insertRecord(full);
        return full;
    }

    async remove(id: string): Promise<void> {
        this.db.connection.prepare(`DELETE FROM ${INDEX_RECORDS_TABLE} WHERE id = ?`).run(id);
    }

    async clear(): Promise<void> {
        this.db.connection.prepare(`DELETE FROM ${INDEX_RECORDS_TABLE}`).run();
    }

    async count(): Promise<number> {
        const row = this.db.connection
            .prepare(`SELECT COUNT(*) AS n FROM ${INDEX_RECORDS_TABLE}`)
            .get() as { n: number };
        return row.n;
    }

    /**
     * Atomically replace the entire record set (STORES-008). DELETE-all then
     * INSERT each with a fresh `id` / `indexedAt` / `owner`, ALL inside ONE
     * transaction. The local adapter gets its no-empty-window guarantee from a
     * filesystem rename; the SQLite transaction gives the same guarantee — no
     * reader observes the intermediate empty state, and a failure mid-swap rolls
     * back to the prior set.
     */
    async replaceAll(
        records: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>[],
    ): Promise<void> {
        const now = new Date().toISOString();
        this.db.transaction(() => {
            this.db.connection.prepare(`DELETE FROM ${INDEX_RECORDS_TABLE}`).run();
            for (const r of records) {
                const full: IndexRecord = {
                    id: randomUUID(),
                    ...r,
                    indexedAt: now,
                    owner: 'index',
                };
                this.insertRecord(full);
            }
        });
    }

    // ---- persistence helpers --------------------------------------------

    /**
     * INSERT one fully-stamped record. `seq` is omitted from the column list so
     * AUTOINCREMENT assigns the next insertion-order value. `embedding` is
     * `JSON.stringify(embedding)` when present, else SQL NULL (the column is
     * NULLABLE; an absent embedding must round-trip back to `undefined`, never
     * an empty array or `null`). All values bound with `?`.
     */
    private insertRecord(record: IndexRecord): void {
        this.db.connection
            .prepare(
                `INSERT INTO ${INDEX_RECORDS_TABLE} ` +
                    `(id, source_id, source_store, text, metadata, embedding, indexed_at, owner) ` +
                    `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                record.id,
                record.sourceId,
                record.sourceStore,
                record.text,
                JSON.stringify(record.metadata),
                record.embedding !== undefined ? JSON.stringify(record.embedding) : null,
                record.indexedAt,
                record.owner,
            );
    }

    /**
     * Reconstruct an {@link IndexRecord} from a raw `index_records` row.
     * `metadata` JSON-parses; `embedding` JSON-parses when non-null and is
     * OMITTED (left `undefined`, never `null`) when the column is NULL —
     * matching the optional field on the domain type. `owner` is the literal
     * `'index'`.
     */
    private rowToIndexRecord(row: Record<string, unknown>): IndexRecord {
        const record: IndexRecord = {
            id: row.id as string,
            sourceId: row.source_id as string,
            sourceStore: row.source_store as IndexRecord['sourceStore'],
            text: row.text as string,
            metadata: JSON.parse((row.metadata as string) ?? '{}') as Record<string, unknown>,
            indexedAt: row.indexed_at as string,
            owner: 'index',
        };
        if (row.embedding !== null && row.embedding !== undefined) {
            record.embedding = JSON.parse(row.embedding as string) as number[];
        }
        return record;
    }
}
