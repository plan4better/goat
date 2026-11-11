import { describe, expect, it } from "vitest";

import { builderConfigSchema, builderWidgetSchema } from "@/lib/validations/project";
import { informationLayersConfigSchema } from "@/lib/validations/widget";

describe("builderConfigSchema — control_positions", () => {
  it("applies default control_positions when parsing empty input", () => {
    const result = builderConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.control_positions).toEqual({
      "top-left": ["location", "measure"],
      "top-right": [],
      "bottom-left": [],
      "bottom-right": ["view", "zoom_controls", "basemap", "fullscreen"],
    });
  });

  it("keeps a saved list without the View button as it is", () => {
    const saved = ["zoom_controls", "basemap", "fullscreen"];
    const result = builderConfigSchema.safeParse({
      settings: {
        control_positions: { "top-left": [], "top-right": [], "bottom-left": [], "bottom-right": saved },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.control_positions["bottom-right"]).toEqual(saved);
  });

  it("takes the View button as a control", () => {
    const result = builderConfigSchema.safeParse({
      settings: { control_positions: { "bottom-right": ["view", "zoom_controls"] } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.control_positions["bottom-right"]).toEqual(["view", "zoom_controls"]);
  });

  it("sets allowed_basemaps to null by default", () => {
    const result = builderConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.allowed_basemaps).toBeNull();
  });

  it("preserves order of controls within each corner", () => {
    const result = builderConfigSchema.safeParse({
      settings: {
        control_positions: {
          "top-left": ["measure", "location"],
          "top-right": [],
          "bottom-left": [],
          "bottom-right": ["fullscreen", "zoom_controls"],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.control_positions["top-left"]).toEqual(["measure", "location"]);
    expect(result.data.settings.control_positions["bottom-right"]).toEqual(["fullscreen", "zoom_controls"]);
  });

  it("accepts a basemap allowlist", () => {
    const result = builderConfigSchema.safeParse({
      settings: { allowed_basemaps: ["streets", "light"] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.allowed_basemaps).toEqual(["streets", "light"]);
  });

  it("accepts null allowed_basemaps explicitly", () => {
    const result = builderConfigSchema.safeParse({
      settings: { allowed_basemaps: null },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.allowed_basemaps).toBeNull();
  });

  it("strips unknown control keys (e.g. legacy 'scalebar') rather than failing", () => {
    const result = builderConfigSchema.safeParse({
      settings: {
        control_positions: {
          "top-left": ["location", "scalebar"],
          "bottom-left": ["scalebar"],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.control_positions["top-left"]).toEqual(["location"]);
    expect(result.data.settings.control_positions["bottom-left"]).toEqual([]);
  });

  it("defaults legend_simple_layers to an empty array and preserves ids", () => {
    const empty = informationLayersConfigSchema.safeParse({
      type: "layers",
      setup: { title: "My Layers" },
      options: {},
    });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(empty.data.options.legend_simple_layers).toEqual([]);

    const withIds = informationLayersConfigSchema.safeParse({
      type: "layers",
      setup: { title: "My Layers" },
      options: { legend_simple_layers: [86894, 86878] },
    });
    expect(withIds.success).toBe(true);
    if (!withIds.success) return;
    expect(withIds.data.options.legend_simple_layers).toEqual([86894, 86878]);
  });

  it("preserves group_info through informationLayersConfigSchema parse", () => {
    const result = informationLayersConfigSchema.safeParse({
      type: "layers",
      setup: { title: "My Layers", group_info: { "42": "Some **markdown** text" } },
      options: { layout_style: "tabs" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.setup.group_info).toEqual({ "42": "Some **markdown** text" });
  });

  it("preserves group_info through builderWidgetSchema parse", () => {
    const result = builderWidgetSchema.safeParse({
      id: "widget-1",
      type: "widget",
      config: {
        type: "layers",
        setup: { title: "My Layers", group_info: { "42": "Hello" } },
        options: { layout_style: "tabs" },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const config = result.data.config as { setup?: { group_info?: Record<string, string> } };
    expect(config.setup?.group_info).toEqual({ "42": "Hello" });
  });

  it("preserves group_info through full builderConfigSchema parse", () => {
    const result = builderConfigSchema.safeParse({
      settings: {},
      interface: [
        {
          id: "panel-1",
          type: "panel",
          position: "left",
          widgets: [
            {
              id: "widget-1",
              type: "widget",
              config: {
                type: "layers",
                setup: { title: "My Layers", group_info: { "42": "Info text" } },
                options: { layout_style: "tabs" },
              },
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const panel = result.data.interface[0];
    expect(panel.type).toBe("panel");
    if (panel.type !== "panel") return;
    const widget = panel.widgets[0];
    const config = widget.config as { setup?: { group_info?: Record<string, string> } };
    expect(config.setup?.group_info).toEqual({ "42": "Info text" });
  });

  it("applies default control_positions when settings object exists but control_positions key is missing", () => {
    const result = builderConfigSchema.safeParse({
      settings: { toolbar: false },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.control_positions).toEqual({
      "top-left": ["location", "measure"],
      "top-right": [],
      "bottom-left": [],
      "bottom-right": ["view", "zoom_controls", "basemap", "fullscreen"],
    });
    expect(result.data.settings.toolbar).toBe(false);
  });
});

describe("builderConfigSchema — map_view", () => {
  it("defaults map_view zoom limits to null when absent", () => {
    const result = builderConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.map_view).toEqual({ min_zoom: null, max_zoom: null });
  });

  it("preserves provided min_zoom and max_zoom", () => {
    const result = builderConfigSchema.safeParse({
      settings: { map_view: { min_zoom: 5, max_zoom: 15 } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.settings.map_view).toEqual({ min_zoom: 5, max_zoom: 15 });
  });

  it("rejects zoom values outside 0..24", () => {
    const result = builderConfigSchema.safeParse({
      settings: { map_view: { min_zoom: -1, max_zoom: 30 } },
    });
    expect(result.success).toBe(false);
  });
});
