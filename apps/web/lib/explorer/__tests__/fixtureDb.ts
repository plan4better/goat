/**
 * The mini feed's snapshot (`__fixtures__/mini`, written by goatlib's
 * `tests/fixtures/explorer_web_fixture.py`) in DuckDB-WASM's blocking Node
 * build: the same engine and SQL as the browser, without a worker.
 */
import {
  ConsoleLogger,
  LogLevel,
  NODE_RUNTIME,
  createDuckDB,
} from "@duckdb/duckdb-wasm/dist/duckdb-node-blocking";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { SqlRunner } from "@/lib/explorer/db/types";

const FIXTURE = join(__dirname, "..", "__fixtures__", "mini");

export async function openFixtureDb(): Promise<SqlRunner> {
  const require = createRequire(import.meta.url);
  const dist = dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));
  const db = await createDuckDB(
    {
      mvp: { mainModule: join(dist, "duckdb-mvp.wasm"), mainWorker: "" },
      eh: { mainModule: join(dist, "duckdb-eh.wasm"), mainWorker: "" },
    },
    new ConsoleLogger(LogLevel.WARNING),
    NODE_RUNTIME
  );
  await db.instantiate();
  db.open({ query: { castBigIntToDouble: true } });
  const conn = db.connect();
  for (const file of readdirSync(FIXTURE).filter((f) => f.endsWith(".parquet"))) {
    const name = file.replace(/\.parquet$/, "");
    db.registerFileBuffer(file, new Uint8Array(readFileSync(join(FIXTURE, file))));
    conn.query(`CREATE TABLE ${name} AS SELECT * FROM '${file}'`);
    db.dropFile(file);
  }
  return {
    async all<T>(sql: string): Promise<T[]> {
      return conn
        .query(sql)
        .toArray()
        .map((row) => row.toJSON() as T);
    },
    async columns<K extends string>(sql: string): Promise<Record<K, ArrayLike<number>>> {
      const table = conn.query(sql);
      return Object.fromEntries(
        table.schema.fields.map((f) => [f.name, table.getChild(f.name)?.toArray() ?? []])
      ) as Record<K, ArrayLike<number>>;
    },
    async exec(sql: string): Promise<void> {
      conn.query(sql);
    },
  };
}
