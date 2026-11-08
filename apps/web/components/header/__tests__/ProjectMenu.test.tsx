import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProjectMenu from "@/components/header/ProjectMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: undefined }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined,
}));
vi.mock("@/components/common/PopperMenu", () => ({
  default: ({ menuItems }: { menuItems: { id: string; label: string }[] }) => (
    <ul>
      {menuItems.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/modals/ContentDelete", () => ({ default: () => null }));
vi.mock("@/components/modals/Metadata", () => ({ default: () => null }));
vi.mock("@/components/templates/SaveTemplateDialog", () => ({ default: () => null }));

const project = { id: "p1", name: "Radverkehr", max_extent: null } as never;

describe("ProjectMenu", () => {
  it("offers an editor the project's actions", () => {
    render(<ProjectMenu project={project} isLoggedIn />);
    for (const label of [
      "common:home",
      "common:edit_metadata",
      "common:save_project_as_template",
      "common:delete_project",
      "common:lock_map_view",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("offers a logged-in viewer only the way home", () => {
    render(<ProjectMenu project={project} viewOnly isLoggedIn />);
    expect(screen.getByText("common:home")).toBeInTheDocument();
    expect(screen.queryByText("common:edit_metadata")).toBeNull();
  });
});
