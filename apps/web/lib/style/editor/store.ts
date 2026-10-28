// The style panel's document (spec 13.1): the browser's copy lives in the StyleSaver, which saves it; this store
// edits it by path, keeps undo history and the class scope, and tells subscribers. Updates share every unchanged
// subtree, so a row that reads an unchanged path gets the same value and does not render again.
import { isIntentEdit } from "@/lib/style/editor/classify";
import { type Path, getIn, setIn } from "@/lib/style/editor/paths";
import type { LayerStyle } from "@/lib/style/generated/types";
import { withRuleIds } from "@/lib/style/ids";
import { deepEqual, isObject } from "@/lib/style/json";
import type { StyleSaver } from "@/lib/style/save";

/** The class the panel edits on its own (spec 5.5): a class of `classify[classify]`, or its `other`. */
export interface ClassScope {
  classify: number;
  key: number | "other";
}

/** A rule whose matching features the panel styles (spec 6): its id, and where it is now. */
export interface RuleScope {
  rule: string;
  index: number;
}

export type Scope = ClassScope | RuleScope;

export const isRuleScope = (scope: Scope | null): scope is RuleScope => scope !== null && "rule" in scope;

export { type Path, getIn, setIn };

const HISTORY = 60;
const COALESCE_MS = 600;

/** `next` with every subtree deep-equal to the one in `prev` replaced by `prev`'s, so identities survive a reply. */
function reuse(prev: unknown, next: unknown): unknown {
  if (prev === next || deepEqual(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) return next.map((item, i) => reuse(prev[i], item));
  if (isObject(prev) && isObject(next))
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, reuse(prev[k], v)]));
  return next;
}

export class EditorStore {
  readonly saver: StyleSaver;
  private current: LayerStyle;
  private seen: LayerStyle;
  private past: LayerStyle[] = [];
  private future: LayerStyle[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;
  private currentScope: Scope | null = null;
  private scopeIds: { classify?: string; key?: string } | null = null;
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;

  constructor(opts: { saver: StyleSaver }) {
    this.saver = opts.saver;
    // Rules without ids get theirs here, with no history entry; the next save carries them.
    this.current = withRuleIds(opts.saver.document);
    this.seen = opts.saver.document;
    this.attach();
  }

  get document(): LayerStyle {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get scope(): Scope | null {
    return this.currentScope;
  }

  get(path: Path): unknown {
    return getIn(this.current, path);
  }

  set(path: Path, value: unknown): void {
    this.update((doc) => setIn(doc, path, value), path);
  }

  /** One edit; consecutive edits with the same key within 600 ms are one undo step. */
  update(fn: (doc: LayerStyle) => LayerStyle, coalesceKey?: string): void {
    const next = fn(this.current);
    if (next === this.current) return;
    const now = Date.now();
    const merges =
      coalesceKey !== undefined && coalesceKey === this.lastKey && now - this.lastAt < COALESCE_MS;
    if (!merges) {
      this.past.push(this.current);
      if (this.past.length > HISTORY) this.past.shift();
    }
    this.future = [];
    this.lastKey = coalesceKey ?? null;
    this.lastAt = now;
    this.replace(next);
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.current);
    this.lastKey = null;
    this.replace(previous);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.lastKey = null;
    this.replace(next);
  }

  setScope(scope: Scope | null): void {
    if (deepEqual(scope, this.currentScope)) return;
    this.currentScope = scope;
    this.scopeIds = scope ? this.idsAt(scope) : null;
    this.notify();
  }

  /** The ids of the scoped classification and class, when they have them (spec 1). */
  private idsAt(scope: Scope): { classify?: string; key?: string } {
    if (isRuleScope(scope)) return {};
    const c = getIn(this.current, `classify.${scope.classify}`);
    const record = scope.key === "other" ? undefined : getIn(c, `classes.${scope.key}`);
    const id = (node: unknown) => (isObject(node) && typeof node.id === "string" ? node.id : undefined);
    return { classify: id(c), key: id(record) };
  }

  /** Stable across calls, so React does not subscribe again on every render. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.attach();
    return () => this.listeners.delete(listener);
  };

  /** Stops following the saver; a later subscriber (the shell mounted again, as React does in development) resumes. */
  dispose(): void {
    this.detach?.();
    this.detach = null;
  }

  private attach(): void {
    if (this.detach) return;
    this.detach = this.saver.subscribe(() => this.fromSaver());
    // Replies that came while detached.
    this.fromSaver();
  }

  private replace(next: LayerStyle): void {
    const before = this.current;
    this.current = next;
    this.seen = next;
    this.saver.edit(next);
    // What the server computes from changed: save now, so the classes come back without the second's wait.
    if (isIntentEdit(before, next)) this.saver.saveNow();
    this.dropLostScope();
    this.notify();
  }

  /** The scope follows its classification and class by id when classifications move or a recompute reorders the
   * classes; a scope whose class is gone (fewer classes, another field) falls back to all features. */
  private dropLostScope(): void {
    const scope = this.currentScope;
    if (!scope) return;
    if (isRuleScope(scope)) {
      const rules = getIn(this.current, "rules");
      const index = Array.isArray(rules) ? rules.findIndex((r) => isObject(r) && r.id === scope.rule) : -1;
      if (index < 0) this.currentScope = null;
      else if (index !== scope.index) this.currentScope = { rule: scope.rule, index };
      return;
    }
    const ids = this.scopeIds ?? {};
    const list = (node: unknown) => (Array.isArray(node) ? node : []);
    const indexOf = (items: unknown[], id: string | undefined, at: number) =>
      id === undefined ? at : items.findIndex((item) => isObject(item) && item.id === id);
    const classify = indexOf(list(getIn(this.current, "classify")), ids.classify, scope.classify);
    const c = getIn(this.current, `classify.${classify}`);
    const key = scope.key === "other" ? "other" : indexOf(list(getIn(c, "classes")), ids.key, scope.key);
    const path = key === "other" ? `classify.${classify}.other` : `classify.${classify}.classes.${key}`;
    if (classify < 0 || key === -1 || !isObject(getIn(this.current, path))) {
      this.currentScope = null;
      this.scopeIds = null;
    } else if (classify !== scope.classify || key !== scope.key) this.currentScope = { classify, key };
  }

  /** A document the saver changed on its own (a reply): the current snapshot, no history entry. */
  private fromSaver(): void {
    const document = this.saver.document;
    if (document === this.seen) return;
    this.seen = document;
    const next = reuse(this.current, withRuleIds(document)) as LayerStyle;
    if (next === this.current) return;
    this.current = next;
    this.dropLostScope();
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}
