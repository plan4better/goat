import { describe, expect, it } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { ADD_LAYER_SOURCES, sourcesFor } from "@/components/addLayer/sources";

/**
 * The registry decides which entries a menu offers. Worth pinning because getting it wrong
 * is invisible in one host and broken in another: the datasets page has no project, so a
 * source that adds to one must not appear there.
 */
describe("sourcesFor", () => {
  it("offers every source inside a project", () => {
    expect(sourcesFor({ hasProject: true }).map((s) => s.id)).toEqual([
      "upload",
      "explorer",
      "catalog",
      "create",
      "connect",
    ]);
  });

  it("drops project-only sources without one", () => {
    const ids = sourcesFor({ hasProject: false }).map((s) => s.id);
    // Connecting a service or fetching for a drawn area needs only a folder; fetch is
    // reached through Connect service, so the menu never lists it.
    expect(ids).toEqual(["upload", "connect"]);
    // The three left out are exactly those that add a layer to a project.
    expect(ADD_LAYER_SOURCES.filter((s) => s.needsProject).map((s) => s.id)).toEqual([
      "explorer",
      "catalog",
      "create",
    ]);
  });

  it("pins the datasets shelf's own entry", () => {
    // Sized like the catalog picker — a spaces rail beside a grid of cards —
    // and laying out its own edges, so the dialog must not pad it.
    expect(ADD_LAYER_SOURCES.find((s) => s.id === "explorer")).toEqual({
      id: "explorer",
      labelKey: "my_datasets",
      group: "existing",
      icon: ICON_NAME.DATABASE,
      needsProject: true,
      wide: true,
      width: "min(1360px, 94vw)",
    });
  });

  it("keeps a label key for every source", () => {
    for (const source of ADD_LAYER_SOURCES) {
      expect(source.labelKey).toMatch(/^[a-z_]+$/);
    }
  });
});
