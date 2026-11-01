import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";
import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { issueText, refusalSummary, stepName } from "@/lib/utils/workflowIssueText";
import type { WorkflowNode } from "@/lib/validations/workflow";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

/**
 * Every code processes reports, with the params it sends (contract §2 of the
 * workflow checks), plus `run_failed`, which the editor builds from a failed
 * run. Written out rather than derived: it is the contract between the
 * server's checks and these texts.
 */
const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  config_not_object: {},
  nodes_not_list: {},
  edges_not_list: {},
  node_without_id: { index: 2 },
  node_unknown_type: { type: "chart" },
  node_duplicate_id: { id: "tool-1" },
  edge_without_ends: { index: 0 },
  tool_missing: { step: "Tool" },
  tool_removed: { step: "Old tool", tool: "old_tool" },
  input_not_connected: { step: "Buffer", label: "Input layer" },
  opportunity_not_connected: { step: "Heatmap" },
  setting_required: { step: "Buffer", label: "Distance" },
  setting_invalid: { step: "Buffer", label: "Distance", reason: "Input should be greater than 0" },
  field_not_in_layer: { step: "Join", label: "Join field", field_name: "school_id" },
  layer_not_chosen: { step: "Dataset" },
  layer_not_readable: { step: "Schools" },
  if_input_count: { step: "Conditional", count: 2 },
  if_condition_incomplete: { step: "Conditional" },
  export_name_missing: { step: "Save as dataset" },
  export_target_missing: { step: "Save as dataset" },
  export_not_connected: { step: "Save as dataset" },
  loop: { steps: ["Buffer", "Clip"] },
  connection_to_removed_step: {},
  connection_to_unknown_input: { step: "Clip", input: "overlay_layer_id" },
  variable_undefined: { step: "Buffer", variable: "distance" },
  destination_not_writable: {},
  step_not_connected: { step: "Buffer" },
  field_maybe_missing: { step: "Join", label: "Join field", field_name: "school_id" },
  field_renamed_by_join: {
    step: "Aggregate Points",
    label: "Group Fields",
    field_name: "district",
    joined_field: "join_district",
  },
  field_not_produced: {
    step: "Join",
    label: "Match Fields · Target Field",
    field_name: "school_id",
    fields: ["origin", "destination", "travel_cost"],
  },
  too_many_destinations: { step: "Heatmap Closest Average", features: 934847, limit: 50000 },
  run_failed: { step: "Buffer", error: "Column population not found" },
};

const OTHER_KEYS = [
  "workflow_issues_workflow",
  "workflow_damaged_title",
  "workflow_damaged_body",
  "workflow_not_saved",
  "workflow_save_retry",
  "workflow_empty_title",
  "workflow_empty_body",
  "workflow_empty_new",
  "workflow_empty_template",
  "workflow_empty_learn",
];

const issue = (
  code: string,
  params: Record<string, unknown> = SAMPLE_PARAMS[code] ?? {},
  field: string | null = "distance"
): WorkflowIssue => ({
  code,
  level: "error",
  node_ids: ["tool-1"],
  field,
  message: `English message for ${code}.`,
  params,
  source: "check",
});

