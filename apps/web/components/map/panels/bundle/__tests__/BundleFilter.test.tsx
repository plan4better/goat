import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BundleFilter from "@/components/map/panels/bundle/BundleFilter";

const { execute, bounds } = vi.hoisted(() => ({
  execute: vi.fn(),
  bounds: { current: [7.1, 50.7, 7.2, 50.8] },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("react-map-gl/maplibre", () => ({
  useMap: () => ({
    map: {
      getBounds: () => ({
        toArray: () => [
          [bounds.current[0], bounds.current[1]],
          [bounds.current[2], bounds.current[3]],
        ],
      }),
    },
  }),
}));
vi.mock("@/lib/api/projects", () => ({ useProject: () => ({ project: { folder_id: "folder-1" } }) }));
vi.mock("@/hooks/map/useOgcProcesses", () => ({ useProcessExecution: () => ({ execute }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => [],
}));

const bundle = { id: "b1", name: "Streets" } as never;
const renderFilter = () => render(<BundleFilter bundle={bundle} projectId="p1" />);
const polygon = ([w, s, e, n]: number[]) => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];

describe("BundleFilter", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ jobID: "job-1" });
    bounds.current = [7.1, 50.7, 7.2, 50.8];
  });

  it("starts without an area and offers to add the map extent", () => {
    renderFilter();
    expect(screen.getByText("filter_bundle_message")).toBeInTheDocument();
    expect(screen.queryByText("save_as_new_bundle")).not.toBeInTheDocument();
  });

  it("filters a new bundle by the map extent, as the copy's filter", async () => {
    renderFilter();
    fireEvent.click(screen.getByText("add_expression"));
    expect(screen.getByText("map_extent")).toBeInTheDocument();
    expect(screen.getByText("SW(7.100, 50.700); NE(7.200, 50.800)")).toBeInTheDocument();

    fireEvent.click(screen.getByText("save_as_new_bundle"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("bundle_create_filtered", {
      source_bundle_id: "b1",
      cql_filter: {
        op: "and",
        args: [
          {
            op: "s_intersects",
            args: [
              { property: "geom" },
              {
                type: "Polygon",
                coordinates: polygon([7.1, 50.7, 7.2, 50.8]),
                properties: { type: "bbox", label: "Map Extent" },
              },
            ],
          },
        ],
      },
      folder_id: "folder-1",
      project_id: "p1",
      result_bundle_name: "Streets (filtered)",
    });
    // The area lives and dies with the panel: gone once the copy is on its way.
    await waitFor(() => expect(screen.queryByText("map_extent")).not.toBeInTheDocument());
  });

  it("takes the extent again on request, and clears it", () => {
    renderFilter();
    fireEvent.click(screen.getByText("add_expression"));
    bounds.current = [8, 51, 9, 52];
    fireEvent.click(screen.getByLabelText("use_current_map_extent"));
    expect(screen.getByText("SW(8.000, 51.000); NE(9.000, 52.000)")).toBeInTheDocument();

    fireEvent.click(screen.getByText("clear_filter"));
    expect(screen.queryByText("map_extent")).not.toBeInTheDocument();
    expect(screen.getByText("filter_bundle_message")).toBeInTheDocument();
  });
});
