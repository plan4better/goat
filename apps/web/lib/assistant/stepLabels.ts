import type { DynamicToolUIPart } from "ai";

import type { Translate, TranslateOptions } from "@/lib/assistant/chips";
import { WRITE_TOOLS } from "@/lib/assistant/items";

/** An argument longer than this is cut with an ellipsis, so a label stays on one line. */
export const ARGUMENT_CHARS = 40;

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};

/** A non-empty string with its whitespace (line breaks included) collapsed to single spaces. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed || undefined;
};

/** `value` cut to `max` characters, the last of them an ellipsis when something was left out. */
export function clip(value: string, max: number = ARGUMENT_CHARS): string {
  const chars = Array.from(value);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : value;
}

const outputOf = (step: DynamicToolUIPart): Fields => fields((step as { output?: unknown }).output);

/** The `catalog_search` arguments that narrow the result (the others rank, sort or page). */
const SEARCH_FILTERS = [
  "bbox",
  "themes",
  "language",
  "year",
  "license",
  "publisher",
  "type",
  "geographical_code",
  "geometry_type",
  "datetime",
  "nuts",
];

/** Set: not empty, and an array (the regions) with at least one entry. */
const isSet = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";

/** The `core_find` kinds that get a label of their own. */
const CORE_FIND_KINDS = ["project", "dataset", "workflow", "layout"];
/** The groups of a `core_find` result, all of them counted as found. */
const CORE_FIND_GROUPS = ["projects", "datasets", "workflows", "layouts", "templates"];

const filterCount = (input: Fields): number => SEARCH_FILTERS.filter((name) => isSet(input[name])).length;

const layerKey = (project: unknown, layerProjectId: number): string =>
  `${typeof project === "string" ? project : ""}:${layerProjectId}`;

/**
 * The layer names an answer's `project_get_layers` calls returned, by project
 * and layer ID. A layer call that has not returned yet (or failed) names its
 * layer from here. A call without `project_id` stands for the open project.
 */
export type LayerNames = ReadonlyMap<string, string>;

export function layerNames(steps: DynamicToolUIPart[]): LayerNames {
  const names = new Map<string, string>();
  for (const step of steps) {
    if (step.toolName !== "project_get_layers" || step.state !== "output-available") continue;
    const output = outputOf(step);
    const projects = [fields(step.input).project_id, output.project_id];
    for (const layer of Array.isArray(output.layers) ? output.layers : []) {
      const { layer_project_id: id, name } = fields(layer);
      const label = text(name);
      if (typeof id !== "number" || !label) continue;
      projects.forEach((project) => names.set(layerKey(project, id), label));
    }
  }
  return names;
}

/** The layer a tool call reads, quoted by name, or "layer 87152" when no name is known. */
function layerOf(step: DynamicToolUIPart, names: LayerNames, t: Translate): string | undefined {
  const input = fields(step.input);
  const id = typeof input.layer_project_id === "number" ? input.layer_project_id : undefined;
  const name =
    text(outputOf(step).layer) ?? (id === undefined ? undefined : names.get(layerKey(input.project_id, id)));
  if (name) return t("assistant_step_quoted", { value: clip(name) });
  return id === undefined ? undefined : t("assistant_step_layer_id", { id });
}

/** A label's text key and the values it interpolates. */
interface LabelKey {
  key: string;
  values?: TranslateOptions;
}

