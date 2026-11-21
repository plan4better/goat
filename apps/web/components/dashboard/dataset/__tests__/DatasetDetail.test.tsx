import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Layer } from "@/lib/validations/layer";

import DatasetDetail from "@/components/dashboard/dataset/DatasetDetail";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({ userProfile: { id: "u-me" } }),
}));

vi.mock("@/components/dashboard/dataset/DatasetMapPreview", () => ({
  default: () => <div data-testid="map" />,
}));

vi.mock("@/hooks/catalog/useCatalogLabels", () => ({
  useCatalogLabels: () => ({
    geometryLabel: (value?: string | null) => value ?? undefined,
    conceptLabel: (value?: string | null) => value ?? undefined,
    languageLabel: (value?: string | null) => value ?? undefined,
    formatDate: (value?: string | null) => value ?? undefined,
  }),
}));

const FIELDS = [{ name: "a", type: "string" }];

vi.mock("@/hooks/useFeaturePage", () => ({
  useFeaturePage: () => ({
    fields: FIELDS,
    areFieldsLoading: false,
    data: {
      type: "FeatureCollection",
      title: "",
      links: [],
      numberMatched: 1,
      numberReturned: 1,
      features: [{ type: "Feature", id: 1, properties: { a: "one" } }],
    },
    isLoading: false,
    rowsPerPage: 25,
    page: 0,
    totalCount: 1,
    onPageChange: () => {},
    onRowsPerPageChange: () => {},
  }),
}));

const datasetOf = (type: Layer["type"], overrides: Partial<Layer> = {}): Layer => {
  const dataset: Partial<Layer> = {
    id: "layer-1",
    name: "Bus stops",
    type,
    description: "A description",
    extent: "POLYGON((0 0,0 1,1 1,1 0,0 0))",
    created_at: "2026-01-02",
    updated_at: "2026-03-04",
    ...overrides,
  };
  return dataset as Layer;
};

