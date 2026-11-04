import { beforeEach, describe, expect, it, vi } from "vitest";

import { addItemToProject } from "@/lib/assistant/addToProject";

const api = vi.hoisted(() => ({
  addProjectLayers: vi.fn(),
  addCatalogLayersToProject: vi.fn(),
  addBundleToProject: vi.fn(),
  deleteProjectLayer: vi.fn(async () => undefined),
  deleteProjectLayerGroup: vi.fn(async () => undefined),
}));
/** What the project's layer list holds before the add: layer 5 is already there. */
const swr = vi.hoisted(() => ({ mutate: vi.fn(async () => [{ id: 5, layer_id: "old" }]) }));

vi.mock("swr", () => ({ mutate: swr.mutate }));
vi.mock("@/lib/api/projects", () => ({
  ...api,
  PROJECTS_API_BASE_URL: "https://api.test/api/v2/project",
  projectLayersKey: (id: string) => [`layers:${id}`],
  projectLayerGroupsKey: (id: string) => [`groups:${id}`],
}));

beforeEach(() => vi.clearAllMocks());

describe("addItemToProject", () => {
  it("links a dataset, refreshes the project and undoes only that link", async () => {
    api.addProjectLayers.mockResolvedValue([{ id: 31, layer_id: "d1" }]);
    const added = await addItemToProject("p1", { kind: "dataset", id: "d1", datasetId: "d1", title: "D" });
    expect(api.addProjectLayers).toHaveBeenCalledWith("p1", ["d1"]);
    expect(swr.mutate).toHaveBeenCalledWith(["layers:p1"]);
    expect(added.layers).toEqual([31]);
    await added.undo();
    expect(api.deleteProjectLayer).toHaveBeenCalledWith("p1", 31);
  });

  it("adds a layer from another project by its dataset", async () => {
    api.addProjectLayers.mockResolvedValue([{ id: 32 }]);
    await addItemToProject("p1", { kind: "layer", id: "40", projectId: "p2", datasetId: "d4", title: "L" });
    expect(api.addProjectLayers).toHaveBeenCalledWith("p1", ["d4"]);
  });

  it("never undoes a catalog link that was already in the project", async () => {
    // The server answers with the new link and an existing one it repaired.
    api.addCatalogLayersToProject.mockResolvedValue([{ id: 33 }, { id: 5 }]);
    const added = await addItemToProject("p1", { kind: "catalog", id: "src-x", title: "C" });
    expect(api.addCatalogLayersToProject).toHaveBeenCalledWith("p1", ["src-x"]);
    expect(added.layers).toEqual([33]);
    await added.undo();
    expect(api.deleteProjectLayer).toHaveBeenCalledTimes(1);
    expect(api.deleteProjectLayer).toHaveBeenCalledWith("p1", 33);
  });

  it("adds a bundle as one group and undoes the whole group", async () => {
    api.addBundleToProject.mockResolvedValue({ id: 9 });
    const added = await addItemToProject("p1", { kind: "bundle", id: "b1", title: "GTFS" });
    expect(api.addBundleToProject).toHaveBeenCalledWith("p1", "b1");
    await added.undo();
    expect(api.deleteProjectLayerGroup).toHaveBeenCalledWith("p1", 9);
    expect(api.deleteProjectLayer).not.toHaveBeenCalled();
  });

  it("passes a refusal on", async () => {
    api.addProjectLayers.mockRejectedValue(new Error("Failed to add layers to project"));
    await expect(addItemToProject("p1", { kind: "dataset", id: "d1", title: "D" })).rejects.toThrow();
  });
});
