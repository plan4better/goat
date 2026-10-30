import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import HomePage from "@/components/dashboard/home/HomePage";

const {
  useHomeStageMock,
  useUserProfileMock,
  useHomeCreateMock,
  pushMock,
  useTemplatesMock,
  templateBrowserPropsMock,
  newProjectButtonMock,
  useJobStatusMock,
  refreshContentFeedMock,
} = vi.hoisted(() => ({
  useHomeStageMock: vi.fn(),
  useUserProfileMock: vi.fn(),
  useHomeCreateMock: vi.fn(),
  pushMock: vi.fn(),
  useTemplatesMock: vi.fn(),
  templateBrowserPropsMock: vi.fn(),
  newProjectButtonMock: vi.fn(),
  useJobStatusMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("@/lib/api/users", () => ({ useUserProfile: useUserProfileMock }));
vi.mock("@/lib/api/content", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/content")>("@/lib/api/content");
  return { ...actual, refreshContentFeed: refreshContentFeedMock };
});
vi.mock("@/hooks/jobs/JobStatus", () => ({ useJobStatus: useJobStatusMock }));
vi.mock("@/lib/api/templates", () => ({
  useTemplates: (...args: unknown[]) => useTemplatesMock(...args),
}));
vi.mock("@/components/templates/TemplateBrowser", () => ({
  default: (props: Record<string, unknown>) => {
    templateBrowserPropsMock(props);
    return <div data-testid="template-browser" />;
  },
}));
vi.mock("@/components/templates/UseTemplateFlow", () => ({
  default: () => <div data-testid="use-template-flow" />,
}));
// The hero's "New project" menu owns its own dialogs — `HomePage` only
// supplies the folder a hero-created project should land in.
vi.mock("@/components/dashboard/common/NewProjectMenu", () => ({
  NewProjectButton: (props: { location: { folderId?: string } }) => {
    newProjectButtonMock(props);
    return <button type="button">new_project</button>;
  },
  NewProjectFlows: () => null,
}));
vi.mock("@/hooks/dashboard/home/useHomeStage", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/dashboard/home/useHomeStage")>(
    "@/hooks/dashboard/home/useHomeStage"
  );
  return { ...actual, useHomeStage: useHomeStageMock };
});
vi.mock("@/hooks/dashboard/home/useHomeCreate", () => ({ useHomeCreate: useHomeCreateMock }));
vi.mock("@/components/dashboard/home/BlogSection", () => ({ default: () => null }));
vi.mock("@/components/dashboard/home/HomeAnnouncements", () => ({ default: () => null }));
vi.mock("@/components/dashboard/home/JumpBackIn", () => ({ default: () => null }));
vi.mock("@/components/dashboard/home/RecentDatasets", () => ({ default: () => null }));
vi.mock("@/components/dashboard/home/TeamsCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/home/TemplateBand", () => ({
  default: () => <div data-testid="template-band" />,
}));

const stage = (overrides: Partial<ReturnType<typeof useHomeStageMock>> = {}) => ({
  stage: "getting_started",
  isLoading: false,
  facts: { has_project: true, has_uploaded_layer: false, has_catalog_layer: false, has_team: false },
  done: [],
  skipped: false,
  skip: vi.fn(),
  refresh: vi.fn(),
  ...overrides,
});