const node = (data: Record<string, unknown>): WorkflowNode =>
  ({ id: "n-1", type: data.type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;

const issueKeys = (texts: Record<string, unknown>) =>
  Object.keys(texts)
    .filter((key) => key.startsWith("workflow_issue"))
    .sort();

describe("workflow issue texts", () => {
  it.each(["en", "de"] as const)("%s has a text for every issue code", (language) => {
    const t = commonT(language);
    for (const code of Object.keys(SAMPLE_PARAMS)) {
      const text = issueText(t, issue(code));
      expect(text, code).not.toBe(`English message for ${code}.`);
      expect(text, code).not.toContain("{{");
      expect(text, code).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("has the same issue keys in English and German", () => {
    expect(issueKeys(de as unknown as Record<string, unknown>)).toEqual(
      issueKeys(en as unknown as Record<string, unknown>)
    );
  });

  it("has the notice and empty state texts in both languages", () => {
    for (const key of OTHER_KEYS) {
      expect(typeof (en as unknown as Record<string, unknown>)[key], key).toBe("string");
      expect(typeof (de as unknown as Record<string, unknown>)[key], key).toBe("string");
    }
  });

  it("fills in the params", () => {
    expect(issueText(commonT("en"), issue("field_not_in_layer"))).toBe(
      "Join field uses the field school_id, which the input dataset does not have."
    );
  });

  it("names the field a join renamed", () => {
    expect(issueText(commonT("en"), issue("field_renamed_by_join"))).toBe(
      "Group Fields uses the field district, which the step before does not produce: the join names it join_district."
    );
  });

  it("lists the fields of the step before a join", () => {
    expect(issueText(commonT("en"), issue("field_not_produced"))).toBe(
      "Match Fields · Target Field uses the field school_id, which the step before does not produce. It gives: origin, destination, travel_cost."
    );
    expect(issueText(commonT("de"), issue("field_not_produced"))).toBe(
      "Match Fields · Target Field verwendet das Feld school_id, das der vorherige Schritt nicht erzeugt. Er erzeugt: origin, destination, travel_cost."
    );
  });

  it("formats the destination counts of a heatmap", () => {
    expect(issueText(commonT("en"), issue("too_many_destinations"))).toBe(
      "The opportunity layers without a filter have 934,847 features together, more than the 50,000 this heatmap takes. Limit them to an area or with a filter in their dataset steps."
    );
    expect(issueText(commonT("de"), issue("too_many_destinations"))).toBe(
      "Die Ziel-Layer ohne Filter haben zusammen 934.847 Objekte, mehr als die 50.000, die diese Heatmap verarbeitet. Beschränken Sie sie in ihren Datensatz-Schritten auf ein Gebiet oder mit einem Filter."
    );
  });

  it("names the steps of a loop", () => {
    expect(issueText(commonT("en"), issue("loop"))).toBe("These steps form a loop: Buffer, Clip.");
  });

  it("counts the connections of a condition", () => {
    const t = commonT("en");
    expect(issueText(t, issue("if_input_count", { step: "Conditional", count: 0 }))).toBe(
      "Nothing is connected to the condition. It needs exactly one incoming connection."
    );
    expect(issueText(t, issue("if_input_count", { step: "Conditional", count: 3 }))).toBe(
      "The condition has 3 incoming connections. It needs exactly one."
    );
    expect(issueText(commonT("de"), issue("if_input_count", { step: "Bedingung", count: 3 }))).toBe(
      "Die Bedingung hat 3 eingehende Verbindungen. Sie braucht genau eine."
    );
  });

  it("words a rejected combination of settings for the whole step", () => {
    const rejected = issue(
      "setting_invalid",
      { step: "Buffer", label: "Buffer", reason: "Choose a distance" },
      null
    );
    expect(issueText(commonT("en"), rejected)).toBe(
      "The settings of this step are not accepted: Choose a distance"
    );
  });

  it("does not escape names a person typed", () => {
    expect(
      issueText(commonT("en"), issue("setting_required", { step: "Buffer", label: "Roads & <paths>" }))
    ).toBe("Roads & <paths> needs a value.");
  });

  it("shows the server's English message for a code it has no text for", () => {
    const unknown = { ...issue("brand_new_check", {}), message: "Something new is wrong." };
    expect(issueText(commonT("de"), unknown)).toBe("Something new is wrong.");
  });

  it("counts issues for the chip and the Run tooltip", () => {
    const t = commonT("en");
    expect(t("workflow_issues_count", { count: 1 })).toBe("1 issue");
    expect(t("workflow_issues_count", { count: 4 })).toBe("4 issues");
    expect(t("workflow_run_fix_issues", { count: 2 })).toBe("Fix 2 issues to run");
    expect(commonT("de")("workflow_issues_count", { count: 4 })).toBe("4 Probleme");
  });
});

describe("stepName", () => {
  it("names a tool step by its tool, as the canvas does", () => {
    const buffer = node({ type: "tool", processId: "buffer", label: "buffer", config: {} });
    expect(stepName(commonT("en"), buffer)).toBe("Buffer");
    expect(stepName(commonT("de"), buffer)).toBe("Puffer");
  });

  it("names other steps by their label, or by their kind without one", () => {
    expect(stepName(commonT("en"), node({ type: "dataset", label: "Schools" }))).toBe("Schools");
    expect(stepName(commonT("en"), node({ type: "if", label: "" }))).toBe("Conditional");
    expect(stepName(commonT("en"), node({ type: "export", label: "" }))).toBe("Save as dataset");
  });
});

describe("refusalSummary", () => {
  it("leads each blocking issue with its step and leaves warnings out", () => {
    const buffer = {
      ...node({ type: "tool", processId: "buffer", label: "buffer", config: {} }),
      id: "tool-1",
    };
    const summary = refusalSummary(
      commonT("en"),
      [
        issue("setting_required"),
        { ...issue("step_not_connected"), level: "warning" },
        { ...issue("destination_not_writable"), node_ids: [], field: null },
      ],
      [buffer]
    );
    expect(summary).toBe("Buffer: Distance needs a value. You cannot run workflows in this project.");
  });
});