beforeAll(() => {
  // The feature table's frame measures its header with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

describe("DatasetDetail", () => {
  it("offers rows but no map of its own for a table", () => {
    render(<DatasetDetail dataset={datasetOf("table")} />);

    expect(screen.getByRole("button", { name: "summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "data" })).toBeInTheDocument();
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
  });

  it("offers rows for a feature layer and draws its map on the summary", () => {
    render(<DatasetDetail dataset={datasetOf("feature")} />);

    expect(screen.getByRole("button", { name: "summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "data" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "map" })).not.toBeInTheDocument();
    expect(screen.getByTestId("map")).toBeInTheDocument();
  });

  it("leaves a raster with the summary alone, its map inside it", () => {
    render(<DatasetDetail dataset={datasetOf("raster")} />);

    expect(screen.getByRole("button", { name: "summary" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "data" })).not.toBeInTheDocument();
    expect(screen.getByTestId("map")).toBeInTheDocument();
  });

  it("shows the rows alone on the data tab", async () => {
    render(<DatasetDetail dataset={datasetOf("table")} />);

    await userEvent.click(screen.getByRole("button", { name: "data" }));

    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText("columns")).not.toBeInTheDocument();
    expect(screen.queryByText("metadata.headings.description")).not.toBeInTheDocument();
  });

  it("names the owner from the layer's own user record", () => {
    render(
      <DatasetDetail
        dataset={datasetOf("table", {
          owned_by: {
            id: "u1",
            firstname: "Ada",
            lastname: "Lovelace",
            newsletter_subscribe: null,
            roles: [],
          },
        })}
      />
    );

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("dates the layer from its own timestamps", () => {
    render(<DatasetDetail dataset={datasetOf("table")} />);

    expect(screen.getByText("created")).toBeInTheDocument();
    expect(screen.getByText("2026-01-02")).toBeInTheDocument();
    expect(screen.getByText("last_updated")).toBeInTheDocument();
    expect(screen.getByText("2026-03-04")).toBeInTheDocument();
  });

  it("badges the licence the catalog record carries", () => {
    render(
      <DatasetDetail
        dataset={datasetOf("table", {
          other_properties: { catalog_item: { license: "CC-BY-4.0" } },
        })}
      />
    );

    expect(screen.getByText("metadata.headings.license")).toBeInTheDocument();
    expect(screen.getByText("CC-BY-4.0")).toBeInTheDocument();
  });

  it("puts the caller's buttons in the header", () => {
    render(<DatasetDetail dataset={datasetOf("table")} actions={<button type="button">Share</button>} />);

    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("drops the description card for a feature layer with nothing to say, keeping the map", () => {
    render(<DatasetDetail dataset={datasetOf("feature", { description: "" })} />);

    expect(screen.queryByText("metadata.headings.description")).not.toBeInTheDocument();
    expect(screen.getByTestId("map")).toBeInTheDocument();
  });

  it("keeps a mapless table's summary from being blank", () => {
    render(<DatasetDetail dataset={datasetOf("table", { description: "" })} />);

    expect(screen.getByText("metadata.headings.description")).toBeInTheDocument();
    expect(screen.getByText("no_description")).toBeInTheDocument();
  });

  it("keeps the description block for tags alone, with the keywords under them", () => {
    render(<DatasetDetail dataset={datasetOf("table", { description: "", tags: ["transit"] })} />);

    expect(screen.getByText("metadata.headings.description")).toBeInTheDocument();
    expect(screen.getByText("no_description")).toBeInTheDocument();
    expect(screen.getByText("catalog_keywords")).toBeInTheDocument();
    expect(screen.getByText("transit")).toBeInTheDocument();
  });

  it("shows the lineage the catalog record carries under the description", () => {
    render(
      <DatasetDetail
        dataset={datasetOf("table", {
          other_properties: { catalog_item: { "processing:lineage": "Harvested weekly" } },
        })}
      />
    );

    expect(screen.getByText("metadata.headings.lineage")).toBeInTheDocument();
    expect(screen.getByText("Harvested weekly")).toBeInTheDocument();
  });

  describe("where it comes from", () => {
    const SIGNED = "https://maplibre.org/maplibre-gl-js/docs/assets/cog.tif?sig=x";
    const remoteCog = (user_id: string) =>
      datasetOf("raster", { data_type: "cog", url: SIGNED, user_id } as Partial<Layer>);

    it("says a remote file is one, with its address as the Metadata tab gives it", () => {
      render(<DatasetDetail dataset={remoteCog("u-other")} />);

      expect(screen.getByText("source")).toBeInTheDocument();
      expect(screen.getByText("metadata.source_remote_file")).toBeInTheDocument();
      expect(screen.getByText("address")).toBeInTheDocument();
      // Someone else's dataset: the address without its query string, as on a shared map.
      const link = screen.getByRole("link");
      expect(link.textContent).toBe("maplibre.org/…/cog.tif");
      expect(link.getAttribute("href")).toBe("https://maplibre.org/maplibre-gl-js/docs/assets/cog.tif");
      expect(screen.getByRole("button", { name: "metadata.copy_address" })).toBeInTheDocument();
    });

    it("shows the owner of the dataset its whole address", () => {
      render(<DatasetDetail dataset={remoteCog("u-me")} />);

      expect(screen.getByRole("link").getAttribute("href")).toBe(SIGNED);
    });

    it("says a WFS layer is a copy, with the service it came from", () => {
      render(
        <DatasetDetail
          dataset={datasetOf("feature", {
            data_type: "wfs",
            other_properties: { url: "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis?SERVICE=WFS" },
          } as Partial<Layer>)}
        />
      );

      expect(screen.getByText("metadata.source_wfs_copy")).toBeInTheDocument();
      expect(screen.getByText("www.wfs.nrw.de/…/wfs_nw_alkis")).toBeInTheDocument();
    });

    it("says nothing of a source or an address for an upload", () => {
      render(<DatasetDetail dataset={datasetOf("feature")} />);

      expect(screen.queryByText("source")).not.toBeInTheDocument();
      expect(screen.queryByText("address")).not.toBeInTheDocument();
    });
  });
});
