import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Header from "@/components/header/Header";

// The map view's parts the shared header loads lazily: the project menu at mount, the
// share dialog while the page is idle and on first open.
const { idle, share } = vi.hoisted(() => ({
  idle: { tasks: [] as (() => void)[] },
  share: { imports: 0 },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: () => null,
}));
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
  whenIdle: (task: () => void) => {
    idle.tasks.push(task);
    return () => undefined;
  },
}));
vi.mock("@/components/header/Toolbar", () => ({
  TOOLBAR_HEIGHT: 52,
  Toolbar: ({
    LeftToolbarChild,
    RightToolbarChild,
  }: {
    LeftToolbarChild: ReactNode;
    RightToolbarChild: ReactNode;
  }) => (
    <div>
      {LeftToolbarChild}
      {RightToolbarChild}
    </div>
  ),
}));
vi.mock("@/components/assistant/AskAiButton", () => ({ default: () => null }));
vi.mock("@/components/support/SupportMenu", () => ({ default: () => null }));
vi.mock("@/components/UserInfoMenu", () => ({ default: () => null }));
vi.mock("@/components/common/EditableTypography", () => ({ default: () => null }));
vi.mock("@/components/common/SlidingToggle", () => ({ default: () => null }));
vi.mock("@/components/header/OnboardingTray", () => ({ default: () => null }));
vi.mock("@/components/header/StatusDot", () => ({ default: () => null }));
vi.mock("@/components/header/WhatsNewPopper", () => ({ default: () => null }));
vi.mock("@/components/jobs/JobsPopper", () => ({ default: () => null }));
vi.mock("@/lib/store/layer/slice", () => ({ setSelectedLayers: vi.fn() }));
vi.mock("@/lib/store/map/slice", () => ({ setMapMode: vi.fn(), setActiveRightPanel: vi.fn() }));
// Code a deploy removed (a tab opened before it): every load of these fails.
vi.mock("@/components/header/ProjectMenu", () => {
  throw new Error("Failed to load chunk");
});
vi.mock("@/components/modals/content/ProjectShareDialog", () => {
  share.imports += 1;
  throw new Error("Failed to load chunk");
});

const project = { id: "p1", name: "Radverkehr", tags: [] } as never;

beforeEach(() => {
  idle.tasks = [];
});

describe("Header share dialog prefetch", () => {
  it("loads nothing ahead in the workspace header or a view-only project", () => {
    const { unmount } = render(<Header title="Workspace" />);
    unmount();
    render(<Header mapHeader project={project} viewOnly />);
    expect(idle.tasks).toHaveLength(0);
  });

  it("loads the share dialog's code while a project editor's page is idle", async () => {
    render(<Header mapHeader project={project} />);
    expect(idle.tasks).toHaveLength(1);
    const before = share.imports;
    idle.tasks[0]();
    await waitFor(() => expect(share.imports).toBeGreaterThan(before));
  });
});

describe("Header map view parts whose code does not load", () => {
  it("shows the logo link home in place of the project menu", async () => {
    render(<Header mapHeader project={project} />);
    expect((await screen.findByRole("link")).getAttribute("href")).toBe("/home");
  });

  it("shows a notice with a reload in place of the share dialog", async () => {
    render(<Header mapHeader project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "common:share" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toBe("assistant_part_load_failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