function labelKey(step: DynamicToolUIPart, names: LayerNames, t: Translate): LabelKey {
  const input = fields(step.input);
  const output = outputOf(step);
  const quoted = (value: string) => t("assistant_step_quoted", { value: clip(value) });
  switch (step.toolName) {
    case "core_find": {
      const query = text(input.query);
      if (!query) break;
      // One kind names it; "any" (or none given) is the general search.
      const kind = text(input.kind);
      const key =
        kind && CORE_FIND_KINDS.includes(kind)
          ? `assistant_tool_core_find_${kind}_query`
          : "assistant_tool_core_find_query";
      return { key, values: { query: quoted(query) } };
    }
    case "core_find_layers": {
      const query = text(input.query);
      if (query) return { key: "assistant_tool_core_find_layers_query", values: { query: quoted(query) } };
      break;
    }
    case "catalog_search": {
      const query = text(input.q);
      const count = filterCount(input);
      if (query && count) {
        return {
          key: "assistant_tool_catalog_search_query_filters",
          values: { query: quoted(query), count },
        };
      }
      if (query) return { key: "assistant_tool_catalog_search_query", values: { query: quoted(query) } };
      if (count) return { key: "assistant_tool_catalog_search_filters", values: { count } };
      break;
    }
    case "catalog_get_record": {
      const title = text(output.title) ?? text(fields(output.properties).title) ?? text(input.item_id);
      if (title) return { key: "assistant_tool_catalog_get_record_title", values: { title: quoted(title) } };
      break;
    }
    case "catalog_find_region": {
      const name = text(input.name);
      if (name) return { key: "assistant_tool_catalog_find_region_name", values: { name: quoted(name) } };
      break;
    }
    case "catalog_suggest_terms": {
      const prefix = text(input.prefix);
      if (prefix) {
        return { key: "assistant_tool_catalog_suggest_terms_prefix", values: { prefix: quoted(prefix) } };
      }
      break;
    }
    case "project_get_layers": {
      const project = text(output.name);
      if (project) {
        return { key: "assistant_tool_project_get_layers_project", values: { project: quoted(project) } };
      }
      break;
    }
    // Named by project: an answer often reads the workflows of several.
    case "project_get_workflows":
    case "project_get_layouts": {
      const project = text(output.project_name);
      if (project) {
        return { key: `assistant_tool_${step.toolName}_project`, values: { project: quoted(project) } };
      }
      break;
    }
    case "project_get_fields": {
      const layer = layerOf(step, names, t);
      if (layer) return { key: "assistant_tool_project_get_fields_layer", values: { layer } };
      break;
    }
    case "project_sample_features": {
      const layer = layerOf(step, names, t);
      if (layer) return { key: "assistant_tool_project_sample_features_layer", values: { layer } };
      break;
    }
    case "project_area_statistics": {
      const layer = layerOf(step, names, t);
      if (layer) return { key: "assistant_tool_project_area_statistics_layer", values: { layer } };
      break;
    }
    case "project_count_features": {
      const layer = layerOf(step, names, t);
      if (layer) {
        const filtered = input.filter !== undefined && input.filter !== null;
        return {
          key: filtered
            ? "assistant_tool_project_count_features_layer_filtered"
            : "assistant_tool_project_count_features_layer",
          values: { layer },
        };
      }
      break;
    }
    case "project_field_statistics": {
      const layer = layerOf(step, names, t);
      const field = text(input.field) ?? text(output.field);
      if (layer && field) {
        return {
          key: "assistant_tool_project_field_statistics_field",
          values: { field: quoted(field), layer },
        };
      }
      break;
    }
    // The workflow the step made, by name; its card follows the step list.
    case "workflow_create":
    case "workflow_create_from_template": {
      const name = text(fields(output.workflow).name);
      if (name) return { key: "assistant_tool_workflow_create_name", values: { name: quoted(name) } };
      break;
    }
    default:
      break;
  }
  return { key: `assistant_tool_${step.toolName}` };
}

/**
 * The line a step shows: what the tool does, with its main argument when the
 * call carries one (the search words, the layer, the field). A call without
 * that argument, and a tool without a main argument, shows the plain label.
 * A step still running says what it is doing (`running`): each label has a
 * present-tense form under `<key>_running`, and a tool without one says
 * "Working…". The values are user and model text: the caller passes a
 * translator that does not escape them (`plainTranslate`), because React
 * renders them as text.
 */
