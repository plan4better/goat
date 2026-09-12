import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Metadata from "@/components/modals/Metadata";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("swr", () => ({ mutate: vi.fn() }));

const updateDataset = vi.fn().mockResolvedValue(undefined);
const updateProject = vi.fn().mockResolvedValue(undefined);
const updateBundle = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/api/layers", () => ({ updateDataset: (...args: unknown[]) => updateDataset(...args) }));
vi.mock("@/lib/api/projects", () => ({
  PROJECTS_API_BASE_URL: "/projects",
  updateProject: (...args: unknown[]) => updateProject(...args),
}));
vi.mock("@/lib/api/datasets", () => ({ matchesContentListKey: () => false }));
// A module-level constant so every render's `useBundle` call returns the
// same object reference; a fresh literal per call would re-fire the
// dialog's `reset` effect on every render and loop.
const { BUNDLE } = vi.hoisted(() => ({
  BUNDLE: {
    id: "b1",
    name: "Roads",
    description: "Streets",
    folder_id: "f1",
    bundle_type: "street_network",
    content_type: "bundle",
    dataset_metadata: { license: "DL-DE-BY-2.0", data_reference_year: 2023 },
  },
}));
// `isBundleTile` is exercised for real (it keys off `content_type`), so a
// fixture that is not truly bundle-shaped takes the real non-bundle branch
// rather than an approximation the mock happens to accept.
vi.mock("@/lib/api/bundles", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/bundles")>("@/lib/api/bundles");
  return {
    ...actual,
    updateBundle: (...args: unknown[]) => updateBundle(...args),
    useBundle: (id: string | null) => (id ? { bundle: BUNDLE } : { bundle: undefined }),
  };
});
vi.mock("@/hooks/map/ContentMetadataHooks", () => ({
  useContentMetadataHooks: () => ({
    geographicalCodeOptions: [
      { value: "DE", label: "Germany", icon: "🇩🇪" },
      { value: "AT", label: "Austria", icon: "🇦🇹" },
    ],
  }),
}));

const layer = {
  id: "l1",
  folder_id: "f1",
  name: "Stops",
  description: "All stops",
  tags: ["transit"],
  type: "feature",
  extra_column_the_api_must_not_get_back: "x",
} as never;

const project = {
  id: "p1",
  folder_id: "f1",
  name: "Plan",
  description: "",
  tags: [],
  layer_order: [1, 2],
} as never;

describe("Metadata dialog", () => {
  beforeEach(() => {
    updateDataset.mockClear();
    updateProject.mockClear();
    updateBundle.mockClear();
  });

  it("shows name, description and tags for a dataset with labels above the fields", () => {
    render(<Metadata open onClose={() => {}} content={layer} type="layer" />);
    expect(screen.getByText("edit_metadata")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("description")).toBeInTheDocument();
    expect(screen.getByText("tags")).toBeInTheDocument();
    expect(screen.getByText("transit")).toBeInTheDocument();
    expect(screen.queryByText("metadata.heading_titles.basic")).toBeNull();
    expect(document.querySelector("label.MuiInputLabel-root")).toBeNull();
  });

  it("saves a dataset with only name, description and tags", async () => {
    render(<Metadata open onClose={() => {}} content={layer} type="layer" />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Bus stops" } });
    const submitButton = screen.getByRole("button", { name: "update" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    fireEvent.click(submitButton);
    await waitFor(() => expect(updateDataset).toHaveBeenCalledTimes(1));
    expect(updateDataset).toHaveBeenCalledWith("l1", {
      folder_id: "f1",
      name: "Bus stops",
      description: "All stops",
      tags: ["transit"],
    });
  });

  it("saves a project without echoing the rest of the tile", async () => {
    render(<Metadata open onClose={() => {}} content={project} type="project" />);
    const submitButton = screen.getByRole("button", { name: "update" }) as HTMLButtonElement;
    await waitFor(() => expect(submitButton.disabled).toBe(false));
    fireEvent.click(submitButton);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(Object.keys(updateProject.mock.calls[0][1]).sort()).toEqual([
      "description",
      "folder_id",
      "name",
      "tags",
    ]);
  });

  it("shows the provenance groups for a bundle and hides tags", async () => {
    const bundle = {
      id: "b1",
      folder_id: "f1",
      name: "Roads",
      bundle_type: "street_network",
      content_type: "bundle",
    } as never;
    render(<Metadata open onClose={() => {}} content={bundle} type="layer" />);
    await waitFor(() => expect(screen.getByDisplayValue("DL-DE-BY-2.0")).toBeInTheDocument());
    expect(screen.getByText("metadata.heading_titles.data_quality")).toBeInTheDocument();
    expect(screen.getByText("metadata.heading_titles.distribution")).toBeInTheDocument();
    expect(screen.getByText("metadata.headings.geographical_code")).toBeInTheDocument();
    expect(screen.queryByText("tags")).toBeNull();
    expect(document.querySelector("label.MuiInputLabel-root")).toBeNull();
  });
});
