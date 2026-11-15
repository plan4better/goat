import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";

import MoveDialog from "@/components/modals/content/MoveDialog";

const {
  updateFolderMock,
  updateProjectMock,
  updateDatasetMock,
  updateBundleMock,
  updateTemplateMock,
  refreshTemplatesMock,
  refreshContentFeedMock,
  toastSuccessMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  updateFolderMock: vi.fn(),
  updateProjectMock: vi.fn(),
  updateDatasetMock: vi.fn(),
  updateBundleMock: vi.fn(),
  updateTemplateMock: vi.fn(),
  refreshTemplatesMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));
vi.mock("react-toastify", () => ({ toast: { success: toastSuccessMock, error: toastErrorMock } }));
vi.mock("swr", () => ({ mutate: vi.fn() }));
vi.mock("@/lib/api/content", () => ({ refreshContentFeed: refreshContentFeedMock }));
vi.mock("@/lib/api/folders", () => ({ updateFolder: updateFolderMock }));
vi.mock("@/lib/api/projects", () => ({ updateProject: updateProjectMock }));
vi.mock("@/lib/api/layers", () => ({ updateDataset: updateDatasetMock }));
vi.mock("@/lib/api/bundles", () => ({ updateBundle: updateBundleMock }));
vi.mock("@/lib/api/templates", () => ({
  updateTemplate: updateTemplateMock,
  refreshTemplates: refreshTemplatesMock,
}));

const space: Space = {
  id: "space-1",
  kind: "team",
  name: "Design Team",
  default_role: "viewer",
  my_role: "owner",
  team_id: "team-1",
  organization_id: null,
};

const noop = () => {};

const baseItem = {
  space_id: "space-1",
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner" as const,
  shared_with: null,
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
};

