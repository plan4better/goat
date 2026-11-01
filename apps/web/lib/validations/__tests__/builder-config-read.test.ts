/**
 * The dashboard config as the editor reads it: what this version of GOAT cannot
 * read is kept exactly as stored, so a save never replaces the user's panels
 * with the default layout.
 */
import { describe, expect, it } from "vitest";

import { builderConfigSchema, readBuilderConfig } from "@/lib/validations/project";

const goodPanel = {
  id: "p1",
  type: "panel",
  position: "left",
  widgets: [{ id: "w1", type: "widget", config: { type: "divider" } }],
};
const unreadablePanel = {
  id: "p2",
  type: "panel",
  position: "right",
  widgets: [{ id: "w2", type: "widget", config: { type: "no_such_widget", setup: { x: 1 } } }],
};

describe("readBuilderConfig", () => {
  it("reads a valid config like the schema does", () => {
    const stored = { settings: { toolbar: false }, interface: [goodPanel] };
    expect(readBuilderConfig(stored)).toEqual(builderConfigSchema.parse(stored));
  });

  it("keeps a panel it cannot read exactly as stored, next to the parsed ones", () => {
    const config = readBuilderConfig({
      settings: { toolbar: false },
      interface: [goodPanel, unreadablePanel],
    });
    expect(config.interface).toHaveLength(2);
    expect(config.interface[0]).toEqual(builderConfigSchema.parse({ interface: [goodPanel] }).interface[0]);
    expect(config.interface[1]).toBe(unreadablePanel);
    expect(config.settings.toolbar).toBe(false);
  });

  it("keeps the other settings when one is unreadable, and gives that one its default", () => {
    const config = readBuilderConfig({
      settings: { toolbar: false, language: "klingon" },
      interface: [unreadablePanel],
    });
    expect(config.settings.toolbar).toBe(false);
    expect(config.settings.language).toBe("auto");
    expect(config.interface).toEqual([unreadablePanel]);
  });

  it("keeps an interaction rule it cannot read", () => {
    const rule = { id: "r1", kind: "from_the_future" };
    const config = readBuilderConfig({ interface: [unreadablePanel], interactions: [rule] });
    expect(config.interactions).toEqual([rule]);
  });

  it("gives a project without a dashboard the default one", () => {
    expect(readBuilderConfig(null)).toEqual(builderConfigSchema.parse({}));
    expect(readBuilderConfig(undefined)).toEqual(builderConfigSchema.parse({}));
  });
});
