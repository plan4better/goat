import { describe, expect, it } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import {
  audienceOf,
  folderLocationLabel,
  folderPath,
  homeFolderOf,
  iconFor,
  iconForType,
  markKindOf,
  restrictedAncestorName,
  sectionOf,
  typeLabelKey,
  typeToneFor,
} from "@/lib/utils/content";
import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";

const item = (overrides: Partial<ContentItem>): ContentItem => ({
  type: "layer",
  id: "i1",
  name: "Item",
  space_id: "s1",
  folder_id: null,
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  shared_with: null,
  thumbnail_url: null,
  layer_type: null,
  feature_layer_geometry_type: null,
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
  template_payload_kind: null,
  template_kinds: [],
  template_catalog_status: null,
  template_ships_sample_data: false,
  ...overrides,
});

const folder = (overrides: Partial<Folder>): Folder => ({
  name: "Folder",
  id: "f1",
  parent_id: null,
  depth: 0,
  is_owned: true,
  restricted: false,
  ...overrides,
});

const space = (overrides: Partial<Space>): Space => ({
  id: "s1",
  kind: "personal",
  name: "Personal",
  default_role: "editor",
  ...overrides,
});

describe("sectionOf", () => {
  it("puts folders in the folders section", () => {
    expect(sectionOf(item({ type: "folder" }))).toBe("folders");
  });

  it("puts a shortcut in the shortcuts section regardless of its underlying type", () => {
    expect(sectionOf(item({ type: "layer", is_shortcut: true }))).toBe("shortcuts");
    expect(sectionOf(item({ type: "project", is_shortcut: true }))).toBe("shortcuts");
  });

  it("puts projects in the projects section", () => {
    expect(sectionOf(item({ type: "project" }))).toBe("projects");
  });

  it("puts layers and bundles in the datasets section", () => {
    expect(sectionOf(item({ type: "layer" }))).toBe("datasets");
    expect(sectionOf(item({ type: "bundle" }))).toBe("datasets");
  });

  it("puts templates in their own section", () => {
    expect(sectionOf(item({ type: "template" }))).toBe("templates");
  });

  it("puts a template shortcut in the shortcuts section, not templates", () => {
    expect(sectionOf(item({ type: "template", is_shortcut: true }))).toBe("shortcuts");
  });
});

describe("typeLabelKey", () => {
  it("labels a folder", () => {
    expect(typeLabelKey(item({ type: "folder" }))).toBe("folder_label");
  });

  it("labels a project", () => {
    expect(typeLabelKey(item({ type: "project" }))).toBe("project");
  });

  it("labels a bundle", () => {
    expect(typeLabelKey(item({ type: "bundle" }))).toBe("bundle");
  });

  it("labels a template", () => {
    expect(typeLabelKey(item({ type: "template" }))).toBe("template");
  });

  it("labels a layer by its layer_type", () => {
    expect(typeLabelKey(item({ type: "layer", layer_type: "feature" }))).toBe("feature_layer");
    expect(typeLabelKey(item({ type: "layer", layer_type: "raster" }))).toBe("raster_layer");
    expect(typeLabelKey(item({ type: "layer", layer_type: "table" }))).toBe("table_layer");
  });
});

describe("iconFor", () => {
  it("uses a distinct icon for folders, projects, and bundles", () => {
    expect(iconFor(item({ type: "folder" }))).toBe(ICON_NAME.FOLDER);
    expect(iconFor(item({ type: "project" }))).toBe(ICON_NAME.MAP);
    expect(iconFor(item({ type: "bundle" }))).toBe(ICON_NAME.LAYERS);
  });

  it("uses a table/raster icon for those layer types", () => {
    expect(iconFor(item({ type: "layer", layer_type: "table" }))).toBe(ICON_NAME.TABLE);
    expect(iconFor(item({ type: "layer", layer_type: "raster" }))).toBe(ICON_NAME.IMAGE);
  });

  it("uses a geometry-specific icon for feature layers", () => {
    expect(
      iconFor(item({ type: "layer", layer_type: "feature", feature_layer_geometry_type: "point" }))
    ).toBe(ICON_NAME.POINT_FEATURE);
    expect(iconFor(item({ type: "layer", layer_type: "feature", feature_layer_geometry_type: "line" }))).toBe(
      ICON_NAME.LINE_FEATURE
    );
    expect(
      iconFor(item({ type: "layer", layer_type: "feature", feature_layer_geometry_type: "polygon" }))
    ).toBe(ICON_NAME.POLYGON_FEATURE);
  });
});

