/**
 * An editing session: the changes applied to the Explorer's copy of a
 * bundle, in order, each undoable to the exact rows it found.
 *
 * Kept outside React and Redux, as the playback clock is: it holds rows, not
 * state to render. Redux mirrors only each change's summary (the change list,
 * the counts); the session is what applies, undoes and saves.
 *
 * Applying a change copies, before and after, the rows of every snapshot
 * table it touches into temp tables of the same database; undo and redo put
 * one copy back. Nothing is recomputed or inferred, so undo restores the
 * table byte for byte, cascade included (03-validation-spec § 6). A new change
 * forgets the undone ones, as every editor's redo does.
 *
 * Every apply, undo and redo moves the session's `edition` on: the data
 * hooks key their answers on it, so every panel reads the tables again.
 */
import { forget } from "@/lib/explorer/answers";
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { ChangeSummary, EditChange, GtfsRowOp, Touch } from "@/lib/explorer/edit/types";

interface Applied {
  summary: ChangeSummary;
  touches: Touch[];
  gtfs: GtfsRowOp[];
  shapes: number[];
  dropped: string[];
  /** Temp tables holding each touch's rows before and after. */
  before: string[];
  after: string[];
}

const sessions = new WeakMap<SqlRunner, EditSession>();

/** The session editing `db`, created on first use. */
export function sessionOf(db: SqlRunner): EditSession {
  let session = sessions.get(db);
  if (!session) sessions.set(db, (session = new EditSession(db)));
  return session;
}

export class EditSession {
  private applied: Applied[] = [];
  private undone: Applied[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  /** One operation at a time: a second undo pressed during the first must
   * not interleave its statements with it on the one connection. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Every apply, undo and redo moves it on. */
  edition = 0;

  constructor(private readonly db: SqlRunner) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getEdition = (): number => this.edition;

  /** The applied changes, oldest first. */
  get changes(): ChangeSummary[] {
    return this.applied.map((a) => a.summary);
  }

  get canUndo(): boolean {
    return this.applied.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Apply `change` to the snapshot, all of it or none. */
  apply(change: EditChange): Promise<ChangeSummary> {
    return this.serial(() => this.applyNow(change));
  }

  /** Undo the newest change: its rows as they were before it. */
  undo(): Promise<ChangeSummary | null> {
    return this.serial(() => this.undoNow());
  }

  /** Redo the change undone last. */
  redo(): Promise<ChangeSummary | null> {
    return this.serial(() => this.redoNow());
  }

  /** Undo every change, newest first, and forget them: the snapshot as the
   * bundle was when the session began or last saved. */
  discard(): Promise<void> {
    return this.serial(async () => {
      for (const entry of [...this.applied].reverse()) await this.restore(entry, entry.before);
      await this.clearNow();
    });
  }

  /** What `measure` finds before and after `sql`, without applying it: run
   * on a second connection in a transaction that is rolled back, so no
   * other query sees the change. Null where the database cannot fork. */
  preview<T>(sql: string[], measure: (db: SqlRunner) => Promise<T>): Promise<{ before: T; after: T } | null> {
    return this.serial(async () => {
      const fork = this.db.fork ? await this.db.fork() : null;
      if (!fork) return null;
      try {
        const before = await measure(fork);
        await fork.exec("BEGIN TRANSACTION");
        try {
          for (const statement of sql) await fork.exec(statement);
          return { before, after: await measure(fork) };
        } finally {
          await fork.exec("ROLLBACK");
        }
      } finally {
        await fork.close();
      }
    });
  }

  /** Forget every change and its copies, after a save or a discard. */
  clear(): Promise<void> {
    return this.serial(() => this.clearNow());
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async applyNow(change: EditChange): Promise<ChangeSummary> {
    const n = this.seq++;
    const before = change.touches.map((_, i) => `_edit_${n}_${i}_before`);
    const after = change.touches.map((_, i) => `_edit_${n}_${i}_after`);
    await this.transaction(async () => {
      for (const [i, t] of change.touches.entries())
        await this.db.exec(`CREATE TEMP TABLE ${before[i]} AS SELECT * FROM ${t.table} WHERE ${t.where}`);
      for (const statement of change.sql) await this.db.exec(statement);
      for (const [i, t] of change.touches.entries())
        await this.db.exec(`CREATE TEMP TABLE ${after[i]} AS SELECT * FROM ${t.table} WHERE ${t.where}`);
    });
    const summary: ChangeSummary = {
      id: change.id,
      kind: change.kind,
      label: change.label,
      impact: change.impact,
      cost: change.cost,
    };
    await this.drop(this.undone.splice(0));
    this.applied.push({
      summary,
      touches: change.touches,
      gtfs: change.gtfs,
      shapes: change.shapes ?? [],
      dropped: change.dropped ?? [],
      before,
      after,
    });
    this.changed();
    return summary;
  }

  private async undoNow(): Promise<ChangeSummary | null> {
    const last = this.applied.at(-1);
    if (!last) return null;
    await this.restore(last, last.before);
    this.undone.push(this.applied.pop() as Applied);
    this.changed();
    return last.summary;
  }

  private async redoNow(): Promise<ChangeSummary | null> {
    const next = this.undone.at(-1);
    if (!next) return null;
    await this.restore(next, next.after);
    this.applied.push(this.undone.pop() as Applied);
    this.changed();
    return next.summary;
  }

  /** The paths the applied changes redrew (shape_idx): drawn from the
   * snapshot, as the bundle's lines are as they were until a save. */
  get redrawnShapes(): number[] {
    return [...new Set(this.applied.flatMap((a) => a.shapes))];
  }

  /** The paths the applied changes took out (shape_id), for the map to
   * leave out of the bundle's lines until a save. */
  get droppedShapeIds(): string[] {
    return [...new Set(this.applied.flatMap((a) => a.dropped))];
  }

  /** Every applied change as bundle rows, in the order they were made. */
  changeset(): GtfsRowOp[] {
    return this.applied.flatMap((a) => a.gtfs);
  }

  private async clearNow(): Promise<void> {
    await this.drop(this.applied.splice(0));
    await this.drop(this.undone.splice(0));
    this.changed();
  }

  private async restore(entry: Applied, copies: string[]): Promise<void> {
    await this.transaction(async () => {
      // In reverse, so a table touched twice ends as its first copy says.
      for (let i = entry.touches.length - 1; i >= 0; i--) {
        const t = entry.touches[i];
        await this.db.exec(`DELETE FROM ${t.table} WHERE ${t.where}`);
        await this.db.exec(`INSERT INTO ${t.table} SELECT * FROM ${copies[i]}`);
      }
    });
  }

  private async transaction(body: () => Promise<void>): Promise<void> {
    await this.db.exec("BEGIN TRANSACTION");
    try {
      await body();
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async drop(entries: Applied[]): Promise<void> {
    for (const e of entries)
      for (const table of [...e.before, ...e.after]) await this.db.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  private changed(): void {
    this.edition++;
    forget(this.db);
    for (const listener of this.listeners) listener();
  }
}
