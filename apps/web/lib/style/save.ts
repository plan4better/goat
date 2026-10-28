// The browser's save loop for a style document (spec section 13.1). The panel edits its own copy and the map
// redraws from it at once; about a second after the last change the whole copy goes to the server with the
// revision it is based on. One save is in flight at a time, edits made meanwhile are re-applied on the reply, and
// failures keep the copy and retry. The transport is the server's endpoint (core), passed in.
import type { LayerStyle } from "@/lib/style/generated/types";
import { clone, deepEqual } from "@/lib/style/json";
import { apply, diff } from "@/lib/style/merge";

export interface StyleIssue {
  level: "error" | "warning" | "info" | "damaged";
  code: string;
  path: string;
  message: string;
  /** One operation of the spec's closed fix list (section 11). */
  fix?: {
    op: "set" | "remove" | "retarget" | "use_field" | "round";
    path: string;
    value?: unknown;
    target?: string;
    field?: string;
  };
  /** Up to 20 valid choices for the value at `path`. */
  allowed?: unknown[];
}

/** A save's answer; `status` 0 means no answer at all (offline, timeout, dropped connection). */
export type SaveResult =
  | { ok: true; document: LayerStyle; revision: number; issues: StyleIssue[] }
  | { ok: false; status: number; code?: string };

export interface StyleTransport {
  save(body: { base_rev: number; document: LayerStyle }, opts: { keepalive: boolean }): Promise<SaveResult>;
  /** The stored style; a transport that checks it adds its issues and whether its computed values are current. */
  load(): Promise<{ document: LayerStyle; revision: number; issues?: StyleIssue[]; stale?: boolean }>;
}

export type SaveStatus = "saved" | "saving" | "retrying" | "offline" | "stopped";
export type StopReason = "forbidden" | "deleted" | "base_too_old";

interface SaverOptions {
  transport: StyleTransport;
  document: LayerStyle;
  revision: number;
  debounceMs?: number;
  /** Renews the session after a 401; false when that needs a new sign-in (the save waits for `retryNow`). */
  renewSession?: () => Promise<boolean>;
  onStop?: (reason: StopReason) => void;
}

/** Waits before the 1st, 2nd, ... retry; the last one repeats. */
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 30000];

const retryable = (status: number) => status === 0 || status === 429 || status >= 500;

