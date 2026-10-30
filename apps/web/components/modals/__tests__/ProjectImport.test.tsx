import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestDatasetUpload } from "@/lib/api/datasets";
import { executeProcessAsync } from "@/lib/api/processes";
import { OutOfCreditsError } from "@/lib/utils/credits";
import type { Folder } from "@/lib/validations/folder";

import ProjectImportModal from "@/components/modals/ProjectImport";

const { useFoldersMock } = vi.hoisted(() => ({
  useFoldersMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/datasets", () => ({ requestDatasetUpload: vi.fn() }));
vi.mock("@/lib/api/folders", () => ({ useFolders: useFoldersMock }));
vi.mock("@/lib/api/processes", () => ({ executeProcessAsync: vi.fn() }));
vi.mock("@/lib/services/s3", () => ({ uploadFileToS3: vi.fn() }));
vi.mock("@/lib/store/jobs/slice", () => ({ setRunningJobIds: vi.fn() }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => [],
}));
vi.mock("@/lib/api/content", () => ({
  useSpaces: () => ({
    spaces: [
      {
        id: "space-1",
        kind: "personal",
        name: "My Content",
        default_role: "viewer",
        my_role: "owner",
        team_id: null,
        organization_id: null,
      },
    ],
  }),
}));

const homeFolder: Folder = {
  id: "home-1",
  name: "home",
  parent_id: null,
  space_id: "space-1",
  depth: 0,
  is_owned: true,
  restricted: false,
};

const subFolder: Folder = {
  id: "folder-1",
  name: "Field surveys",
  parent_id: null,
  space_id: "space-1",
  depth: 0,
  is_owned: true,
  restricted: false,
};

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

const pickFile = (name: string) => {
  fireEvent.change(fileInput(), {
    target: { files: [new File(["x"], name, { type: "application/zip" })] },
  });
};

const importButton = () => screen.getByRole("button", { name: "import" }) as HTMLButtonElement;

describe("ProjectImport", () => {
  beforeEach(() => {
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, subFolder] });
  });

  it("offers the drop zone and the import action", () => {
    render(<ProjectImportModal open onClose={() => {}} />);

    expect(screen.getByText("import_project")).toBeInTheDocument();
    expect(screen.getByText("upload_drop_or_browse")).toBeInTheDocument();
    expect(fileInput().accept).toBe(".zip");
    expect(importButton().disabled).toBe(true);
  });

  it("labels the destination the way every other destination dialog does", () => {
    render(<ProjectImportModal open onClose={() => {}} />);

    expect(screen.getByText("destination")).toBeInTheDocument();
    expect(screen.getByText("folder")).toBeInTheDocument();
    expect(screen.queryByText("folder_location")).not.toBeInTheDocument();
  });

  it("swaps the drop zone for the chosen archive and allows the import", () => {
    render(<ProjectImportModal open defaultFolderId="folder-1" onClose={() => {}} />);

    pickFile("bonn-mobility.zip");

    expect(screen.queryByText("upload_drop_or_browse")).not.toBeInTheDocument();
    expect(screen.getByText(/bonn-mobility\.zip/)).toBeInTheDocument();
    expect(screen.getByText("project_name")).toBeInTheDocument();
    expect(importButton().disabled).toBe(false);
  });

  it("refuses anything but a zip and keeps the drop zone", () => {
    render(<ProjectImportModal open defaultFolderId="folder-1" onClose={() => {}} />);

    pickFile("layer.gpkg");

    expect(screen.getByText("invalid_file_type")).toBeInTheDocument();
    expect(screen.getByText("upload_drop_or_browse")).toBeInTheDocument();
    expect(importButton().disabled).toBe(true);
  });

  it("brings the drop zone back when the archive is removed", () => {
    render(<ProjectImportModal open defaultFolderId="folder-1" onClose={() => {}} />);

    pickFile("bonn-mobility.zip");
    fireEvent.click(screen.getByRole("button", { name: "upload_remove_file" }));

    expect(screen.getByText("upload_drop_or_browse")).toBeInTheDocument();
    expect(importButton().disabled).toBe(true);
  });

  it("stands in the folder being browsed", () => {
    render(<ProjectImportModal open defaultFolderId="folder-1" onClose={() => {}} />);

    expect(screen.getByText("Field surveys")).toBeInTheDocument();
  });

  const runImport = async () => {
    vi.mocked(requestDatasetUpload).mockResolvedValue({ key: "k" } as never);
    render(<ProjectImportModal open defaultFolderId="folder-1" onClose={() => {}} />);
    pickFile("bonn-mobility.zip");
    fireEvent.click(importButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  };

  it("tells the user when the import is refused for lack of credits", async () => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(executeProcessAsync).mockRejectedValue(new OutOfCreditsError());
    await runImport();
    expect(toast.error).toHaveBeenCalledWith("out_of_credits_tool");
  });

  it("keeps the generic message for any other failure", async () => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(executeProcessAsync).mockRejectedValue(new Error("boom"));
    await runImport();
    expect(toast.error).toHaveBeenCalledWith("error_importing_project");
  });
});