describe("homeFolderOf", () => {
  it("picks the folder named home, with no parent, owned by the space", () => {
    const folders = [
      folder({ id: "wrong-space", name: "home", parent_id: null, space_id: "other" }),
      folder({ id: "not-home", name: "Docs", parent_id: null, space_id: "s1" }),
      folder({ id: "nested-home", name: "home", parent_id: "not-home", space_id: "s1" }),
      folder({ id: "home1", name: "home", parent_id: null, space_id: "s1" }),
    ];
    expect(homeFolderOf(folders, "s1")?.id).toBe("home1");
  });

  it("returns undefined when there is no matching home folder", () => {
    expect(homeFolderOf([], "s1")).toBeUndefined();
  });
});

describe("folderPath", () => {
  it("walks parent_id up to the root, root first", () => {
    const folders = [
      folder({ id: "root", name: "home", parent_id: null }),
      folder({ id: "mid", name: "Reports", parent_id: "root" }),
      folder({ id: "leaf", name: "2026", parent_id: "mid" }),
    ];
    expect(folderPath(folders, "leaf").map((f) => f.id)).toEqual(["root", "mid", "leaf"]);
  });

  it("stops on a missing parent instead of throwing", () => {
    const folders = [folder({ id: "orphan", name: "Orphan", parent_id: "does-not-exist" })];
    expect(folderPath(folders, "orphan").map((f) => f.id)).toEqual(["orphan"]);
  });

  it("is empty for a null folder id", () => {
    expect(folderPath([], null)).toEqual([]);
  });
});

describe("audienceOf", () => {
  const teamSpace = space({ id: "t1", kind: "team", name: "Team" });
  const personalSpace = space({ id: "s1", kind: "personal", name: "Personal" });

  it("is org when shared with an organization, reading Shared and naming it on hover", () => {
    const result = audienceOf(
      item({
        shared_with: {
          organizations: [{ role: "viewer", id: "o1", name: "Plan4Better" }],
          teams: [{ role: "viewer", id: "t2", name: "Admins" }],
          users: [],
        },
      }),
      teamSpace
    );
    expect(result.kind).toBe("org");
    expect(result.labelKey).toBe("shared");
    expect(result.sharedWithNames).toEqual(["Plan4Better", "Admins"]);
  });

  it("is shared when shared with a team", () => {
    const result = audienceOf(
      item({ shared_with: { organizations: [], teams: [{ role: "viewer", id: "t2" }], users: [] } }),
      teamSpace
    );
    expect(result.kind).toBe("shared");
  });

  it("is shared when shared with a user", () => {
    const result = audienceOf(
      item({ shared_with: { organizations: [], teams: [], users: [{ role: "viewer", id: "u1" }] } }),
      teamSpace
    );
    expect(result.kind).toBe("shared");
  });

  it("is private when not shared and the space is personal", () => {
    const result = audienceOf(item({ shared_with: null }), personalSpace);
    expect(result.kind).toBe("private");
  });

  it("is space when not shared and the space is a team/org space", () => {
    const result = audienceOf(item({ shared_with: null }), teamSpace);
    expect(result.kind).toBe("space");
  });

  it("lets a published project win over every grant", () => {
    const result = audienceOf(
      item({
        is_public: true,
        shared_with: { organizations: [{ role: "viewer", id: "o1" }], teams: [], users: [] },
      }),
      personalSpace
    );
    expect(result.kind).toBe("public");
    expect(result.labelKey).toBe("public");
  });

  it("is restricted when the item itself is restricted, ahead of org/shared/private/space", () => {
    const result = audienceOf(
      item({
        restricted: true,
        shared_with: { organizations: [{ role: "viewer", id: "o1" }], teams: [], users: [] },
      }),
      teamSpace
    );
    expect(result.kind).toBe("restricted");
    expect(result.labelKey).toBe("restricted");
    expect(result.icon).toBe(ICON_NAME.LOCK);
  });

  it("is restricted when only inherited from an ancestor folder", () => {
    const result = audienceOf(item({ restricted_inherited: true }), personalSpace);
    expect(result.kind).toBe("restricted");
  });

  it("lets a published project win over restricted", () => {
    const result = audienceOf(item({ restricted: true, is_public: true }), teamSpace);
    expect(result.kind).toBe("public");
  });

  it("is private for an unpublished item in a personal space", () => {
    const result = audienceOf(item({ is_public: false, shared_with: null }), personalSpace);
    expect(result.kind).toBe("private");
    expect(result.labelKey).toBe("private_content");
  });
});

