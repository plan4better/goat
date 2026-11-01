/**
 * A dashboard the editor cannot fully read must survive a settings change: the
 * panel saved to fall back to the default layout and save that over the
 * user's panels.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/validations/project";

import ConfigPanel from "@/components/builder/ConfigPanel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({
      map: { selectedBuilderItem: undefined, temporaryFilters: [] },
      layers: { projectLayers: [], projectLayerGroups: [] },
    }),
}));
vi.mock("@/components/builder/WidgetsTab", () => ({ default: () => null }));
vi.mock("@/components/builder/PanelConfiguration", () => ({ default: () => null }));
vi.mock("@/components/builder/WidgetConfiguration", () => ({ default: () => null }));
vi.mock("@/components/builder/SettingsTab", () => ({
  default: ({ onChange }: { onChange: (name: string, value: unknown) => void }) => (
    <button onClick={() => onChange("toolbar", false)}>turn off the toolbar</button>
  ),
}));

const userPanel = {
  id: "p-user",
  type: "panel",
  position: "right",
  widgets: [{ id: "w-new", type: "widget", config: { type: "no_such_widget", setup: { x: 1 } } }],
};

describe("ConfigPanel", () => {
  it("keeps the user's panels when it saves a settings change to a config it cannot fully read", () => {
    const onProjectUpdate = vi.fn();
    const project = {
      id: "p",
      builder_config: { settings: { toolbar: true }, interface: [userPanel] },
    } as unknown as Project;
    render(
      <ConfigPanel
        project={project}
        onProjectUpdate={onProjectUpdate}
        projectLayers={[]}
        projectLayerGroups={[]}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "turn off the toolbar" }));

    expect(onProjectUpdate).toHaveBeenCalledTimes(1);
    const [key, saved] = onProjectUpdate.mock.calls[0];
    expect(key).toBe("builder_config");
    expect(saved.interface).toEqual([userPanel]);
    expect(saved.settings.toolbar).toBe(false);
  });
});
