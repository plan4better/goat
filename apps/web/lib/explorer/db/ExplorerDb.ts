/**
 * DuckDB-WASM in a worker, holding one bundle's snapshot.
 *
 * The worker and module are served by the app itself from
 * `/vendor/duckdb/<version>/` (copied there by `scripts/copy-duckdb-wasm.mjs`),
 * never from a CDN. The single-threaded "eh" build: threads need cross-origin
 * isolation, which would break the map's cross-origin tiles.
 *
 * Client-only: import it dynamically, never from a server component.
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

import { rowsOf } from "@/lib/explorer/db/rows";
import type { SqlRunner } from "@/lib/explorer/db/types";

/** Well inside the 4 GB a wasm32 module can address; the largest feed the
 * upload limit allows needs about 0.5 GB. */
const MEMORY_LIMIT = "2560MB";

/** The snapshot's tables live in a compressed in-memory database, not the
 * default one, which keeps them uncompressed: Berlin's take about 70 MB
 * instead of 400. A table is compressed when it is checkpointed. */
const SNAPSHOT_DB = "snapshot";

/** Rows loaded between checkpoints. The module's memory never shrinks, so
 * it keeps whatever a load once held uncompressed: a chunk of this size, not
 * a whole table (about 20 MB, where all of Berlin's stop_times would be 150). */
const LOAD_CHUNK_ROWS = 500_000;

export class ExplorerDb implements SqlRunner {
  private constructor(
    private readonly db: AsyncDuckDB,
    private readonly conn: AsyncDuckDBConnection
  ) {}

  static async open(): Promise<ExplorerDb> {
    const duckdb = await import("@duckdb/duckdb-wasm");
    const base = `/vendor/duckdb/${duckdb.PACKAGE_VERSION}`;
    const worker = new Worker(`${base}/duckdb-browser-eh.worker.js`);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    try {
      await db.instantiate(`${base}/duckdb-eh.wasm`);
      await db.open({ query: { castBigIntToDouble: true } });
      const conn = await db.connect();
      await conn.query(`SET memory_limit='${MEMORY_LIMIT}'`);
      await conn.query(`ATTACH ':memory:' AS ${SNAPSHOT_DB} (COMPRESS)`);
      await conn.query(`USE ${SNAPSHOT_DB}`);
      return new ExplorerDb(db, conn);
    } catch (error) {
      await db.terminate();
      throw error;
    }
  }

  async all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return rowsOf<T>(await this.conn.query(sql));
  }

  async columns<K extends string>(sql: string): Promise<Record<K, ArrayLike<number>>> {
    const table = await this.conn.query(sql);
    return Object.fromEntries(
      table.schema.fields.map((f) => [f.name, table.getChild(f.name)?.toArray() ?? []])
    ) as Record<K, ArrayLike<number>>;
  }

  async exec(sql: string): Promise<void> {
    await this.conn.query(sql);
  }

  /** Load one snapshot file as the table of its name, compressed, a chunk
   * of rows at a time. The buffer is released once the table holds the data. */
  async loadParquet(name: string, bytes: Uint8Array): Promise<void> {
    const file = `${name}.parquet`;
    await this.db.registerFileBuffer(file, bytes);
    try {
      const [meta] = await this.all<{ rows: number }>(
        `SELECT num_rows AS rows FROM parquet_file_metadata('${file}')`
      );
      const rows = Number(meta?.rows ?? 0);
      await this.conn.query(`CREATE OR REPLACE TABLE ${name} AS SELECT * FROM '${file}' LIMIT 0`);
      for (let from = 0; from < rows; from += LOAD_CHUNK_ROWS) {
        await this.conn.query(`
          INSERT INTO ${name}
          SELECT * EXCLUDE (file_row_number) FROM read_parquet('${file}', file_row_number = true)
          WHERE file_row_number >= ${from} AND file_row_number < ${from + LOAD_CHUNK_ROWS}`);
        await this.conn.query(`CHECKPOINT ${SNAPSHOT_DB}`);
      }
    } finally {
      await this.db.dropFile(file);
    }
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.terminate();
  }
}
