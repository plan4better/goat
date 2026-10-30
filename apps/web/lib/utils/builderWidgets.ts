import { v4 } from "uuid";

import type { BuilderPanelSchema, BuilderWidgetSchema } from "@/lib/validations/project";

/**
 * Panels with a copy of the widget `widgetId` right after it, and that copy.
 * A Tabs widget lists its children by id, so its children are copied with it
 * and the copy's tabs point at them; otherwise both would show the same widgets.
 * Undefined when no panel holds the widget.
 */
export const duplicateWidget = (
  panels: BuilderPanelSchema[],
  widgetId: string
): { panels: BuilderPanelSchema[]; copy: BuilderWidgetSchema } | undefined => {
  const panelIndex = panels.findIndex((panel) => panel.widgets?.some((widget) => widget.id === widgetId));
  if (panelIndex === -1) return undefined;
  const panel = panels[panelIndex];
  const index = panel.widgets.findIndex((widget) => widget.id === widgetId);

  const copy = structuredClone(panel.widgets[index]);
  copy.id = v4();
  const children: BuilderWidgetSchema[] = [];
  if (copy.config?.type === "tabs") {
    copy.config.tabs = copy.config.tabs.map((tab) => ({
      ...tab,
      id: v4(),
      widgetIds: tab.widgetIds.flatMap((childId) => {
        const child = panel.widgets.find((widget) => widget.id === childId);
        if (!child) return [];
        const childCopy = { ...structuredClone(child), id: v4() };
        children.push(childCopy);
        return [childCopy.id];
      }),
    }));
  }

  const widgets = [
    ...panel.widgets.slice(0, index + 1),
    copy,
    ...children,
    ...panel.widgets.slice(index + 1),
  ];
  return {
    panels: panels.map((p, i) => (i === panelIndex ? { ...p, widgets } : p)),
    copy,
  };
};
