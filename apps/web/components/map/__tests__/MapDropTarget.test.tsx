import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MapDropTarget from "@/components/map/MapDropTarget";

const { importMock } = vi.hoisted(() => ({ importMock: vi.fn() }));

vi.mock("@/hooks/addLayer/useDatasetImport", () => ({
  useDatasetImport: () => ({ importDataset: importMock }),
}));
vi.mock("@/lib/api/projects", () => ({ useProject: () => ({ project: { folder_id: "f1" } }) }));
vi.mock("@/lib/api/bundles", () => ({ detectBundleType: async () => null }));
vi.mock("@/components/addLayer/AddLayerDialog", () => ({ default: () => null }));
vi.mock("react-toastify", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function drop(target: Element, file: File) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
  target.dispatchEvent(event);
}

beforeEach(() => importMock.mockReset());

describe("MapDropTarget", () => {
  it("imports a data file dropped on the editor", async () => {
    render(<MapDropTarget projectId="p1" />);
    drop(document.body, new File(["{}"], "netz.geojson"));
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1));
  });

  it("leaves a drop on the assistant dock to the dock", () => {
    render(<MapDropTarget projectId="p1" />);
    const dock = document.createElement("aside");
    dock.setAttribute("data-assistant-dock", "");
    document.body.appendChild(dock);
    drop(dock, new File(["{}"], "netz.geojson"));
    expect(importMock).not.toHaveBeenCalled();
    dock.remove();
  });

  it("leaves a drop on a popper to it: the style editor's icon picker takes its own", () => {
    render(<MapDropTarget projectId="p1" />);
    const popper = document.createElement("div");
    popper.className = "MuiPopper-root";
    document.body.appendChild(popper);
    drop(popper, new File(["{}"], "netz.geojson"));
    expect(importMock).not.toHaveBeenCalled();
    popper.remove();
  });
});