describe("HomePage", () => {
  beforeEach(() => {
    pushMock.mockReset();
    templateBrowserPropsMock.mockReset();
    newProjectButtonMock.mockReset();
    useJobStatusMock.mockReset();
    refreshContentFeedMock.mockReset();
    useTemplatesMock
      .mockReset()
      .mockReturnValue({ page: { items: [], total: 0 }, isLoading: false, isError: undefined });
    useUserProfileMock.mockReturnValue({ userProfile: { firstname: "Marco" } });
    useHomeCreateMock.mockReturnValue({
      homeFolderId: "home-1",
      newProject: vi.fn(),
      addDataset: vi.fn(),
      browseCatalog: vi.fn(),
      dialogs: null,
    });
  });

  it("refreshes the content lists and onboarding facts when an import job finishes", () => {
    const refresh = vi.fn();
    useHomeStageMock.mockReturnValue(stage({ refresh }));

    render(<HomePage />);

    expect(useJobStatusMock).toHaveBeenCalled();
    const onSuccess = useJobStatusMock.mock.calls[0][0] as () => void;
    onSuccess();

    expect(refreshContentFeedMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders the hero straight away while the stage loads, greeting as a skeleton", () => {
    useHomeStageMock.mockReturnValue(stage({ stage: undefined, isLoading: true, facts: undefined }));

    const { container } = render(<HomePage />);

    // No stage-dependent band yet: neither greeting, nor the help strip
    // Established hides, nor the checklist.
    expect(screen.queryByText("welcome_to_goat")).not.toBeInTheDocument();
    expect(screen.queryByText("welcome_back")).not.toBeInTheDocument();
    expect(screen.queryByText("help_docs")).not.toBeInTheDocument();
    expect(screen.queryByText("set_up_workspace")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThan(0);
    // The quick actions are the same in every stage but New, so they do not
    // wait — the hero opens on its Established shape.
    expect(screen.getByRole("button", { name: "new_project" })).toBeInTheDocument();
  });

  it("hands the hero the caller's personal home folder", () => {
    useHomeStageMock.mockReturnValue(stage());

    render(<HomePage />);

    expect(newProjectButtonMock).toHaveBeenCalledWith(
      expect.objectContaining({ location: { folderId: "home-1" } })
    );
  });

  it("renders the hero once the stage has loaded", () => {
    useHomeStageMock.mockReturnValue(stage());

    render(<HomePage />);

    expect(screen.getByText("welcome_to_goat")).toBeInTheDocument();
    // Both the hero's quick action and the checklist's first-step CTA share
    // this label — assert at least one rendered rather than picking one.
    expect(screen.getAllByRole("button", { name: "new_project" }).length).toBeGreaterThan(0);
  });

  it("mounts the template band after Jump back in, every stage", () => {
    useHomeStageMock.mockReturnValue(stage({ stage: "established" }));

    render(<HomePage />);

    expect(screen.getByTestId("template-band")).toBeInTheDocument();
  });

  it("leads New with the checklist and shows Get some data in while no dataset exists", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "new",
        facts: { has_project: false, has_uploaded_layer: false, has_catalog_layer: false, has_team: false },
      })
    );

    render(<HomePage />);

    expect(screen.getByText("set_up_workspace")).toBeInTheDocument();
    expect(screen.getByText("get_some_data_in")).toBeInTheDocument();
    // New renders the checklist uncompacted since it leads the page — every
    // step shows with no "Show all" toggle needed.
    expect(screen.queryByText("show_all_steps")).not.toBeInTheDocument();
    expect(screen.getByText("step_team_title")).toBeInTheDocument();
  });

  it("hides Get some data in once a dataset is reachable", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "new",
        facts: { has_project: false, has_uploaded_layer: true, has_catalog_layer: false, has_team: false },
      })
    );

    render(<HomePage />);

    expect(screen.queryByText("get_some_data_in")).not.toBeInTheDocument();
  });

  it("keeps the compact checklist under the hero in Getting started while no project exists", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "getting_started",
        facts: { has_project: false, has_uploaded_layer: true, has_catalog_layer: false, has_team: false },
        done: ["data"],
      })
    );

    render(<HomePage />);

    expect(screen.getByText("set_up_workspace")).toBeInTheDocument();
    expect(screen.queryByText("get_some_data_in")).not.toBeInTheDocument();
  });

  it("hands the checklist over to the header tray once a project exists", () => {
    useHomeStageMock.mockReturnValue(stage({ stage: "getting_started" }));

    render(<HomePage />);

    expect(screen.queryByText("set_up_workspace")).not.toBeInTheDocument();
  });

  it("shows neither band once Established", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "established",
        facts: { has_project: true, has_uploaded_layer: true, has_catalog_layer: true, has_team: true },
        done: ["project", "data", "catalog", "team"],
      })
    );

    render(<HomePage />);

    expect(screen.queryByText("set_up_workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("get_some_data_in")).not.toBeInTheDocument();
  });

  it("keeps the help strip after skipping onboarding until a project and a workflow exist", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "established",
        skipped: true,
        facts: {
          has_project: false,
          has_uploaded_layer: false,
          has_catalog_layer: false,
          has_workflow: false,
          has_team: false,
        },
      })
    );

    render(<HomePage />);

    expect(screen.getByText("help_getting_started")).toBeInTheDocument();
    expect(screen.getByText("help_docs")).toBeInTheDocument();
    expect(screen.getByText("help_video")).toBeInTheDocument();
  });

  it("drops the help strip once a project and a workflow exist, skipped or not", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "established",
        facts: {
          has_project: true,
          has_uploaded_layer: false,
          has_catalog_layer: false,
          has_workflow: true,
          has_team: false,
        },
      })
    );

    render(<HomePage />);

    expect(screen.queryByText("help_getting_started")).not.toBeInTheDocument();
    expect(screen.queryByText("help_docs")).not.toBeInTheDocument();
    expect(screen.queryByText("help_video")).not.toBeInTheDocument();
  });

  it("routes the checklist's team step to Settings > Teams", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "getting_started",
        facts: { has_project: false, has_uploaded_layer: true, has_catalog_layer: true, has_team: false },
        // Only project and team stay open, so the compact card shows both.
        done: ["data", "catalog", "analysis", "workflow"],
      })
    );

    render(<HomePage />);
    screen.getByRole("button", { name: "invite_people" }).click();

    expect(pushMock).toHaveBeenCalledWith("/settings/teams");
  });

  it("opens the browser on the GOAT shelf with a sample-data workflow starter previewed", () => {
    const starter = {
      id: "starter-1",
      name: "Bus network",
      kinds: ["workflow"],
      ships_data: true,
    };
    useTemplatesMock.mockReturnValue({
      // A published project starter that also ships sample data must not win
      // the pick — the step promises a workflow.
      page: { items: [{ id: "other", kinds: ["project"], ships_data: true }, starter], total: 2 },
      isLoading: false,
      isError: undefined,
    });
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "new",
        facts: { has_project: false, has_uploaded_layer: false, has_catalog_layer: false, has_team: false },
        done: [],
      })
    );

    render(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "pick_a_template" }));

    expect(templateBrowserPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialSource: "goat", initialTemplateId: "starter-1" })
    );
    expect(screen.queryByTestId("use-template-flow")).not.toBeInTheDocument();
  });

  it("asks for no templates at all once Established, where no step can read them", () => {
    useHomeStageMock.mockReturnValue(
      stage({
        stage: "established",
        facts: { has_project: true, has_uploaded_layer: true, has_catalog_layer: true, has_team: true },
        done: ["project", "data", "catalog", "team"],
      })
    );

    render(<HomePage />);

    expect(useTemplatesMock).toHaveBeenCalledWith(null);
  });

  it("stacks the datasets/side-column band below md instead of running it side by side", () => {
    // Without a project the checklist still renders, which is what puts the
    // band at the index asserted below.
    useHomeStageMock.mockReturnValue(
      stage({
        facts: { has_project: false, has_uploaded_layer: false, has_catalog_layer: false, has_team: false },
        done: [],
      })
    );
    // jsdom has no matchMedia; force MUI's useMediaQuery to the mobile
    // branch so the below-md layout (H13, §3) can be asserted directly.
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    const { container } = render(<HomePage />);

    // The root Box's fourth direct child is the datasets/side-column band
    // (header, checklist, the stubbed template band, then this band —
    // JumpBackIn, BlogSection etc. are mocked to render nothing) — desktop
    // lays it out as a row, mobile stacks it as a column.
    const root = container.firstElementChild as HTMLElement;
    const band = root.children[3] as HTMLElement;
    expect(getComputedStyle(band).flexDirection).toBe("column");
  });
});
