import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ContentAddMenu from "@/components/dashboard/content/ContentAddMenu";

const { createProjectMock, createFolderMock, pushMock, addLayerDialogMock, projectImportMock } = vi.hoisted(
  () => ({
    createProjectMock: vi.fn(),
    createFolderMock: vi.fn(),
    pushMock: vi.fn(),
    addLayerDialogMock: vi.fn(),
    projectImportMock: vi.fn(),
  })
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("swr", () => ({ mutate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("@/lib/api/content", () => ({ refreshContentFeed: vi.fn() }));
vi.mock("@/lib/api/users", () => ({ USERS_API_BASE_URL: "http://core/api/v2/users" }));
vi.mock("@/lib/api/folders", () => ({
  FOLDERS_API_BASE_URL: "folders",
  createFolder: (...args: unknown[]) => createFolderMock(...args),
}));
vi.mock("@/lib/api/projects", () => ({
  createProject: (payload: unknown) => createProjectMock(payload),
}));
vi.mock("@/components/addLayer/AddLayerDialog", () => ({
  default: (props: { source: string; defaultFolderId?: string }) => {
    addLayerDialogMock(props);
    return null;
  },
}));
vi.mock("@/components/modals/DocumentUpload", () => ({ default: () => null }));
vi.mock("@/components/modals/ProjectImport", () => ({
  default: (props: { open: boolean; defaultFolderId?: string }) => {
    projectImportMock(props);
    return null;
  },
}));

const pick = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: "add_new" }));
  fireEvent.click(screen.getByText(label));
};

describe("ContentAddMenu", () => {
  beforeEach(() => {
    createProjectMock.mockReset().mockResolvedValue({ id: "p-1" });
    createFolderMock.mockReset().mockResolvedValue({ id: "f-1" });
    pushMock.mockReset();
    addLayerDialogMock.mockReset();
    projectImportMock.mockReset();
  });

  it("creates a folder under the folder being browsed, by name alone", async () => {
    render(
      <ContentAddMenu folderId="folder-a" homeFolderId="home-1" spaceId="space-1" spaceKind="personal" />
    );

    pick("new_folder");
    fireEvent.change(screen.getByLabelText("new_folder"), { target: { value: "Drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "create_folder" }));

    await waitFor(() => expect(createFolderMock).toHaveBeenCalledWith("Drafts", "folder-a", "space-1"));
  });

  it("creates a folder at the space's own root when nothing is being browsed", async () => {
    render(<ContentAddMenu folderId={null} homeFolderId="home-1" spaceId="space-1" spaceKind="personal" />);

    pick("new_folder");
    fireEvent.change(screen.getByLabelText("new_folder"), { target: { value: "Drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "create_folder" }));

    await waitFor(() => expect(createFolderMock).toHaveBeenCalledWith("Drafts", null, "space-1"));
  });

  it("creates a project with name only in the folder being browsed, then opens the builder", async () => {
    render(
      <ContentAddMenu folderId="folder-a" homeFolderId="home-1" spaceId="space-1" spaceKind="personal" />
    );

    pick("blank_project");
    fireEvent.change(screen.getByLabelText("new_project"), { target: { value: "Bus stops" } });
    fireEvent.click(screen.getByRole("button", { name: "create_project" }));

    await waitFor(() =>
      expect(createProjectMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Bus stops", folder_id: "folder-a" })
      )
    );
    // Defaults the old create dialog carried, now supplied without a form.
    const payload = createProjectMock.mock.calls[0][0];
    expect(payload.initial_view_state).toEqual(expect.objectContaining({ zoom: 12 }));
    expect(payload.thumbnail_url).toContain("goat_new_project_artwork");
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p-1"));
  });

  it("targets the space's home folder for a project created at the root", async () => {
    render(<ContentAddMenu folderId={null} homeFolderId="home-1" spaceId="space-1" spaceKind="personal" />);

    pick("blank_project");
    fireEvent.change(screen.getByLabelText("new_project"), { target: { value: "Bus stops" } });
    fireEvent.click(screen.getByRole("button", { name: "create_project" }));

    await waitFor(() =>
      expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({ folder_id: "home-1" }))
    );
  });

  it("opens the upload dialog straight away for Dataset, with no source menu in between", () => {
    render(
      <ContentAddMenu folderId="folder-a" homeFolderId="home-1" spaceId="space-1" spaceKind="personal" />
    );

    expect(addLayerDialogMock).not.toHaveBeenCalled();

    pick("dataset");

    expect(addLayerDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "upload", defaultFolderId: "folder-a" })
    );
  });

  it("opens the project import with the folder being browsed pre-selected", () => {
    render(
      <ContentAddMenu folderId="folder-a" homeFolderId="home-1" spaceId="space-1" spaceKind="personal" />
    );

    expect(projectImportMock).not.toHaveBeenCalled();

    pick("import_project");

    expect(projectImportMock).toHaveBeenCalledWith(
      expect.objectContaining({ open: true, defaultFolderId: "folder-a" })
    );
  });

  it("disables Project, Dataset and Document while a non-personal space has no root folder", () => {
    render(<ContentAddMenu folderId={null} homeFolderId={undefined} spaceId="space-team" spaceKind="team" />);

    fireEvent.click(screen.getByRole("button", { name: "add_new" }));

    const ariaDisabled = (label: string) =>
      screen.getByText(label).closest("li")?.getAttribute("aria-disabled");

    // A folder can still be created — its root is `parent_id: null`, not the
    // space's `home` folder.
    expect(ariaDisabled("new_folder")).toBeNull();
    for (const label of ["blank_project", "import_project", "dataset", "upload_document"]) {
      expect(ariaDisabled(label)).toBe("true");
    }
  });
});
