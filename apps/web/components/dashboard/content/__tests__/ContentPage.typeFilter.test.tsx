import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem } from "@/lib/validations/content";

import ContentPage from "@/components/dashboard/content/ContentPage";

// Unchecking the last type filter leaves nothing that can match: the state
// hook stops asking the feed for anything, and the page has to say so rather
// than standing blank — it used to read an empty selection back off the URL
// as *every* type and list everything. Everything the page pulls in besides
// the feed is stubbed, as in the paging test beside this one.

const { useContentMock, refreshContentFeedMock, pageState } = vi.hoisted(() => ({
  useContentMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
  /** What the state hook reports, as a test sets it. */
  pageState: { noTypesSelected: false, feedParams: null as unknown },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/api/assets", () => ({ useDocuments: () => ({ documents: [] }) }));
vi.mock("@/lib/api/content", () => ({
  refreshContentFeed: refreshContentFeedMock,
  useContent: (params: unknown) => useContentMock(params),
  useSharedWithSpace: () => ({ page: undefined }),
  useSpaces: () => ({
    spaces: [
      {
        id: "space-1",
        kind: "personal",
        name: "My Content",
        default_role: "owner",
        my_role: "owner",
        team_id: null,
        organization_id: null,
      },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/lib/api/folders", () => ({ useFolders: () => ({ folders: [] }) }));
vi.mock("@/lib/api/templates", () => ({ useTemplate: () => ({ template: undefined }) }));
vi.mock("@/lib/providers/ContentUiStateProvider", () => ({
  useContentUiState: () => ({
    openSections: {
      folders: true,
      shortcuts: true,
      projects: true,
      templates: true,
      datasets: true,
      documents: true,
    },
    toggleSection: vi.fn(),
    detailsOpen: false,
    setDetailsOpen: vi.fn(),
    toggleDetails: vi.fn(),
  }),
}));

vi.mock("@/hooks/dashboard/content/useContentActions", () => ({
  canActOn: () => true,
  canMoveAll: (items: unknown[]) => items.length > 0,
  useContentActions: () => ({ getMenuItems: () => [] }),
}));
vi.mock("@/hooks/dashboard/content/useContentDrag", () => ({
  useContentDrag: () => ({
    dragIds: [],
    dropTarget: null,
    startDrag: vi.fn(),
    endDrag: vi.fn(),
    setDropTarget: vi.fn(),
    canDropOnSpace: vi.fn(),
  }),
}));
vi.mock("@/hooks/dashboard/content/useContentPageState", () => ({
  readStoredPersonalSpaceId: () => null,
  writeStoredPersonalSpaceId: vi.fn(),
  useContentPageState: () => ({
    active: { kind: "space", spaceId: "space-1" },
    folderId: null,
    search: "",
    setSearch: vi.fn(),
    types: [],
    setTypes: vi.fn(),
    noTypesSelected: pageState.noTypesSelected,
    orderBy: "updated_at",
    order: "descendent",
    setSort: vi.fn(),
    layout: "grid",
    setLayout: vi.fn(),
    goSpace: vi.fn(),
    goView: vi.fn(),
    goFolder: vi.fn(),
    goFolderIn: vi.fn(),
    feedParams: pageState.feedParams,
    ALL_TYPES: [],
  }),
}));
vi.mock("@/hooks/dashboard/content/useContentSelection", () => ({
  useContentSelection: () => ({
    selected: new Set(),
    selectedItems: [],
    anySelected: false,
    toggle: vi.fn(),
    selectOnly: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock("@/hooks/jobs/JobStatus", () => ({ useJobStatus: vi.fn() }));

vi.mock("@/components/dashboard/common/DocumentCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/common/EmptyState", () => ({ default: () => <div>nothing_here_yet</div> }));
vi.mock("@/components/dashboard/content/ContentActionBar", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentActionDialogs", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentAddMenu", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentBreadcrumb", () => ({ default: () => null }));
// The one card that renders: the row's name is how the listed pages are read.
vi.mock("@/components/dashboard/content/ContentCard", () => ({
  default: ({ item }: { item: ContentItem }) => <div>{item.name}</div>,
}));
vi.mock("@/components/dashboard/content/ContentDeleteDialog", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentDetailsPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentFeedSkeleton", () => ({
  default: () => <div data-testid="feed-skeleton" />,
}));
vi.mock("@/components/dashboard/content/ContentFolderCard", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentKebab", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentPreviewDialog", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentRow", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentSection", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/dashboard/content/ContentSpacesPanel", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ContentToolbar", () => ({ default: () => null }));
vi.mock("@/components/dashboard/content/ShortcutTile", () => ({ default: () => null }));
vi.mock("@/components/modals/content/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/modals/content/SpaceSettingsDialog", () => ({ default: () => null }));
vi.mock("@/components/modals/content/TrashDialog", () => ({ default: () => null }));
vi.mock("@/components/modals/content/TransferDialog", () => ({ default: () => null }));
vi.mock("@/components/templates/TemplatePreviewDialog", () => ({ default: () => null }));
vi.mock("@/components/templates/UseTemplateFlow", () => ({ default: () => null }));
vi.mock("@/components/modals/content/MoveDialog", () => ({
  default: () => null,
  folderDepthViolation: () => false,
  moveContentItems: vi.fn(),
  withDescendants: () => [],
}));
vi.mock("@/lib/utils/content", () => ({
  homeFolderOf: () => undefined,
  iconFor: () => "folder",
  lastRoleSegment: () => undefined,
  sectionOf: () => "datasets",
  spaceDisplayName: () => "My Content",
  spaceIconFor: () => "folder",
}));

/** One row of the space, as the feed answers with it. */
const row = {
  type: "layer",
  id: "l-1",
  name: "dataset-one",
  space_id: "space-1",
  folder_id: null,
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  shared_with: null,
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
} as ContentItem;

const feedParamsForSpace = {
  view: "space",
  space_id: "space-1",
  order_by: "updated_at",
  order: "descendent",
  size: 50,
};

describe("ContentPage with no type filter selected", () => {
  beforeEach(() => {
    useContentMock.mockReset();
    useContentMock.mockImplementation((params?: unknown) =>
      params
        ? { page: { items: [row], total: 1, page: 1, size: 50 }, isLoading: false }
        : { page: undefined, isLoading: false }
    );
    refreshContentFeedMock.mockReset();
    pageState.noTypesSelected = false;
    pageState.feedParams = feedParamsForSpace;
    window.matchMedia =
      window.matchMedia ??
      ((query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList);
  });

  it("lists the space while types are selected", () => {
    render(<ContentPage />);

    expect(screen.getByText("dataset-one")).toBeInTheDocument();
    expect(screen.queryByText("nothing_here_yet")).not.toBeInTheDocument();
  });

  it("says there is nothing to list, and asks the feed for nothing", () => {
    pageState.noTypesSelected = true;
    pageState.feedParams = null;

    render(<ContentPage />);

    expect(screen.getByText("nothing_here_yet")).toBeInTheDocument();
    expect(screen.queryByText("dataset-one")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feed-skeleton")).not.toBeInTheDocument();
    expect(useContentMock.mock.calls.every(([params]) => params === null)).toBe(true);
  });
});
