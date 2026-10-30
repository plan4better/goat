import { describe, expect, it } from "vitest";

import { duplicateWidget } from "@/lib/utils/builderWidgets";
import type { BuilderPanelSchema } from "@/lib/validations/project";

const panels = [
  {
    id: "p1",
    type: "panel",
    position: "left",
    config: {},
    widgets: [
      { id: "w-text", type: "widget", config: { type: "text", setup: { text: "<p>Hello</p>" } } },
      {
        id: "w-tabs",
        type: "widget",
        config: {
          type: "tabs",
          setup: { title: "", full_width: false },
          tabs: [{ id: "tab-1", name: "A", widgetIds: ["w-child"] }],
        },
      },
      { id: "w-child", type: "widget", config: { type: "text", setup: { text: "<p>Child</p>" } } },
    ],
  },
] as unknown as BuilderPanelSchema[];

describe("duplicateWidget", () => {
  it("inserts a copy with a new id right after the widget", () => {
    const result = duplicateWidget(panels, "w-text");
    const widgets = result!.panels[0].widgets;
    expect(widgets.map((w) => w.id)).toEqual(["w-text", result!.copy.id, "w-tabs", "w-child"]);
    expect(result!.copy.id).not.toBe("w-text");
    expect(result!.copy.config).toEqual(panels[0].widgets[0].config);
  });

  it("copies a Tabs widget's children and points the copy at them", () => {
    const result = duplicateWidget(panels, "w-tabs");
    const widgets = result!.panels[0].widgets;
    expect(widgets).toHaveLength(5);
    const tabs = result!.copy.config as { tabs: { id: string; widgetIds: string[] }[] };
    const childCopyId = tabs.tabs[0].widgetIds[0];
    expect(childCopyId).not.toBe("w-child");
    expect(widgets.find((w) => w.id === childCopyId)?.config).toEqual(panels[0].widgets[2].config);
    expect(tabs.tabs[0].id).not.toBe("tab-1");
  });

  it("leaves the source panels untouched", () => {
    const before = JSON.stringify(panels);
    duplicateWidget(panels, "w-tabs");
    expect(JSON.stringify(panels)).toBe(before);
  });

  it("returns undefined for an unknown widget", () => {
    expect(duplicateWidget(panels, "missing")).toBeUndefined();
  });
});
