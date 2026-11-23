// The page's style editor stores: a store belongs to the page, not to the panel that opened it,
// so closing the panel during a save does not drop the save. A store lives while someone holds it or something is
// pending; every stored reply is handed to the page once (it writes the map cache), and leaving the page with a save
// pending warns and sends it.
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type StyleIssue, StyleSaver, type StyleTransport, bindPageLifecycle } from "@/lib/style/save";

export interface StyleKey {
  projectId: string;
  layerProjectId: number;
  styleId: string;
}

export interface StoredReply {
  document: LayerStyle;
  revision: number;
  issues: StyleIssue[];
}

interface Entry {
  store: EditorStore;
  holders: number;
  revision: number;
  unbind: () => void;
  unsubscribe: () => void;
}

const idOf = (key: StyleKey) => `${key.projectId}/${key.layerProjectId}/${key.styleId}`;

export class StyleStoreRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly createTransport: (key: StyleKey) => StyleTransport;
  private readonly onStored?: (key: StyleKey, reply: StoredReply) => void;
  private readonly renewSession?: () => Promise<boolean>;
  private readonly win?: EventTarget;

  constructor(opts: {
    createTransport: (key: StyleKey) => StyleTransport;
    onStored?: (key: StyleKey, reply: StoredReply) => void;
    renewSession?: () => Promise<boolean>;
    /** Where the page lifecycle events come from; the window by default. */
    win?: EventTarget;
  }) {
    this.createTransport = opts.createTransport;
    this.onStored = opts.onStored;
    this.renewSession = opts.renewSession;
    this.win = opts.win;
  }

  get(key: StyleKey): EditorStore | undefined {
    return this.entries.get(idOf(key))?.store;
  }

  /** The store of a style, created from `initial` the first time; release it when done. */
  acquire(key: StyleKey, initial: { document: LayerStyle; revision: number }): EditorStore {
    const id = idOf(key);
    const existing = this.entries.get(id);
    if (existing) {
      existing.holders += 1;
      return existing.store;
    }
    const saver = new StyleSaver({
      transport: this.createTransport(key),
      document: initial.document,
      revision: initial.revision,
      renewSession: this.renewSession,
    });
    const store = new EditorStore({ saver });
    const entry: Entry = {
      store,
      holders: 1,
      revision: initial.revision,
      unbind: bindPageLifecycle(saver, (this.win ?? window) as Window),
      unsubscribe: () => undefined,
    };
    entry.unsubscribe = saver.subscribe(() => {
      // A reply is handed on once nothing is pending: edits made meanwhile go out first, and their reply is newer.
      if (saver.revision !== entry.revision && !saver.pending) {
        entry.revision = saver.revision;
        this.onStored?.(key, { document: saver.stored, revision: saver.revision, issues: saver.issues });
      }
      if (entry.holders === 0 && !saver.pending) this.drop(id);
    });
    this.entries.set(id, entry);
    this.notify();
    return store;
  }

  /** Lets go of a store; it stays until nothing is pending. */
  release(key: StyleKey): void {
    const id = idOf(key);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.holders = Math.max(0, entry.holders - 1);
    if (entry.holders === 0 && !entry.store.saver.pending) this.drop(id);
  }

  /** Every store held or waiting for a save, by key id. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.unsubscribe();
    entry.unbind();
    entry.store.dispose();
    entry.store.saver.dispose();
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** The project's layers drawn from an open store: those whose active style is the store's (a store of a style that
 * is no longer active waits for its saves without drawing). */
export function editedLayersOf(
  registry: StyleStoreRegistry,
  projectId: string,
  layers: ReadonlyArray<{ id: number; style?: { id?: string } | null }>
): Array<{ key: string; store: EditorStore }> {
  return layers.flatMap((layer) => {
    const styleId = layer.style?.id;
    const store = styleId ? registry.get({ projectId, layerProjectId: layer.id, styleId }) : undefined;
    return store ? [{ key: String(layer.id), store }] : [];
  });
}
