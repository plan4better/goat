import type { PageContext, SourceRef } from "@/lib/assistant/types";

/** The existing labels of the project modes (Map, Workflows, Layouts, Dashboard). */
export const MODE_LABEL_KEYS: Record<string, string> = {
  "project.map": "map",
  "project.workflows": "workflows",
  "project.layouts": "reports",
  "project.dashboard": "builder",
};

/** Interpolation values, plus the `interpolation` setting the dock passes (see `plain`). */
export type TranslateOptions = Record<string, string | number | { escapeValue: boolean }>;
export type Translate = (key: string, options?: TranslateOptions) => string;

/**
 * Options for a translation that interpolates user text (a project or search
 * name). React escapes text itself and the dock never renders translated
 * strings as HTML, so i18next must not escape `&` and `<` a second time.
 */
export const plain = (options: Record<string, string | number> = {}): TranslateOptions => ({
  ...options,
  interpolation: { escapeValue: false },
});

/**
 * The dock's translator: `t` with i18next escaping off for every call, for
 * strings that end up as React text or a toast (see `plain`).
 */
export const plainTranslate =
  (t: (key: string, options: TranslateOptions) => string): Translate =>
  (key, options) =>
    t(key, { ...options, interpolation: { escapeValue: false } });

export interface ContextChip {
  key: string;
  label: string;
  kind: "target" | "page" | "source";
  removable: boolean;
}

/** The context fields a removable chip stands for. */
const FIELDS: Record<string, string[]> = {
  q: ["q"],
  filters: ["facets", "from", "to", "nuts"],
  selected_record_id: ["selected_record_id"],
  selected_layer_project_id: ["selected_layer_project_id"],
  viewport: ["viewport"],
  workflow_id: ["workflow_id"],
  layout_id: ["layout_id"],
};

/** The chips the composer shows for what a message will carry (spec §6.3). */
export function contextChips(
  context: PageContext | null,
  projectName: string | undefined,
  t: Translate
): ContextChip[] {
  if (!context) return [];
  const chips: ContextChip[] = [];
  const page = (key: string, label: string): ContextChip => ({ key, label, kind: "page", removable: true });
  switch (context.surface) {
    case "catalog": {
      chips.push({ key: "surface", label: t("catalog"), kind: "page", removable: false });
      if (context.q) chips.push(page("q", t("assistant_chip_search", { q: context.q })));
      const count =
        Object.values(context.facets ?? {}).reduce((n, values) => n + values.length, 0) +
        (context.from || context.to ? 1 : 0) +
        (context.nuts?.length ? 1 : 0);
      if (count) chips.push(page("filters", t("assistant_chip_filters", { count })));
      if (context.selected_record_id) chips.push(page("selected_record_id", t("assistant_chip_record")));
      break;
    }
    case "project.map":
    case "project.workflows":
    case "project.layouts":
    case "project.dashboard": {
      chips.push({
        key: "surface",
        label: t("assistant_chip_project", {
          name: projectName ?? "",
          mode: t(MODE_LABEL_KEYS[context.surface]),
        }),
        kind: "target",
        removable: false,
      });
      if (context.surface === "project.map") {
        if (context.selected_layer_project_id !== undefined) {
          chips.push(page("selected_layer_project_id", t("assistant_chip_selected_layer")));
        }
        if (context.viewport) chips.push(page("viewport", t("assistant_chip_map_view")));
      }
      if (context.surface === "project.workflows" && context.workflow_id) {
        chips.push(page("workflow_id", t("assistant_chip_workflow")));
      }
      if (context.surface === "project.layouts" && context.layout_id) {
        chips.push(page("layout_id", t("assistant_chip_layout")));
      }
      break;
    }
    default:
      break;
  }
  for (const source of context.sources ?? []) {
    chips.push({
      key: `source:${source.id}`,
      label: t("assistant_chip_source", { name: source.name }),
      kind: "source",
      removable: true,
    });
  }
  return chips;
}

/** The context without the parts whose chips the user removed; null for a plain page. */
export function stripContext(context: PageContext | null, removed: ReadonlySet<string>): PageContext | null {
  if (!context) return null;
  const next: Record<string, unknown> = { ...context };
  removed.forEach((key) => {
    if (key.startsWith("source:")) {
      const id = key.slice("source:".length);
      next.sources = ((next.sources as SourceRef[] | undefined) ?? []).filter((source) => source.id !== id);
    } else {
      (FIELDS[key] ?? []).forEach((field) => delete next[field]);
    }
  });
  if (Array.isArray(next.sources) && next.sources.length === 0) delete next.sources;
  // A page without an adapter and without sources sends no context at all.
  if (next.surface === "none" && !next.sources) return null;
  return next as unknown as PageContext;
}

/** The page's context with the message's @ sources added. */
export function withSources(context: PageContext | null, sources: SourceRef[]): PageContext | null {
  if (!sources.length) return context;
  return { ...(context ?? { surface: "none" }), sources } as PageContext;
}

/** The server refuses a context whose JSON is larger than this many bytes (conversations.py). */
export const MAX_CONTEXT_BYTES = 16384;

/**
 * The size the server measures: its JSON has a space after every `,` and `:`
 * and keeps non-ASCII characters, which take up to four bytes each.
 */
export function contextBytes(context: PageContext): number {
  // Indented output has line breaks only between tokens (inside a string they
  // are escaped), so the breaks after a comma become one space and the rest go.
  const json = JSON.stringify(context, null, 1)
    .replace(/,\n\s*/g, ", ")
    .replace(/\n\s*/g, "");
  return new TextEncoder().encode(json).length;
}

/**
 * The context cut to what the server accepts: facet values are dropped from the
 * end (the last facet's last value first) until the whole body context, sources
 * included, fits. Every other context is returned as it is.
 */
export function fitContext(context: PageContext, maxBytes: number = MAX_CONTEXT_BYTES): PageContext {
  if (context.surface !== "catalog" || !context.facets || contextBytes(context) <= maxBytes) return context;
  const entries = Object.entries(context.facets).map(([key, values]): [string, string[]] => [
    key,
    [...values],
  ]);
  const build = (): PageContext => {
    const { facets: _all, ...rest } = context;
    const kept = entries.filter(([, values]) => values.length);
    return kept.length ? { ...rest, facets: Object.fromEntries(kept) } : rest;
  };
  let next = build();
  while (contextBytes(next) > maxBytes) {
    const last = [...entries].reverse().find(([, values]) => values.length);
    if (!last) break;
    last[1].pop();
    next = build();
  }
  return next;
}
