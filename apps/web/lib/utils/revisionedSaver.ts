import { type ChangedBy, ChangedElsewhereError } from "@/lib/api/changedElsewhere";

/** "saved": core has the update. "held": a conflict keeps it back until Keep mine. */
export type SaveOutcome = "saved" | "held";

/** A save core refused because the document changed elsewhere. */
export interface SaveConflict {
  /** The document the refused save was for. */
  id: string;
  /** The revision core holds now: Keep mine saves on top of it. */
  revision: number;
  updatedAt: string | null;
  updatedBy: ChangedBy | null;
}

export interface RevisionedSaverOptions<U> {
  /** Sends one update on `baseRevision` and resolves with the revision core
   * holds afterwards; throws `ChangedElsewhereError` when core refuses it. */
  send: (id: string, update: U, baseRevision: number | undefined) => Promise<number | null | undefined>;
  /** The revision the editor's copy of a document is based on. */
  getRevision: (id: string) => number | undefined;
  setRevision: (id: string, revision: number) => void;
  /** Whether the editor shows the document: only its refused save waits for
   * Reload or Keep mine; any other one fails like any other failure. */
  isOpen: (id: string) => boolean;
  /** A conflict opened, or closed (null) by Keep mine or `dismiss`. */
  onConflict: (conflict: SaveConflict | null) => void;
}

interface Waiting<U> {
  update: U;
  done: Promise<SaveOutcome>;
}

/**
 * Saves an editor's documents one at a time, each on the revision the last
 * save returned, so an editor never conflicts with its own saves. Saves that
 * queue up behind one under way go out as one: every update carries the whole
 * config, so the latest wins, and other fields (a name) are merged in.
 *
 * A save core refuses because the open document changed elsewhere opens a
 * conflict: it and every later save of that document are held, until Keep
 * mine sends them on the revision core holds now, or the editor reloads the
 * stored document and calls `dismiss`.
 */
export class RevisionedSaver<U extends object> {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<string, Waiting<U>>();
  /** Documents with a save sent and not answered yet. */
  private readonly sending = new Set<string>();
  private held: U | null = null;
  private open: SaveConflict | null = null;

  constructor(private readonly options: RevisionedSaverOptions<U>) {}

  get conflict(): SaveConflict | null {
    return this.open;
  }

  /** The revision the editor's copy of a document is based on: the one it
   * was loaded at, or the last save's answer. */
  revisionOf(id: string): number | undefined {
    return this.options.getRevision(id);
  }

  /** The revision of a copy the editor loaded (opened a document, read a list).
   * A known revision that is newer stays: a save's answer can be newer than a
   * list read before it. While a save of the document is under way or
   * waiting, a read changes nothing: those saves were made on the copy the
   * editor showed, not on the one the read brings. */
  seed(id: string, revision: number | null | undefined): void {
    if (typeof revision !== "number") return;
    if (this.sending.has(id) || this.waiting.has(id)) return;
    const known = this.options.getRevision(id);
    if (known === undefined || revision > known) this.options.setRevision(id, revision);
  }

  /** The revision of the stored document the editor just loaded (Reload). */
  setRevision(id: string, revision: number): void {
    this.options.setRevision(id, revision);
  }

  save(id: string, update: U): Promise<SaveOutcome> {
    if (this.open?.id === id) {
      this.hold(update);
      return Promise.resolve("held");
    }
    const queued = this.waiting.get(id);
    if (queued) {
      queued.update = { ...queued.update, ...update };
      return queued.done;
    }
    const entry = { update } as Waiting<U>;
    entry.done = this.chain.then(() => this.send(id, entry));
    this.waiting.set(id, entry);
    this.chain = entry.done.catch(() => undefined);
    return entry.done;
  }

  /** Resolves once the saves sent or queued so far are done, however they
   * ended: a stored version loaded after that is not saved over by them. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Sends what the conflict held, with `latest` on top, on the revision core
   * holds now. Null when no conflict is open. */
  keepMine(latest?: U): Promise<SaveOutcome | null> {
    const conflict = this.open;
    if (!conflict) return Promise.resolve(null);
    const update = { ...this.held, ...latest } as U;
    this.options.setRevision(conflict.id, conflict.revision);
    this.close();
    return this.save(conflict.id, update);
  }

  /** Drops the conflict and what it held: the editor reloaded the stored
   * document, or moved on to another one. */
  dismiss(): void {
    if (this.open) this.close();
  }

  private close(): void {
    this.held = null;
    this.open = null;
    this.options.onConflict(null);
  }

  private hold(update: U): void {
    this.held = { ...this.held, ...update } as U;
  }

  private async send(id: string, entry: Waiting<U>): Promise<SaveOutcome> {
    this.waiting.delete(id);
    if (this.open?.id === id) {
      this.hold(entry.update);
      return "held";
    }
    this.sending.add(id);
    try {
      const revision = await this.options.send(id, entry.update, this.options.getRevision(id));
      if (typeof revision === "number") this.options.setRevision(id, revision);
      return "saved";
    } catch (error) {
      if (!(error instanceof ChangedElsewhereError) || !this.options.isOpen(id)) throw error;
      this.hold(entry.update);
      this.open = { id, revision: error.revision, updatedAt: error.updatedAt, updatedBy: error.updatedBy };
      this.options.onConflict(this.open);
      return "held";
    } finally {
      this.sending.delete(id);
    }
  }
}
