import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem } from "@/lib/validations/content";

import ContentPage from "@/components/dashboard/content/ContentPage";

// The feed's "Load more" used to grow the request `size` (50 × pages), which
// the content endpoint caps at 100 — so the third click asked for 150, 422'd,
// and every further click re-fired the same failing request, leaving the rest
// of a space with more than 100 rows unreachable. It now advances `page` at a
// fixed size and accumulates the pages here. Everything the page pulls in
// besides the feed is stubbed, as in the job-status test beside this one.

const { useContentMock, refreshContentFeedMock } = vi.hoisted(() => ({
  useContentMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
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
    orderBy: "updated_at",
    order: "descendent",
    setSort: vi.fn(),
    layout: "grid",
    setLayout: vi.fn(),
    goSpace: vi.fn(),
    goView: vi.fn(),
    goFolder: vi.fn(),
    goFolderIn: vi.fn(),
    // What the page state hands over: the collection, with its own default
    // page size, which the page replaces with the one it pages at.
    feedParams: {
      view: "space",
      space_id: "space-1",
      order_by: "updated_at",
      order: "descendent",
      size: 50,
    },
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

/** One row of the requested page, named after it. */
const rowsFor = (page: number): ContentItem[] => [
  {
    type: "layer",
    id: `l-${page}`,
    name: `dataset-page-${page}`,
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
  } as ContentItem,
];

const requestedSizes = () =>
  useContentMock.mock.calls
    .map(([params]) => (params as { size?: number } | null)?.size)
    .filter((size): size is number => typeof size === "number");

const requestedPages = () =>
  useContentMock.mock.calls
    .map(([params]) => (params as { page?: number } | null)?.page)
    .filter((page): page is number => typeof page === "number");

describe("ContentPage feed paging", () => {
  beforeEach(() => {
    useContentMock.mockReset();
    // The feed answers with the page it was asked for, as the API does. The
    // collection holds far more rows than one page, so "Load more" stays.
    useContentMock.mockImplementation((params?: { page?: number; size?: number }) => {
      const page = params?.page ?? 1;
      return { page: { items: rowsFor(page), total: 150, page, size: params?.size ?? 50 }, isLoading: false };
    });
    refreshContentFeedMock.mockReset();
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

  it("keeps the request size fixed as further pages are asked for", () => {
    render(<ContentPage />);

    expect(requestedPages()).toContain(1);

    fireEvent.click(screen.getByText("load_more"));
    expect(requestedPages()).toContain(2);

    // The third click is where the old growing `size` (50 × 3 = 150) went
    // past the endpoint's cap of 100 and 422'd.
    fireEvent.click(screen.getByText("load_more"));
    expect(requestedPages()).toContain(3);

    expect(Math.max(...requestedSizes())).toBeLessThanOrEqual(100);
    expect(new Set(requestedSizes())).toEqual(new Set([50]));
  });

  it("lists the pages already loaded along with the newest one", () => {
    render(<ContentPage />);

    expect(screen.getByText("dataset-page-1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("load_more"));
    fireEvent.click(screen.getByText("load_more"));

    // Each page carries only its own rows now, so the ones already listed
    // have to survive the next request rather than being re-read with it.
    expect(screen.getByText("dataset-page-1")).toBeInTheDocument();
    expect(screen.getByText("dataset-page-2")).toBeInTheDocument();
    expect(screen.getByText("dataset-page-3")).toBeInTheDocument();
  });

  it("keeps the rows on screen while a further page is in flight", () => {
    const { rerender } = render(<ContentPage />);
    expect(screen.getByText("dataset-page-1")).toBeInTheDocument();

    // A further page re-keys SWR, which reports no data while it is in
    // flight; blanking the feed for that would throw the reader back to the
    // top of the list.
    useContentMock.mockReturnValue({ page: undefined, isLoading: true });
    rerender(<ContentPage />);

    expect(screen.getByText("dataset-page-1")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-skeleton")).not.toBeInTheDocument();
  });
});
