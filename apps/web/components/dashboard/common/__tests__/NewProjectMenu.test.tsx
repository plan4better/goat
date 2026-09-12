import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NEW_PROJECT_ITEMS,
  NewProjectButton,
  NewProjectFlows,
} from "@/components/dashboard/common/NewProjectMenu";

const { createProjectMock, pushMock, refreshContentFeedMock, mutateMock, nameDialogMock, projectImportMock } =
  vi.hoisted(() => ({
    createProjectMock: vi.fn(),
    pushMock: vi.fn(),
    refreshContentFeedMock: vi.fn(),
    mutateMock: vi.fn(),
    nameDialogMock: vi.fn(),
    projectImportMock: vi.fn(),
  }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("swr", () => ({ mutate: mutateMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("@/lib/api/content", () => ({ refreshContentFeed: refreshContentFeedMock }));
vi.mock("@/lib/api/users", () => ({ USERS_API_BASE_URL: "http://core/api/v2/users" }));
vi.mock("@/lib/api/projects", () => ({
  createProject: (payload: unknown) => createProjectMock(payload),
}));
vi.mock("@/components/dashboard/common/NameDialog", () => ({
  default: (props: { onSubmit: (name: string) => Promise<void> }) => {
    nameDialogMock(props);
    return (
      <button type="button" onClick={() => void props.onSubmit("Bus stops")}>
        submit-name
      </button>
    );
  },
}));
vi.mock("@/components/modals/ProjectImport", () => ({
  default: (props: { open: boolean; defaultFolderId?: string }) => {
    projectImportMock(props);
    return <div data-testid="project-import" />;
  },
}));

describe("NewProjectMenu", () => {
  beforeEach(() => {
    createProjectMock.mockReset().mockResolvedValue({ id: "p-1" });
    pushMock.mockReset();
    refreshContentFeedMock.mockReset();
    mutateMock.mockReset();
    nameDialogMock.mockReset();
    projectImportMock.mockReset();
  });

  it("offers the two project starts, in one order, behind the button", () => {
    render(<NewProjectButton location={{ folderId: "home-1" }} />);

    expect(NEW_PROJECT_ITEMS.map((item) => item.key)).toEqual(["blank", "import"]);
    // Nothing is mounted until an entry is picked.
    expect(projectImportMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "new_project" }));

    expect(screen.getByText("blank_project")).toBeInTheDocument();
    expect(screen.queryByText("from_template")).not.toBeInTheDocument();
    // The import asks for a file before anything happens, so its entry says so.
    expect(screen.getByText("import_project")).toBeInTheDocument();
  });

  it("creates a blank project by name alone in the given folder, then opens the builder", async () => {
    render(<NewProjectFlows intent="blank" onClose={vi.fn()} location={{ folderId: "folder-a" }} />);

    fireEvent.click(screen.getByText("submit-name"));

    await waitFor(() =>
      expect(createProjectMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Bus stops", folder_id: "folder-a" })
      )
    );
    const payload = createProjectMock.mock.calls[0][0];
    expect(payload.initial_view_state).toEqual(expect.objectContaining({ zoom: 12 }));
    expect(payload.thumbnail_url).toContain("goat_new_project_artwork");
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p-1"));
    expect(refreshContentFeedMock).toHaveBeenCalled();
    expect(mutateMock).toHaveBeenCalledWith("http://core/api/v2/users/me/onboarding");
  });

  it("opens the import modal with the current folder pre-selected", () => {
    render(<NewProjectFlows intent="import" onClose={vi.fn()} location={{ folderId: "folder-a" }} />);

    expect(screen.getByTestId("project-import")).toBeInTheDocument();
    expect(projectImportMock).toHaveBeenCalledWith(
      expect.objectContaining({ open: true, defaultFolderId: "folder-a" })
    );
  });

  it("mounts no flow at all while no start has been picked", () => {
    render(<NewProjectFlows intent={null} onClose={vi.fn()} location={{}} />);

    expect(nameDialogMock).not.toHaveBeenCalled();
    expect(projectImportMock).not.toHaveBeenCalled();
  });
});