describe("restrictedAncestorName", () => {
  it("picks the nearest restricted ancestor, closest to the item first", () => {
    const folders = [
      folder({ id: "root", name: "Root", parent_id: null, restricted: true }),
      folder({ id: "mid", name: "Reports", parent_id: "root", restricted: true }),
      folder({ id: "leaf", name: "2026", parent_id: "mid", restricted: false }),
    ];
    expect(restrictedAncestorName(folders, "leaf")).toBe("Reports");
  });

  it("falls back to the folder passed itself when no folder in the chain carries the flag", () => {
    const folders = [
      folder({ id: "root", name: "Root", parent_id: null }),
      folder({ id: "leaf", name: "2026", parent_id: "root" }),
    ];
    expect(restrictedAncestorName(folders, "leaf")).toBe("2026");
  });

  it("is undefined for a null folder id", () => {
    expect(restrictedAncestorName([], null)).toBeUndefined();
  });
});

describe("typeToneFor", () => {
  it("gives folders and projects the primary accent", () => {
    expect(typeToneFor(item({ type: "folder" }))).toBe("primary");
    expect(typeToneFor(item({ type: "project" }))).toBe("primary");
  });

  // `success` is a status colour, and its green sat too close to the brand
  // mint a project already carries — a bundle takes the darker accent.
  it("gives a bundle the dark primary accent, not a second green", () => {
    expect(typeToneFor(item({ type: "bundle" }))).toBe("primary-dark");
    expect(typeToneFor(item({ type: "bundle" }))).not.toBe(typeToneFor(item({ type: "project" })));
  });

  it("splits layers by layer_type", () => {
    expect(typeToneFor(item({ type: "layer", layer_type: "raster" }))).toBe("warning");
    expect(typeToneFor(item({ type: "layer", layer_type: "table" }))).toBe("secondary");
    expect(typeToneFor(item({ type: "layer", layer_type: "feature" }))).toBe("info");
  });

  it("gives a template the secondary tone", () => {
    expect(typeToneFor(item({ type: "template" }))).toBe("secondary");
  });

  it("falls back to the feature tone for a layer with no layer_type", () => {
    expect(typeToneFor(item({ type: "layer", layer_type: null }))).toBe("info");
  });
});

describe("homeFolderOf", () => {
  it("finds the space's home folder", () => {
    const folders = [
      folder({ id: "h1", name: "home", parent_id: null, space_id: "s1" }),
      folder({ id: "h2", name: "home", parent_id: null, space_id: "s2" }),
    ];
    expect(homeFolderOf(folders, "s2")?.id).toBe("h2");
  });

  it("finds it when the API left parent_id out instead of sending null", () => {
    // The folder list endpoint omits `parent_id` for a root folder and the
    // response is not parsed through the schema that would default it.
    const root = { ...folder({ id: "h1", name: "home", space_id: "s1" }) } as Folder;
    delete (root as { parent_id?: string | null }).parent_id;
    expect(homeFolderOf([root], "s1")?.id).toBe("h1");
  });
});

