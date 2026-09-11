import { describe, expect, it } from "vitest";

import type { TemplateInput, TemplateSourceInfo } from "@/lib/validations/template";

import { blockedShipInputs, sourceLink } from "@/lib/utils/templates";

const input = (over: Partial<TemplateInput>): TemplateInput => ({
  key: "k",
  label: "L",
  mode: "ask",
  layer_id: null,
  layer_type: null,
  geometry_type: null,
  from_catalog: false,
  ...over,
});

describe("sourceLink", () => {
  const base: TemplateSourceInfo = {
    kind: "workflow",
    project_id: "00000000-0000-0000-0000-0000000000p1".replace("p1", "0001"),
    project_name: "P",
    workflow_id: "00000000-0000-0000-0000-000000000011",
    workflow_name: "W",
    layout_id: null,
    layout_name: null,
    available: true,
  };
  const p = base.project_id;

  it("opens the project on the workflow it was saved from", () => {
    expect(sourceLink(base)).toEqual({ project: `/map/${p}`, payload: `/map/${p}?workflow=${base.workflow_id}` });
  });

  it("opens the project on the layout for a layout template", () => {
    const layoutId = "00000000-0000-0000-0000-000000000022";
    expect(sourceLink({ ...base, kind: "layout", workflow_id: null, layout_id: layoutId })).toEqual({
      project: `/map/${p}`,
      payload: `/map/${p}?layout=${layoutId}`,
    });
  });

  it("has no payload link for a project template", () => {
    expect(sourceLink({ ...base, kind: "project", workflow_id: null }).payload).toBeNull();
  });
});

describe("blockedShipInputs", () => {
  it("names shipped inputs that are not catalog layers, and nothing else", () => {
    const rows = [
      input({ key: "a", mode: "ship", layer_id: "00000000-0000-0000-0000-000000000001", from_catalog: false }),
      input({ key: "b", mode: "ship", layer_id: "00000000-0000-0000-0000-000000000002", from_catalog: true }),
      input({ key: "c", mode: "ask" }),
    ];
    expect(blockedShipInputs(rows).map((r) => r.key)).toEqual(["a"]);
  });
});
