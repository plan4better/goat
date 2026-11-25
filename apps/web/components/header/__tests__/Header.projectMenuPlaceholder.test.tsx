import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import Header from "@/components/header/Header";

// The project menu's code arrives only when the test lets it, so the header's
// placeholder can be compared with the menu that replaces it.
const gate = vi.hoisted(() => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
});

vi.mock("@/components/header/ProjectMenu", async () => {
  await gate.opened;
  return vi.importActual("@/components/header/ProjectMenu");
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: () => null,
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: undefined }) }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/users", () => ({
  useOrganization: () => ({ organization: undefined }),
  useFeatures: () => ({ features: { billing: false, support: false } }),
  useUserProfile: () => ({ userProfile: { id: "u1" } }),
}));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => ({ isOrgAdmin: false }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined,
}));
vi.mock("@/components/assistant/dockLoader", () => ({
  prefetchAssistant: vi.fn(),
  whenIdle: () => () => undefined,
}));
vi.mock("@/components/header/Toolbar", () => ({
  TOOLBAR_HEIGHT: 52,
  Toolbar: ({ LeftToolbarChild }: { LeftToolbarChild: ReactNode }) => (
    <div data-testid="left">{LeftToolbarChild}</div>
  ),
}));
vi.mock("@/components/common/EditableTypography", () => ({
  default: () => <span data-testid="title" />,
}));
vi.mock("@/components/assistant/AskAiButton", () => ({ default: () => null }));
vi.mock("@/components/support/SupportMenu", () => ({ default: () => null }));
vi.mock("@/components/UserInfoMenu", () => ({ default: () => null }));
vi.mock("@/components/common/SlidingToggle", () => ({ default: () => null }));
vi.mock("@/components/header/OnboardingTray", () => ({ default: () => null }));
vi.mock("@/components/header/StatusDot", () => ({ default: () => null }));
vi.mock("@/components/header/WhatsNewPopper", () => ({ default: () => null }));
vi.mock("@/components/jobs/JobsPopper", () => ({ default: () => null }));
vi.mock("@/components/modals/ContentDelete", () => ({ default: () => null }));
vi.mock("@/components/modals/Metadata", () => ({ default: () => null }));
vi.mock("@/components/templates/SaveTemplateDialog", () => ({ default: () => null }));
vi.mock("@/lib/store/layer/slice", () => ({ setSelectedLayers: vi.fn() }));
vi.mock("@/lib/store/map/slice", () => ({ setMapMode: vi.fn(), setActiveRightPanel: vi.fn() }));

const project = { id: "p1", name: "Radverkehr", tags: [], max_extent: null } as never;

/** What stands left of the title: the project menu, or its placeholder. */
const beforeTitle = () => {
  const parts = [...screen.getByTestId("left").children];
  return parts.slice(
    0,
    parts.findIndex((part) => part.contains(screen.getByTestId("title")))
  );
};
/** The boxes that set where the title starts: each part's tag, the button's
 * classes (its size, margins and chevron) and the divider's. */
const shape = (parts: Element[]) => ({
  tags: parts.map((part) => part.tagName),
  button: parts[0]?.querySelector("button")?.className,
  logo: Boolean(parts[0]?.querySelector("button svg")),
  divider: parts[1]?.className,
});

describe("Header project menu placeholder", () => {
  it("takes the loaded menu's place, divider included, so the title does not move", async () => {
    render(<Header mapHeader project={project} />);
    const placeholder = shape(beforeTitle());
    // Not a control while it stands in: the menu has not loaded.
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => gate.open());
    await waitFor(() => expect(screen.getByRole("button")).toBeInTheDocument());
    const loaded = shape(beforeTitle());

    expect(loaded.tags).toEqual(["DIV", "HR"]);
    expect(loaded.divider).toContain("MuiDivider-vertical");
    expect(placeholder).toEqual(loaded);
    expect(placeholder.logo).toBe(true);
  });
});