// One mapping draws every glyph on both pages: the catalog thumbnail, the feed
// card's stand-in, a list row's block, a dialog header.
describe("markKindOf", () => {
  it("names the kinds the catalog does not carry", () => {
    expect(markKindOf(item({ type: "folder" }))).toBe("folder");
    expect(markKindOf(item({ type: "project" }))).toBe("project");
    expect(markKindOf(item({ type: "template" }))).toBe("template");
  });

  it("hands a dataset-shaped item its catalog kind", () => {
    expect(markKindOf(item({ type: "bundle" }))).toBe("bundle");
    expect(markKindOf(item({ type: "layer", layer_type: "raster" }))).toBe("raster");
    expect(markKindOf(item({ type: "layer", layer_type: "table" }))).toBe("table");
    expect(markKindOf(item({ type: "layer", layer_type: "feature" }))).toBe("vector");
  });

  it("is unknown for a layer whose shape the feed does not state", () => {
    expect(markKindOf(item({ type: "layer", layer_type: null }))).toBe("unknown");
  });
});

describe("markFor, through iconFor and iconForType", () => {
  it("marks a project, a folder and a template by their type alone", () => {
    expect(iconFor(item({ type: "project" }))).toBe(ICON_NAME.MAP);
    expect(iconFor(item({ type: "folder" }))).toBe(ICON_NAME.FOLDER);
    expect(iconFor(item({ type: "template" }))).toBe(ICON_NAME.CLONE);
    expect(iconForType("project")).toBe(ICON_NAME.MAP);
    expect(iconForType("folder")).toBe(ICON_NAME.FOLDER);
    expect(iconForType("template")).toBe(ICON_NAME.CLONE);
  });

  it("marks a bundle and a shapeless layer with the layers glyph", () => {
    expect(iconFor(item({ type: "bundle" }))).toBe(ICON_NAME.LAYERS);
    expect(iconForType("bundle")).toBe(ICON_NAME.LAYERS);
    expect(iconForType("layer")).toBe(ICON_NAME.LAYERS);
  });

  it("prefers the layer's kind over its geometry", () => {
    expect(iconFor(item({ type: "layer", layer_type: "table" }))).toBe(ICON_NAME.TABLE);
    expect(iconFor(item({ type: "layer", layer_type: "raster" }))).toBe(ICON_NAME.IMAGE);
  });

  it("marks a vector layer by its geometry", () => {
    expect(
      iconFor(item({ type: "layer", layer_type: "feature", feature_layer_geometry_type: "point" }))
    ).toBe(ICON_NAME.POINT_FEATURE);
    expect(iconFor(item({ type: "layer", layer_type: "feature", feature_layer_geometry_type: "line" }))).toBe(
      ICON_NAME.LINE_FEATURE
    );
    expect(
      iconFor(item({ type: "layer", layer_type: "feature", feature_layer_geometry_type: "polygon" }))
    ).toBe(ICON_NAME.POLYGON_FEATURE);
  });
});

describe("folderLocationLabel", () => {
  const folders = [
    folder({ id: "root", name: "home", parent_id: null }),
    folder({ id: "mid", name: "Field surveys", parent_id: "root" }),
    folder({ id: "leaf", name: "Round 2 QA", parent_id: "mid" }),
  ];

  it("joins the folder names from the space root down, without home", () => {
    expect(folderLocationLabel(folders, "leaf")).toBe("Field surveys › Round 2 QA");
    expect(folderLocationLabel(folders, "mid")).toBe("Field surveys");
  });

  it("is undefined for an item at the root", () => {
    expect(folderLocationLabel(folders, "root")).toBeUndefined();
    expect(folderLocationLabel(folders, null)).toBeUndefined();
  });
});