describe("MoveDialog", () => {
  beforeEach(() => {
    updateFolderMock.mockReset().mockResolvedValue(undefined);
    updateProjectMock.mockReset().mockResolvedValue(undefined);
    updateDatasetMock.mockReset().mockResolvedValue(undefined);
    updateBundleMock.mockReset().mockResolvedValue(undefined);
    updateTemplateMock.mockReset().mockResolvedValue(undefined);
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("moves a layer into a nested folder", async () => {
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "a-1",
        name: "A",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "b-1",
        name: "B",
        parent_id: "a-1",
        space_id: "space-1",
        depth: 1,
        is_owned: true,
        restricted: false,
      },
    ];
    const layer: ContentItem = {
      ...baseItem,
      type: "layer",
      id: "layer-1",
      name: "Layer 1",
      folder_id: "a-1",
    };

    render(
      <MoveDialog
        items={[layer]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );
    // Named by its title, as every AppDialog is.
    expect(screen.getByRole("dialog", { name: /^move_title/ })).toBeInTheDocument();

    expect(screen.getByText("A")).toBeInTheDocument();
    fireEvent.click(screen.getByText("A"));

    expect(screen.getByText("B")).toBeInTheDocument();
    fireEvent.click(screen.getByText("B"));

    expect(screen.getByText("no_folders_here")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(updateDatasetMock).toHaveBeenCalledWith("layer-1", { folder_id: "b-1" }));
    expect(refreshContentFeedMock).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("moved_success");
  });

  it("toasts an error and keeps the dialog open when the dataset move is refused", async () => {
    // `updateDataset` throws on a non-OK response, so a write-denied
    // destination folder is reported as a failure rather than as a success
    // with the item left where it was.
    updateDatasetMock.mockRejectedValue(new Error("Failed to update dataset"));
    const onMoved = vi.fn();
    const onClose = vi.fn();
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "a-1",
        name: "A",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
    ];
    const layer: ContentItem = {
      ...baseItem,
      type: "layer",
      id: "layer-1",
      name: "Layer 1",
      folder_id: "home-1",
    };

    render(
      <MoveDialog
        items={[layer]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={onClose}
        onMoved={onMoved}
      />
    );

    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("error_moving_content"));
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // The selection is not cleared and the dialog is not closed on a refusal.
    expect(onMoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves a template with the template endpoint, never the bundle one", async () => {
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "a-1",
        name: "A",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
    ];
    const template: ContentItem = {
      ...baseItem,
      type: "template",
      id: "tmpl-1",
      name: "Bus network",
      folder_id: "home-1",
    };

    render(
      <MoveDialog
        items={[template]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );

    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(updateTemplateMock).toHaveBeenCalledWith("tmpl-1", { folder_id: "a-1" }));
    expect(updateBundleMock).not.toHaveBeenCalled();
    // The template lists have their own SWR keys.
    expect(refreshTemplatesMock).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("moved_success");
  });

  it("moves a template to the space root through its home folder", async () => {
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
    ];
    const template: ContentItem = {
      ...baseItem,
      type: "template",
      id: "tmpl-1",
      name: "Bus network",
      folder_id: "a-1",
    };

    render(
      <MoveDialog
        items={[template]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(updateTemplateMock).toHaveBeenCalledWith("tmpl-1", { folder_id: "home-1" }));
  });

  it("still refreshes the feed and shows an error toast when a later item in the batch fails", async () => {
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "a-1",
        name: "A",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
    ];
    const layer1: ContentItem = {
      ...baseItem,
      type: "layer",
      id: "layer-1",
      name: "Layer 1",
      folder_id: null,
    };
    const layer2: ContentItem = {
      ...baseItem,
      type: "layer",
      id: "layer-2",
      name: "Layer 2",
      folder_id: null,
    };
    // The first item's move succeeds, the second rejects — the batch is
    // sequential, so this exercises the "some items already moved" case.
    updateDatasetMock
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("network error"));

    render(
      <MoveDialog
        items={[layer1, layer2]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );

    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("error_moving_content"));
    expect(updateDatasetMock).toHaveBeenCalledTimes(2);
    expect(refreshContentFeedMock).toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("excludes the moving folder and its descendant from the root list, and moves it to the root", async () => {
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "a-1",
        name: "A",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "b-1",
        name: "B",
        parent_id: "a-1",
        space_id: "space-1",
        depth: 1,
        is_owned: true,
        restricted: false,
      },
    ];
    const folderA: ContentItem = { ...baseItem, type: "folder", id: "a-1", name: "A", folder_id: null };

    render(
      <MoveDialog
        items={[folderA]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );

    expect(screen.queryByText("A")).not.toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    expect(screen.getByText("no_folders_here")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(updateFolderMock).toHaveBeenCalledWith("a-1", { parent_id: null }));
  });

  it("lists a root folder whose parent_id the API left out entirely", async () => {
    // The folder list endpoint omits `parent_id` for a root folder rather
    // than sending null, and the response is handed on unparsed.
    const rootFolder = {
      id: "a-1",
      name: "A",
      space_id: "space-1",
      depth: 0,
      is_owned: true,
      restricted: false,
    } as Folder;
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      rootFolder,
    ];
    const layer: ContentItem = {
      ...baseItem,
      type: "layer",
      id: "layer-1",
      name: "Layer 1",
      folder_id: null,
    };

    render(
      <MoveDialog
        items={[layer]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );

    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: "move_here" }));

    await waitFor(() => expect(updateDatasetMock).toHaveBeenCalledWith("layer-1", { folder_id: "a-1" }));
  });

  it("disables move_here when the moved folder's subtree would land past the depth limit", () => {
    const folders: Folder[] = [
      {
        id: "home-1",
        name: "home",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "d-1",
        name: "D",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "e-1",
        name: "E",
        parent_id: "d-1",
        space_id: "space-1",
        depth: 1,
        is_owned: true,
        restricted: false,
      },
      {
        id: "a-1",
        name: "A",
        parent_id: null,
        space_id: "space-1",
        depth: 0,
        is_owned: true,
        restricted: false,
      },
      {
        id: "b-1",
        name: "B",
        parent_id: "a-1",
        space_id: "space-1",
        depth: 1,
        is_owned: true,
        restricted: false,
      },
      {
        id: "c-1",
        name: "C",
        parent_id: "b-1",
        space_id: "space-1",
        depth: 2,
        is_owned: true,
        restricted: false,
      },
    ];
    const folderA: ContentItem = { ...baseItem, type: "folder", id: "a-1", name: "A", folder_id: null };

    render(
      <MoveDialog
        items={[folderA]}
        space={space}
        folders={folders}
        homeFolderId="home-1"
        onClose={noop}
        onMoved={noop}
      />
    );

    fireEvent.click(screen.getByText("D"));
    fireEvent.click(screen.getByText("E"));

    expect(screen.getByText("folder_depth_limit")).toBeInTheDocument();
    const moveHere = screen.getByRole("button", { name: "move_here" });
    expect(moveHere).toHaveProperty("disabled", true);
  });
});
