import { describe, expect, it } from "vitest";

import {
  blockedShipInputs,
  compareTemplateShelves,
  sourceLink,
  stripMarkdown,
  TEMPLATE_SOURCE_ORDER,
  templateBrowserEmptyCopy,
  templateBrowserTitleKey,
  TEMPLATES_EMPTY_SHELF_HINT_KEY,
  templateShelfOf,
  templateSourceLabel,
  templateSourceOf,
} from "@/lib/utils/templates";
import type { Space } from "@/lib/validations/content";
import type { TemplateInput, TemplateRead, TemplateSourceInfo } from "@/lib/validations/template";

const t = (key: string) => key;

const space = (overrides: Partial<Space>): Space => ({
  id: "s1",
  kind: "personal",
  name: "My Content",
  default_role: "viewer",
  my_role: "owner",
  team_id: null,
  organization_id: null,
  ...overrides,
});

const template = (overrides: Partial<TemplateRead>): TemplateRead => ({
  id: "t1",
  name: "Bus network analysis",
  description: null,
  categories: [],
  thumbnail_url: null,
  space_id: "s1",
  folder_id: "f1",
  created_by: null,
  payload_kind: "workflow",
  kinds: ["workflow"],
  inputs: [],
  ships_sample_data: false,
  catalog_status: "none",
  source_ref: {},
  datasets_needing_share: [],
  my_role: "viewer",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const personal = space({});
const team = space({ id: "s2", kind: "team", name: "Marketing", team_id: "team-1" });
const org = space({ id: "s3", kind: "organization", name: "plan4better", organization_id: "org-1" });
// A caller in two teams: every team the user belongs to has its own space,
// so a shelf must be named after the space its template is in.
const planning = space({ id: "s4", kind: "team", name: "Planning", team_id: "team-2" });
const spaces = [personal, team, planning, org];

describe("templateSourceOf", () => {
  const other = { id: "other", name: "Ada" };

  it("reads a catalog-published template as the GOAT shelf", () => {
    expect(templateSourceOf(template({ catalog_status: "published" }), spaces)).toBe("goat");
  });

  it("reads a template by the space it lives in, not by who created it", () => {
    // The backend resolves `source=mine` to the caller's personal spaces and
    // never looks at `created_by`, so a template the caller saved into a team
    // space belongs on the team shelf — the segment that returns it.
    const mine = { id: "me", name: "Majk" };
    expect(templateSourceOf(template({ space_id: "s2", created_by: mine }), spaces)).toBe("team");
    expect(templateSourceOf(template({ space_id: "s1", created_by: other }), spaces)).toBe("mine");
  });

  it("reads a template in a space the caller is not in as shared with them", () => {
    // Reached through a grant on it or on a folder above it — most often
    // someone else's personal space, which must not read as "Mine".
    expect(templateSourceOf(template({ space_id: "someone-elses", created_by: other }), spaces)).toBe(
      "shared"
    );
    expect(templateShelfOf(template({ space_id: "someone-elses" }), spaces)).toEqual({
      key: "shared",
      source: "shared",
    });
  });

  it("reads a template by the kind of space it lives in", () => {
    expect(templateSourceOf(template({ space_id: "s2", created_by: other }), spaces)).toBe("team");
    expect(templateSourceOf(template({ space_id: "s4", created_by: other }), spaces)).toBe("team");
    expect(templateSourceOf(template({ space_id: "s3", created_by: other }), spaces)).toBe("org");
    expect(templateSourceOf(template({ space_id: "s1", created_by: other }), spaces)).toBe("mine");
  });

  it("never reads a space the caller is not in as Mine", () => {
    expect(templateSourceOf(template({ space_id: "s9" }), spaces)).toBe("shared");
  });

  it("orders the groups GOAT first, then the caller's own shelves, then what was shared", () => {
    expect(TEMPLATE_SOURCE_ORDER).toEqual(["goat", "mine", "team", "org", "shared"]);
  });
});

describe("templateShelfOf", () => {
  it("gives each team space a shelf of its own", () => {
    const marketing = templateShelfOf(template({ space_id: "s2" }), spaces);
    const planning = templateShelfOf(template({ space_id: "s4" }), spaces);
    expect(marketing.key).toBe("s2");
    expect(planning.key).toBe("s4");
    expect(templateSourceLabel(marketing, t)).toBe("Marketing");
    expect(templateSourceLabel(planning, t)).toBe("Planning");
  });

  it("keys the GOAT and Mine shelves by their source, with no space", () => {
    const goat = templateShelfOf(template({ catalog_status: "published", space_id: "s2" }), spaces);
    const mine = templateShelfOf(template({ space_id: "s1" }), spaces);
    expect([goat.key, goat.space]).toEqual(["goat", undefined]);
    expect([mine.key, mine.space]).toEqual(["mine", undefined]);
  });
});

describe("templateSourceLabel", () => {
  it("names GOAT and Mine from the source segments", () => {
    expect(templateSourceLabel({ key: "goat", source: "goat" }, t)).toBe("source_goat");
    expect(templateSourceLabel({ key: "mine", source: "mine" }, t)).toBe("source_mine");
  });

  it("names a team and an organization after their own space", () => {
    expect(templateSourceLabel({ key: "s2", source: "team", space: team }, t)).toBe("Marketing");
    expect(templateSourceLabel({ key: "s4", source: "team", space: planning }, t)).toBe("Planning");
    expect(templateSourceLabel({ key: "s3", source: "org", space: org }, t)).toBe("plan4better");
  });

  it("falls back to the segment label for a shelf with no space", () => {
    expect(templateSourceLabel({ key: "team", source: "team" }, t)).toBe("source_team");
    expect(templateSourceLabel({ key: "org", source: "org" }, t)).toBe("source_organization");
  });
});

describe("compareTemplateShelves", () => {
  it("stacks GOAT, then Mine, then each team by name, then the organization", () => {
    const shelves = [
      { key: "s3", source: "org" as const, space: org },
      { key: "s2", source: "team" as const, space: team },
      { key: "mine", source: "mine" as const },
      { key: "s4", source: "team" as const, space: planning },
      { key: "goat", source: "goat" as const },
    ];
    expect([...shelves].sort(compareTemplateShelves).map((shelf) => shelf.key)).toEqual([
      "goat",
      "mine",
      "s2",
      "s4",
      "s3",
    ]);
  });

  it("stacks what others shared last, after the organization", () => {
    const shelves = [
      { key: "shared", source: "shared" as const },
      { key: "s3", source: "org" as const, space: org },
      { key: "mine", source: "mine" as const },
    ];
    expect([...shelves].sort(compareTemplateShelves).map((shelf) => shelf.key)).toEqual(["mine", "s3", "shared"]);
  });
});

describe("templateBrowserEmptyCopy", () => {
  it("says a filter matched nothing, whatever shelf is showing", () => {
    expect(templateBrowserEmptyCopy(true, "mine", "Mine")).toEqual({
      titleKey: "templates_empty_filter_title",
      hintKey: "templates_empty_filter_hint",
    });
  });

  it("names the source when that is what is empty", () => {
    expect(templateBrowserEmptyCopy(false, "team", "Marketing")).toEqual({
      titleKey: "templates_empty_source_title",
      titleVars: { source: "Marketing" },
      hintKey: "templates_empty_source_hint",
    });
  });

  it("falls back to the whole shelf being empty", () => {
    expect(templateBrowserEmptyCopy(false, "all", "source_everyone")).toEqual({
      titleKey: "no_templates_yet_title",
      hintKey: TEMPLATES_EMPTY_SHELF_HINT_KEY,
    });
  });
});

describe("templateBrowserTitleKey", () => {
  it("titles the dialog with the kind being created", () => {
    expect(templateBrowserTitleKey("workflow")).toBe("new_workflow_from_template");
    expect(templateBrowserTitleKey("layout")).toBe("new_layout_from_template");
    expect(templateBrowserTitleKey("dashboard")).toBe("new_dashboard_from_template");
  });

  it("titles the unlocked browser with the shelf itself", () => {
    expect(templateBrowserTitleKey(undefined)).toBe("templates");
  });
});

describe("stripMarkdown", () => {
  it("keeps the words of a heading and drops its hashes", () => {
    expect(stripMarkdown("## What it does\n\nA plain sentence.")).toBe("What it does A plain sentence.");
  });

  it("unwraps bold, italic and strikethrough", () => {
    expect(stripMarkdown("**Bold** and *italic* and ~~gone~~")).toBe("Bold and italic and gone");
  });

  it("keeps a link's label and drops an image entirely", () => {
    expect(stripMarkdown("See [the docs](https://example.com) ![](shot.png)")).toBe("See the docs");
  });

  it("flattens a list into one line", () => {
    expect(stripMarkdown("- one\n- two\n1. three")).toBe("one two three");
  });

  it("drops a code fence and keeps the code as text", () => {
    expect(stripMarkdown("```sql\nSELECT 1\n```")).toBe("SELECT 1");
  });

  it("leaves a snake_case word alone", () => {
    expect(stripMarkdown("Binds layer_id to _the_ input")).toBe("Binds layer_id to the input");
  });

  it("drops a blockquote mark and inline code ticks", () => {
    expect(stripMarkdown("> quoted `code`")).toBe("quoted code");
  });

  it("answers empty for a description that is only syntax", () => {
    expect(stripMarkdown("---")).toBe("");
  });
});

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
    expect(sourceLink(base)).toEqual({ project: `/map/${p}`, payload: `/map/${p}?mode=workflows&workflow=${base.workflow_id}` });
  });

  it("opens the project on the layout for a layout template", () => {
    const layoutId = "00000000-0000-0000-0000-000000000022";
    expect(sourceLink({ ...base, kind: "layout", workflow_id: null, layout_id: layoutId })).toEqual({
      project: `/map/${p}`,
      payload: `/map/${p}?mode=reports&layout=${layoutId}`,
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
