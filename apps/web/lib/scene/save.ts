// The scene's save loop (3D spec 8.2): an editor's scene goes to the project about a second after the last change,
// one save at a time, the last document winning; a viewer's stays in the browser. Both hold the document the scene
// store edits, `{ scene }`.
import type { DocumentSaver } from "@/lib/style/editor/store";
import type { Scene } from "@/lib/style/generated/types";
import { deepEqual, isObject } from "@/lib/style/json";
import type { StyleIssue } from "@/lib/style/save";

export interface SceneDocument {
  scene: Scene;
}

/** A save's answer: stored, or refused with the validator's issues (nothing stored). Throws when there was no answer
 * the save can trust (offline, a server error). */
export type PutScene = (
  scene: Scene | null
) => Promise<{ stored: boolean; scene: Scene | null; issues: StyleIssue[] }>;

/** The scene as sent: null when no key holds a value (automatic). */
export function sceneToSend(scene: Scene | undefined): Scene | null {
  if (!isObject(scene)) return null;
  const kept = Object.fromEntries(Object.entries(scene).filter(([, v]) => v !== undefined && v !== null));
  return Object.keys(kept).length ? (kept as Scene) : null;
}

/** Waits before the 1st, 2nd, ... retry of a save that got no answer; the last one repeats. */
const RETRY_DELAYS = [5000, 10000, 30000];

abstract class BaseSaver implements DocumentSaver<SceneDocument> {
  protected copy: SceneDocument;
  /** The scene the server holds as far as we know. */
  protected saved: Scene | null;
  private readonly listeners = new Set<() => void>();

  constructor(document: SceneDocument) {
    this.copy = document;
    this.saved = sceneToSend(document.scene);
  }

  get document(): SceneDocument {
    return this.copy;
  }

  get issues(): StyleIssue[] {
    return [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  edit(next: SceneDocument): void {
    this.copy = next;
    this.notify();
  }

  saveNow(): void {}

  /** A scene stored elsewhere (the assistant changed it): the base from now on. It becomes the document unless a
   * change made here is not stored yet, which stays as it is; nothing is sent because of it. */
  receive(scene: Scene | null): void {
    const changedHere = this.unstored();
    this.saved = sceneToSend(scene ?? undefined);
    if (changedHere) return;
    this.copy = { scene: scene ?? {} };
    this.notify();
  }

  /** Whether the document differs from the stored scene. */
  protected unstored(): boolean {
    return !deepEqual(sceneToSend(this.copy.scene), this.saved);
  }

  protected notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** A viewer's scene: changed on screen only, never sent. */
export class LocalSaver extends BaseSaver {}

/** An editor's scene, saved to the project. */
export class SceneSaver extends BaseSaver {
  private readonly put: PutScene;
  private readonly debounceMs: number;
  private sending: Scene | null | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private lastIssues: StyleIssue[] = [];
  /** The scene the server refused last: not sent again until it changes. */
  private refused: Scene | null | undefined = undefined;

  constructor(opts: { document: SceneDocument; put: PutScene; debounceMs?: number }) {
    super(opts.document);
    this.put = opts.put;
    this.debounceMs = opts.debounceMs ?? 1000;
  }

  override get issues(): StyleIssue[] {
    return this.lastIssues;
  }

  /** Whether a change is not stored yet. */
  get pending(): boolean {
    const current = sceneToSend(this.copy.scene);
    return (
      this.sending !== undefined || (!deepEqual(current, this.saved) && !deepEqual(current, this.refused))
    );
  }

  override edit(next: SceneDocument): void {
    super.edit(next);
    this.retries = 0;
    this.schedule(this.debounceMs);
  }

  override saveNow(): void {
    this.schedule(0);
  }

  /**
   * Sends a change still waiting now; resolves once nothing is pending, or after `timeoutMs` (a save that gets no
   * answer keeps retrying meanwhile). Never rejects.
   */
  settle(timeoutMs = 3000): Promise<void> {
    if (!this.pending) return Promise.resolve();
    this.saveNow();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const off = this.subscribe(() => {
        if (!this.pending) finish();
      });
    });
  }

  /** A save under way counts as a change made here: its reply stores the document, not the received scene. */
  protected override unstored(): boolean {
    return this.sending !== undefined || super.unstored();
  }

  /** The page goes away: a change still waiting is sent at once. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending) void this.send();
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send();
    }, ms);
  }

  private async send(): Promise<void> {
    // One save at a time: the reply sends what changed meanwhile.
    if (this.sending !== undefined || !this.pending) return;
    const scene = sceneToSend(this.copy.scene);
    this.sending = scene;
    try {
      const reply = await this.put(scene);
      this.retries = 0;
      this.lastIssues = reply.issues;
      if (reply.stored) {
        this.saved = scene;
        this.refused = undefined;
      } else this.refused = scene;
    } catch {
      this.sending = undefined;
      const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)];
      this.retries += 1;
      this.schedule(delay);
      return;
    }
    this.sending = undefined;
    this.notify();
    if (this.pending) this.schedule(this.debounceMs);
  }
}