export function stepLabel(step: DynamicToolUIPart, names: LayerNames, t: Translate, running = false): string {
  const { key, values } = labelKey(step, names, t);
  if (running) return t(`${key}_running`, { ...values, defaultValue: t("assistant_step_working") });
  return t(key, { ...values, defaultValue: step.toolName });
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** The number of items a card tool's result shows. */
const shownCount = (output: Fields): number =>
  list(output.groups).reduce<number>((sum, group) => {
    const rows = fields(group);
    return sum + list(rows.items ?? rows.records).length;
  }, 0);

/**
 * What a finished step found, in a few words after its label ("47 datasets",
 * "12 layers · 7 projects"). None for a step whose result shows elsewhere (a
 * suggestion card) or says nothing countable. Counts only: never field values.
 */
export function stepResult(step: DynamicToolUIPart, t: Translate): string | undefined {
  if (step.state !== "output-available") return undefined;
  const output = outputOf(step);
  const count = (key: string, value: number | undefined) =>
    value === undefined ? undefined : value === 0 ? t("assistant_result_none") : t(key, { count: value });
  switch (step.toolName) {
    case "catalog_search":
      return count("assistant_result_datasets", num(output.numberMatched));
    case "catalog_describe":
      return count("assistant_result_datasets", num(output.items));
    case "catalog_find_region": {
      const regions = list(output.regions).map(fields);
      if (regions.length === 1) {
        return [text(regions[0].nuts_id), text(regions[0].name)].filter(Boolean).join(" ") || undefined;
      }
      return count("assistant_result_regions", regions.length);
    }
    case "catalog_suggest_terms":
      return count("assistant_result_terms", list(output.matches).length);
    case "core_find":
      return count(
        "assistant_result_found",
        CORE_FIND_GROUPS.reduce((sum, group) => sum + list(output[group]).length, 0)
      );
    case "core_find_layers": {
      const layers = list(output.layers).map(fields);
      const total = num(output.total) ?? layers.length;
      if (!total) return t("assistant_result_none");
      const projects = new Set(layers.map((layer) => layer.project_id)).size;
      return [
        t("assistant_result_layers", { count: total }),
        // Only the listed layers name their project; a cut list would undercount.
        total === layers.length && projects ? t("assistant_result_projects", { count: projects }) : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "project_get_layers":
      return count("assistant_result_layers", list(output.layers).length);
    case "project_get_fields":
      return count("assistant_result_fields", list(output.fields).length);
    case "project_get_workflows":
      return count("assistant_result_workflows", list(output.workflows).length);
    case "project_get_layouts":
      return count("assistant_result_layouts", list(output.layouts).length);
    case "project_count_features":
      // Withheld under the Restricted policy (a filtered count below the minimum).
      return output.count === null
        ? t("assistant_result_withheld")
        : count("assistant_result_features", num(output.count));
    case "project_area_statistics":
      return count("assistant_result_features", num(output.feature_count));
    case "project_field_statistics":
      return output.kind === "categorical"
        ? count("assistant_result_values", num(output.distinct_count) ?? list(output.values).length)
        : count("assistant_result_features", num(output.feature_count));
    case "project_sample_features":
      return count("assistant_result_features", list(output.features).length);
    case "catalog_show_records":
    case "core_show_items":
      return count("assistant_result_shown", shownCount(output));
    default:
      return undefined;
  }
}

/** The states of a call that has not returned yet. */
const RUNNING_STATES: ReadonlySet<string> = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
]);

/** A call that has not returned yet; under way only while its answer runs. */
export const stepRunning = (step: DynamicToolUIPart): boolean => RUNNING_STATES.has(step.state);

/** One line of the step list: a call, with the rejected attempts it replaced. */
export interface StepRow {
  step: DynamicToolUIPart;
  /** Failed calls of the same tool right before `step`, which succeeded: the model corrected its input. */
  rejected: DynamicToolUIPart[];
}

/**
 * The step list's rows. A failed call that is immediately followed by a
 * successful call of the same tool is folded into that call (the model fixed
 * its input and retried), so the list shows one step. Any other failure
 * stays a row of its own.
 */
export function stepRows(steps: DynamicToolUIPart[]): StepRow[] {
  const rows: StepRow[] = [];
  let failed: DynamicToolUIPart[] = [];
  const flush = () => {
    failed.forEach((step) => rows.push({ step, rejected: [] }));
    failed = [];
  };
  for (const step of steps) {
    if (failed.length && failed[0].toolName !== step.toolName) flush();
    if (step.state === "output-error") {
      failed.push(step);
    } else if (step.state === "output-available" && failed.length) {
      rows.push({ step, rejected: failed });
      failed = [];
    } else {
      flush();
      rows.push({ step, rejected: [] });
    }
  }
  flush();
  return rows;
}

/**
 * The kind each tool's steps count as in a group's summary ("searched the
 * catalog 4 times"); its text is `assistant_steps_<kind>`, with plural forms.
 * Tools that do the same for the user share a kind. A write tool has none: its
 * steps never fold (`staysVisible`). A tool missing here counts as a step.
 */
const STEP_KINDS: Record<string, string> = {
  catalog_search: "catalog_search",
  catalog_get_record: "catalog_record",
  catalog_find_region: "region",
  catalog_suggest_terms: "terms",
  catalog_describe: "catalog_filters",
  catalog_propose_filters: "proposed_filters",
  map_propose_view: "map_view",
  catalog_show_records: "shown",
  core_show_items: "shown",
  core_find: "content_search",
  core_find_layers: "content_search",
  core_whoami: "account",
  core_page_context: "page_context",
  project_get_layers: "layers",
  project_get_fields: "fields",
  project_sample_features: "samples",
  project_count_features: "counts",
  project_field_statistics: "statistics",
  project_area_statistics: "statistics",
  project_group_statistics: "statistics",
  project_get_workflows: "workflows",
  project_get_layouts: "layouts",
  ask_user: "ask",
  skills_load: "instructions",
  workflow_tools: "tools",
  workflow_describe_tool: "tools",
  workflow_find_templates: "templates",
  workflow_check_draft: "draft_check",
  workflow_last_run: "workflow_last_run",
};

/** Every kind a summary may name, with the one for tools the dock does not know. */
export const STEP_KIND_NAMES: readonly string[] = [...new Set([...Object.values(STEP_KINDS), "other"])];

/** The most kinds a summary names; the steps of the others are counted together. */
const SUMMARY_KINDS = 3;

const WRITES: ReadonlySet<string> = new Set<string>(WRITE_TOOLS);

/**
 * The project a project tool reads, as a summary counts it: a call without
 * `project_id`, or with the open project's ID (in any case), reads the open
 * project ("").
 */
const projectOf = (step: DynamicToolUIPart, openProject: string | null): string => {
  const project = text(fields(step.input).project_id)?.toLowerCase();
  return !project || project === openProject?.toLowerCase() ? "" : project;
};

/** The layer a layer tool reads, by project and layer ID. */
const layerOfInput = (step: DynamicToolUIPart, openProject: string | null): string | undefined => {
  const id = fields(step.input).layer_project_id;
  return typeof id === "number" ? `${projectOf(step, openProject)}:${id}` : undefined;
};

/** The inputs that name a statistic's layer; the others shape what it computes. */
const LAYER_INPUTS: ReadonlySet<string> = new Set(["project_id", "layer_project_id"]);

/**
 * `value` as JSON that is the same for equal inputs: object keys in sorted
 * order, null values left out as absent ones are. Arrays keep their order.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Fields)
            .filter(([, entry]) => entry !== null)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : inner
  ) ?? "";

/**
 * What the kinds whose text names a number of things count ("read 6 catalog
 * records", "the fields of 2 layers"): the input that names the thing, so two
 * calls about the same thing count once. A statistic is named by its layer and
 * every other input (field, filter, breaks, method): the same layer with
 * another filter is another result. A call that names nothing counts on its
 * own. Every other kind counts calls, and its text says "N times".
 */
const COUNTED_BY: Record<
  string,
  (step: DynamicToolUIPart, openProject: string | null) => string | undefined
> = {
  catalog_record: (step) => text(fields(step.input).item_id),
  region: (step) => text(fields(step.input).name)?.toLocaleLowerCase(),
  layers: projectOf,
  workflows: projectOf,
  layouts: projectOf,
  fields: layerOfInput,
  statistics: (step, openProject) => {
    const layer = layerOfInput(step, openProject);
    if (layer === undefined) return undefined;
    const shape = Object.entries(fields(step.input)).filter(([name]) => !LAYER_INPUTS.has(name));
    return `${step.toolName}:${layer}:${canonical(Object.fromEntries(shape))}`;
  },
  instructions: (step) => text(fields(step.input).name),
  workflow_last_run: (step) => text(fields(step.input).workflow_id),
};

/**
 * A line of its own next to a group's summary, never folded away: a write, a
 * failure, and once the answer no longer runs, a step the run left without a
 * result (stopped).
 */
export const staysVisible = (row: StepRow, running: boolean): boolean =>
  WRITES.has(row.step.toolName) || row.step.state === "output-error" || (!running && stepRunning(row.step));

/**
 * The summary line of a group of steps: the steps that fold away counted by
 * kind, in the order the kinds first appear ("Searched the catalog 4 times,
 * read 6 catalog records, looked up a region"), at most three kinds and then
 * "and N more steps". The kinds' texts start in lower case; the line starts
 * with a capital. `running`: the answer still runs. `openProject`: the
 * project the answer's tools read when a call names none.
 */
export function groupSummary(
  rows: StepRow[],
  t: Translate,
  running: boolean,
  openProject: string | null = null
): string {
  const counts = new Map<string, { things: Set<string>; steps: number }>();
  for (const row of rows) {
    if (staysVisible(row, running)) continue;
    const kind = STEP_KINDS[row.step.toolName] ?? "other";
    const entry = counts.get(kind) ?? { things: new Set<string>(), steps: 0 };
    entry.things.add(COUNTED_BY[kind]?.(row.step, openProject) ?? row.step.toolCallId);
    entry.steps += 1;
    counts.set(kind, entry);
  }
  const kinds = [...counts];
  const named = kinds
    .slice(0, SUMMARY_KINDS)
    .map(([kind, { things }]) => t(`assistant_steps_${kind}`, { count: things.size }));
  const rest = kinds.slice(SUMMARY_KINDS).reduce((sum, [, { steps }]) => sum + steps, 0);
  const more = rest ? ` ${t("assistant_steps_more", { count: rest })}` : "";
  const line = `${named.join(", ")}${more}`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}
