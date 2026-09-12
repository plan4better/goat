import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Layer } from "@/lib/validations/layer";

import DatasetUpdateModal from "@/components/modals/DatasetUpdate";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/datasets", () => ({ requestDatasetUpload: vi.fn() }));
vi.mock("@/lib/api/layers", () => ({ updateLayerDataset: vi.fn() }));
vi.mock("@/lib/api/processes", () => ({ useJobs: () => ({ mutate: vi.fn() }) }));
vi.mock("@/lib/services/s3", () => ({ uploadFileToS3: vi.fn() }));
vi.mock("@/lib/store/jobs/slice", () => ({ setRunningJobIds: vi.fn() }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => [],
}));

const layer = { id: "layer-1", name: "Bus stops", type: "feature" } as unknown as Layer;

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

const pickFile = (name: string) => {
  fireEvent.change(fileInput(), { target: { files: [new File(["x"], name)] } });
};

const updateButton = () => screen.getByRole("button", { name: "update" }) as HTMLButtonElement;

describe("DatasetUpdate", () => {
  it("offers the drop zone and the update action", () => {
    render(<DatasetUpdateModal open type="layer" content={layer} onClose={() => {}} />);

    expect(screen.getByText("dataset_update")).toBeInTheDocument();
    expect(screen.getByText("upload_drop_or_browse")).toBeInTheDocument();
    expect(fileInput().accept).toContain(".gpkg");
    expect(updateButton().disabled).toBe(true);
  });

  it("swaps the drop zone for the chosen file and allows the update", () => {
    render(<DatasetUpdateModal open type="layer" content={layer} onClose={() => {}} />);

    pickFile("stops.gpkg");

    expect(screen.queryByText("upload_drop_or_browse")).not.toBeInTheDocument();
    expect(screen.getByText(/stops\.gpkg/)).toBeInTheDocument();
    expect(updateButton().disabled).toBe(false);
  });

  it("refuses a format it cannot import and keeps the drop zone", () => {
    render(<DatasetUpdateModal open type="layer" content={layer} onClose={() => {}} />);

    pickFile("notes.txt");

    expect(screen.getByText("invalid_file_type")).toBeInTheDocument();
    expect(screen.getByText("upload_drop_or_browse")).toBeInTheDocument();
    expect(updateButton().disabled).toBe(true);
  });

  it("brings the drop zone back when the file is removed", () => {
    render(<DatasetUpdateModal open type="layer" content={layer} onClose={() => {}} />);

    pickFile("stops.gpkg");
    fireEvent.click(screen.getByRole("button", { name: "upload_remove_file" }));

    expect(screen.getByText("upload_drop_or_browse")).toBeInTheDocument();
    expect(updateButton().disabled).toBe(true);
  });

  it("shows a WFS layer its source instead of a drop zone", () => {
    const wfs = {
      ...layer,
      data_type: "wfs",
      other_properties: { url: "https://wfs.example", layers: "stops" },
    };
    render(<DatasetUpdateModal open type="layer" content={wfs as unknown as Layer} onClose={() => {}} />);

    expect(screen.queryByText("upload_drop_or_browse")).not.toBeInTheDocument();
    expect(screen.getByText(/https:\/\/wfs\.example/)).toBeInTheDocument();
    expect(updateButton().disabled).toBe(false);
  });
});