export class StyleSaver {
  private readonly transport: StyleTransport;
  private readonly debounceMs: number;
  private readonly renewSession?: () => Promise<boolean>;
  private readonly onStop?: (reason: StopReason) => void;
  private copy: LayerStyle;
  /** The last document the server stored for us: what our copy's changes are taken against. */
  private saved: LayerStyle;
  private rev: number;
  private inFlight: LayerStyle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private state: SaveStatus = "saved";
  private stopped: StopReason | null = null;
  private lastIssues: StyleIssue[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(opts: SaverOptions) {
    this.transport = opts.transport;
    this.debounceMs = opts.debounceMs ?? 1000;
    this.renewSession = opts.renewSession;
    this.onStop = opts.onStop;
    this.copy = opts.document;
    this.saved = opts.document;
    this.rev = opts.revision;
  }

  get document(): LayerStyle {
    return this.copy;
  }

  get revision(): number {
    return this.rev;
  }

  get status(): SaveStatus {
    return this.state;
  }

  get issues(): StyleIssue[] {
    return this.lastIssues;
  }

  /** Why saving stopped, while the status is "stopped". */
  get stopReason(): StopReason | null {
    return this.state === "stopped" ? this.stopped : null;
  }

  /** The last document the server stored: what the copy's changes are taken against. */
  get stored(): LayerStyle {
    return this.saved;
  }

  /** Whether something is not stored yet: a change not sent, or a save not answered. */
  get pending(): boolean {
    return this.inFlight !== null || !deepEqual(this.copy, this.saved);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The panel's new copy. */
  edit(next: LayerStyle): void {
    this.copy = next;
    if (this.state === "stopped") return this.notify();
    // After an answer no retry fixes (nothing scheduled, nothing in flight), the next edit tries again.
    if (this.state === "retrying" && this.timer === null && this.inFlight === null) this.state = "saving";
    if (this.state === "saved") this.state = "saving";
    if (this.state === "saving") this.schedule(this.debounceMs);
    this.notify();
  }

  /** Sends a pending change now, with `keepalive` so it survives the page going away. */
  flush(): void {
    if (this.state === "stopped" || !this.pending) return;
    this.clearTimer();
    if (this.inFlight) {
      // The answer to this extra copy is not awaited: the page is going away.
      void this.transport.save({ base_rev: this.rev, document: clone(this.copy) }, { keepalive: true });
      return;
    }
    void this.send(true);
  }

  /** Sends a pending change now (a change whose result comes from the server, such as new classes); while a save is
   * in flight it goes right after the reply. */
  saveNow(): void {
    if (this.state === "stopped") return;
    this.clearTimer();
    if (!this.inFlight) void this.send(false);
  }

  /** Retries a failed save at once (back online, signed in again). */
  retryNow(): void {
    if (this.state !== "retrying" && this.state !== "offline") return;
    this.clearTimer();
    void this.send(false);
  }

  /** A newer stored style that came another way (the panel's opening check recomputed it): the new base, with the
   * edits made meanwhile on top. An older one changes nothing. */
  receive(stored: { document: LayerStyle; revision: number; issues?: StyleIssue[] }): void {
    if (
      stored.revision < this.rev ||
      (stored.revision === this.rev && deepEqual(stored.document, this.saved))
    )
      return;
    const mine = diff(this.saved, this.copy);
    this.saved = stored.document;
    this.rev = stored.revision;
    if (stored.issues) this.lastIssues = stored.issues;
    this.copy = mine.length ? apply(stored.document, mine).doc : stored.document;
    if (this.state === "saved" && this.pending) {
      this.state = "saving";
      this.schedule(this.debounceMs);
    }
    this.notify();
  }

  /** After `base_too_old`: apply our changes to the current style, or take the current style. */
  async resolveBaseTooOld(choice: "apply" | "discard"): Promise<void> {
    const current = await this.transport.load();
    const mine = choice === "apply" ? diff(this.saved, this.copy) : [];
    this.saved = current.document;
    this.rev = current.revision;
    this.copy = apply(current.document, mine).doc;
    this.retries = 0;
    this.state = "saved";
    if (this.pending) {
      this.state = "saving";
      void this.send(false);
    }
    this.notify();
  }

  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send(false);
    }, delay);
  }

  private async send(keepalive: boolean): Promise<void> {
    if (this.inFlight || this.state === "stopped") return;
    if (deepEqual(this.copy, this.saved)) {
      this.state = "saved";
      this.notify();
      return;
    }
    const sent = clone(this.copy);
    this.inFlight = sent;
    this.state = "saving";
    this.notify();
    let result: SaveResult;
    try {
      result = await this.transport.save({ base_rev: this.rev, document: sent }, { keepalive });
    } catch {
      // A rejected request (fetch fails on a dropped connection) is no answer at all.
      result = { ok: false, status: 0 };
    }
    this.inFlight = null;
    if (result.ok) this.onStored(sent, result);
    else await this.failed(result);
    this.notify();
  }

  private onStored(sent: LayerStyle, result: Extract<SaveResult, { ok: true }>): void {
    this.retries = 0;
    this.rev = result.revision;
    this.lastIssues = result.issues;
    this.saved = result.document;
    if (deepEqual(this.copy, sent)) {
      this.copy = result.document;
      this.state = "saved";
      return;
    }
    // Edits made while the save was in flight go on top of the reply and out with the next save; sending the old
    // copy instead would undo a newer change made elsewhere.
    this.copy = apply(result.document, diff(sent, this.copy)).doc;
    this.state = "saving";
    if (this.timer === null) void this.send(false);
  }

  private async failed(result: Extract<SaveResult, { ok: false }>): Promise<void> {
    if (result.status === 401) {
      this.state = "retrying";
      if (!this.renewSession || !(await this.renewSession())) return;
      // The first renewal retries at once; a renewed session refused again waits like any failed save.
      if (this.retries === 0) void this.send(false);
      else this.schedule(RETRY_DELAYS[Math.min(this.retries - 1, RETRY_DELAYS.length - 1)]);
      this.retries += 1;
      return;
    }
    const reason: StopReason | null =
      result.status === 403
        ? "forbidden"
        : result.status === 404
          ? "deleted"
          : result.status === 409 && result.code === "base_too_old"
            ? "base_too_old"
            : null;
    if (reason) {
      this.clearTimer();
      this.state = "stopped";
      this.stopped = reason;
      this.onStop?.(reason);
      return;
    }
    if (retryable(result.status) || result.status === 409) {
      this.state = typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "retrying";
      this.schedule(RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)]);
      this.retries += 1;
      return;
    }
    // Any other answer: the copy stays, the next edit (or retryNow) tries again.
    this.state = "retrying";
  }
}

/** Warns before leaving while a change is pending, sends it on `pagehide`, retries when back online. */
export function bindPageLifecycle(saver: StyleSaver, win: Window = window): () => void {
  const beforeUnload = (event: Event) => {
    if (!saver.pending) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
  const pageHide = () => saver.flush();
  const online = () => saver.retryNow();
  win.addEventListener("beforeunload", beforeUnload);
  win.addEventListener("pagehide", pageHide);
  win.addEventListener("online", online);
  return () => {
    win.removeEventListener("beforeunload", beforeUnload);
    win.removeEventListener("pagehide", pageHide);
    win.removeEventListener("online", online);
  };
}
