import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PropertiesPanel from "@/components/map/panels/properties/Properties";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // A file's format and a map service's kind are part of what its row says, so they are kept.
    t: (key: string, options?: { kind?: string }) => (options?.kind ? `${key}:${options.kind}` : key),
    i18n: { exists: () => false, language: "en" },
  }),
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));

// The dataset's queryables and feature count: what the other tabs already asked for, keyed by the layer.
const data = vi.hoisted(() => ({
  queryables: undefined as { properties: Record<string, unknown> } | undefined,
  featureCount: undefined as number | undefined,
  asked: { queryables: [] as string[], count: [] as (string | undefined)[] },
}));
vi.mock("@/lib/api/layers", async (original) => ({
  ...(await original<object>()),
  useLayerQueryables: (layerId: string) => {
    data.asked.queryables.push(layerId);
    return { queryables: layerId ? data.queryables : undefined, isLoading: false };
  },
}));
vi.mock("@/lib/api/processes", async (original) => ({
  ...(await original<object>()),
  useFeatureCount: (layerId: string | undefined) => {
    data.asked.count.push(layerId);
    return { featureCount: layerId ? data.featureCount : undefined, isLoading: false };
  },
}));

afterEach(() => {
  data.queryables = undefined;
  data.featureCount = undefined;
  data.asked = { queryables: [], count: [] };
});

const CATALOG_ITEM = {
  id: "da6143c8-519a-4f10-8095-b87c8f34ce74",
  publisher: "Landesamt für Umwelt (LfU)",
  updated: "2026-08-16T10:55:42Z",
};

const layer = (other_properties?: unknown) =>
  ({
    id: 1,
    layer_id: "layer-1",
    updated_at: "2026-08-28T18:50:55Z",
    other_properties,
  }) as never;

describe("PropertiesPanel", () => {
  it("says a catalog layer came from the catalog", () => {
    render(<PropertiesPanel activeLayer={layer({ catalog_item: CATALOG_ITEM })} />);

    expect(screen.getByText("source")).toBeDefined();
    expect(screen.getByText("catalog")).toBeDefined();
  });

  it("does not link to the catalog entry", () => {
    // The mirror is rebuilt on every sync, so a promoted layer outlives the
    // entry it came from — a link back would eventually 404.
    render(<PropertiesPanel activeLayer={layer({ catalog_item: CATALOG_ITEM })} />);

    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says nothing about a source for an ordinary layer", () => {
    render(<PropertiesPanel activeLayer={layer({})} />);

    expect(screen.queryByText("source")).toBeNull();
  });

  it("marks a layer whose snapshot carries only the materialize state", () => {
    render(<PropertiesPanel activeLayer={layer({ catalog_materialize: { status: "ready" } })} />);

    expect(screen.getByText("source")).toBeDefined();
  });
});

describe("PropertiesPanel last updated", () => {
  it("shows the provider's date for a catalog layer, not when GOAT copied it", () => {
    render(<PropertiesPanel activeLayer={layer({ catalog_item: CATALOG_ITEM })} />);

    expect(screen.getByText("Aug 16, 2026")).toBeDefined();
    // A label short enough for the rows' label column.
    expect(screen.getByText("metadata.headings.updated")).toBeDefined();
  });

  it("omits the row when only the copy's timestamps are known", () => {
    render(<PropertiesPanel activeLayer={layer({ catalog_item: { id: "x" } })} />);

    expect(screen.queryByText("metadata.headings.updated")).toBeNull();
  });
});

/**
 * Real text from the catalog: the provider's record indents its second
 * paragraph with a tab, which CommonMark reads as an indented code block. The
 * whole description lands in a `<pre>`, and `<pre>` does not wrap: one
 * 170-character line pushed the metadata panel sideways.
 */
const INDENTED_DESCRIPTION =
  "Der Datensatz ist die Datengrundlage der INSPIRE-Dienste:\n\n" +
  "  \tGroßfeuerungsanlagen in Brandenburg - Interoperabler INSPIRE View-Service (WMS-PF-GFA) " +
  "Großfeuerungsanlagen in Brandenburg - Interoperabler INSPIRE Download-Service (WFS-PF-GFA)\n";

const described = (description: string, catalogItem: Record<string, unknown> = {}) =>
  ({ id: 1, layer_id: "layer-1", description, other_properties: { catalog_item: catalogItem } }) as never;

describe("PropertiesPanel layout", () => {
  it("lays the metadata out as the style panel does: sections with headings, the facts as label and value rows", () => {
    render(
      <PropertiesPanel
        activeLayer={described("A **forest** dataset.", {
          ...CATALOG_ITEM,
          "processing:lineage": "Reprojected.",
          license: "DL-DE-ZERO-2.0",
          language_code: "de",
        })}
      />
    );

    const description = screen
      .getByRole("heading", { name: "metadata.headings.description" })
      .closest("section");
    expect(within(description as HTMLElement).getByText("forest")).toBeDefined();
    expect(screen.getByRole("heading", { name: "metadata.headings.lineage" })).toBeDefined();
    const details = screen.getByRole("heading", { name: "details" }).closest("section") as HTMLElement;
    for (const [label, value] of [
      ["metadata.headings.publisher", "Landesamt für Umwelt (LfU)"],
      ["metadata.headings.license", "DL-DE-ZERO-2.0"],
      ["metadata.headings.language_code", "de"],
      ["source", "catalog"],
    ])
      expect(within(details).getByText(label).parentElement).toBe(
        within(details).getByText(value).parentElement?.parentElement
      );
    // No rule under every label: the sections carry the only dividers.
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
  });

  it("leaves out the sections it has nothing for, and says when there is no description", () => {
    render(<PropertiesPanel activeLayer={{ id: 1, layer_id: "layer-1", other_properties: {} } as never} />);

    // The description's section says there is none, so the tab is never blank.
    expect(screen.getByText("metadata.no_metadata_available.description")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "metadata.headings.lineage" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "details" })).toBeNull();
  });

  it("lets a provider's indented paragraph wrap instead of scrolling the panel", () => {
    const { container } = render(<PropertiesPanel activeLayer={described(INDENTED_DESCRIPTION)} />);

    const pre = container.querySelector("pre");
    expect(pre, "this description really does become a code block").not.toBeNull();
    expect(getComputedStyle(pre as Element).whiteSpace).toBe("pre-wrap");
  });

  it("breaks a long slash-joined value that has nowhere to wrap", () => {
    render(
      <PropertiesPanel
        activeLayer={described("", {
          publisher: "Regierung und Verwaltung/Bau- und Verkehrsdepartement/Tiefbauamt/Leitung",
        })}
      />
    );

    const value = screen.getByText(/Tiefbauamt\/Leitung/);
    expect(getComputedStyle(value).overflowWrap).toBe("anywhere");
  });
});

const QUERYABLES = {
  properties: {
    geom: { $ref: "https://geojson.org/schema/Geometry.json" },
    id: { name: "id", type: "integer" },
    layer_id: { name: "layer_id", type: "string" },
    h3_3: { name: "h3_3", type: "integer" },
    name: { name: "name", type: "string" },
    population: { name: "population", type: "integer", display_config: { label: "Population" } },
    opened: { name: "opened", type: "string", format: "date" },
    row_no: { name: "row_no", type: "integer", kind: "serial" },
  },
};

const featureLayer = (extra: Record<string, unknown> = {}) =>
  ({
    id: 1,
    layer_id: "layer-1",
    type: "feature",
    feature_layer_geometry_type: "polygon",
    size: 2_500_000,
    other_properties: {},
    ...extra,
  }) as never;

describe("PropertiesPanel dataset", () => {
  it("lists the dataset's size in the details, and neither geometry type nor feature count (the panel's header says both)", () => {
    render(<PropertiesPanel activeLayer={featureLayer()} />);

    const details = screen.getByRole("heading", { name: "details" }).closest("section") as HTMLElement;
    expect(within(details).getByText("size").parentElement).toBe(
      within(details).getByText(/^2\.5\sMB$/).parentElement?.parentElement
    );
    expect(screen.queryByText("metadata.headings.geometry_type")).toBeNull();
    expect(screen.queryByText("features")).toBeNull();
    // The same request the style and filter tabs make, so the fields come from the cache.
    expect(data.asked.queryables).toContain("layer-1");
  });

  it("lists every field with its type, leaving out the columns every layer carries", () => {
    data.queryables = QUERYABLES;
    render(<PropertiesPanel activeLayer={featureLayer()} />);

    const fields = screen.getByRole("heading", { name: "fields" }).closest("section") as HTMLElement;
    const rows = within(fields).getAllByRole("listitem");
    // Each row: the kind's glyph (a date's is an icon), the display name, the type.
    expect(rows.map((row) => row.textContent)).toEqual([
      "Aname" + "field_kind_string",
      "123Population" + "integer",
      "opened" + "field_kind_date",
      "#row_no" + "integer",
    ]);
  });

  it("shows the first 30 fields and the rest on demand", () => {
    data.queryables = {
      properties: Object.fromEntries(
        Array.from({ length: 45 }, (_, i) => [`f${i}`, { name: `f${i}`, type: "string" }])
      ),
    };
    render(<PropertiesPanel activeLayer={featureLayer()} />);

    const fields = screen.getByRole("heading", { name: "fields" }).closest("section") as HTMLElement;
    expect(within(fields).getAllByRole("listitem")).toHaveLength(30);
    fireEvent.click(within(fields).getByRole("button", { name: "metadata.show_all_fields" }));
    expect(within(fields).getAllByRole("listitem")).toHaveLength(45);
    expect(within(fields).queryByRole("button")).toBeNull();
  });

  it("lists a table's fields", () => {
    data.queryables = QUERYABLES;
    render(<PropertiesPanel activeLayer={featureLayer({ type: "table", feature_layer_geometry_type: undefined })} />);

    expect(screen.getByRole("heading", { name: "fields" })).toBeDefined();
  });

  it("says nothing of fields for a raster, and does not ask for them", () => {
    data.queryables = QUERYABLES;
    render(
      <PropertiesPanel
        activeLayer={featureLayer({ type: "raster", feature_layer_geometry_type: undefined, size: undefined })}
      />
    );

    expect(screen.queryByRole("heading", { name: "fields" })).toBeNull();
    expect(data.asked.queryables.every((id) => !id)).toBe(true);
  });

  it("without the fields (a public map) lists none and does not ask for them, the details staying", () => {
    data.queryables = QUERYABLES;
    render(<PropertiesPanel activeLayer={featureLayer()} showFields={false} />);

    expect(screen.queryByRole("heading", { name: "fields" })).toBeNull();
    expect(data.asked.queryables.every((id) => !id)).toBe(true);
    expect(screen.getByText("size")).toBeDefined();
  });

  it("never asks for a feature count", () => {
    render(<PropertiesPanel activeLayer={featureLayer()} />);

    expect(data.asked.count).toEqual([]);
  });
});

const remoteFile = (url: string, extra: Record<string, unknown> = {}) =>
  ({
    id: 1,
    layer_id: "layer-1",
    type: "raster",
    data_type: "cog",
    url,
    other_properties: {},
    ...extra,
  }) as never;

const SIGNED = "https://example.org/b.tif?sig=x";

describe("PropertiesPanel origin", () => {
  it("says a raster file added by its address is a remote file, and gives the address", () => {
    render(<PropertiesPanel activeLayer={remoteFile("https://example.org/b.tif", { size: 2_500_000 })} />);

    const details = screen.getByRole("heading", { name: "details" }).closest("section") as HTMLElement;
    expect(within(details).getByText("source").parentElement).toBe(
      within(details).getByText("metadata.source_remote_file:COG").parentElement?.parentElement
    );
    expect(within(details).getByRole("link").textContent).toBe("example.org/b.tif");
    // Where it comes from first, then its address, then the facts.
    expect(
      within(details)
        .getAllByText(/^(source|address|size)$/)
        .map((label) => label.textContent)
    ).toEqual(["source", "address", "size"]);
  });

  it("names a map service with its kind", () => {
    render(
      <PropertiesPanel
        activeLayer={remoteFile("https://example.org/wms?SERVICE=WMS&BBOX={bbox-epsg-3857}", {
          data_type: "wms",
        })}
      />
    );

    expect(screen.getByText("metadata.source_map_service:WMS")).toBeDefined();
    expect(screen.getByText("address")).toBeDefined();
  });

  it("says a WFS layer is a copy, and gives the service it was copied from", () => {
    render(
      <PropertiesPanel
        activeLayer={featureLayer({
          data_type: "wfs",
          other_properties: { url: "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis?SERVICE=WFS" },
        })}
      />
    );

    expect(screen.getByText("metadata.source_wfs_copy")).toBeDefined();
    expect(screen.getByText("address")).toBeDefined();
    expect(screen.getByText("www.wfs.nrw.de/…/wfs_nw_alkis")).toBeDefined();
  });

  it("gives no source and no address for an uploaded layer", () => {
    render(<PropertiesPanel activeLayer={featureLayer()} />);

    expect(screen.queryByText("source")).toBeNull();
    expect(screen.queryByText("address")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // The address row itself (link, tooltip, copy, shortening) is tested with LayerAddress; here only that the panel
  // hands it who may see the whole address.
  it("shows someone who may not edit the layer the address without its query string", () => {
    const { container } = render(<PropertiesPanel activeLayer={remoteFile(SIGNED)} />);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("example.org/b.tif");
    expect(link.getAttribute("href")).toBe("https://example.org/b.tif");
    expect(container.innerHTML).not.toContain("sig=x");
  });

  it("shows an editor the whole address", () => {
    render(<PropertiesPanel activeLayer={remoteFile(SIGNED)} canEdit />);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("example.org/b.tif?sig=x");
    expect(link.getAttribute("href")).toBe(SIGNED);
  });

  it("gives a catalog layer no address, whatever it carries", () => {
    render(
      <PropertiesPanel
        activeLayer={remoteFile("https://example.org/a.tif", {
          other_properties: { catalog_item: CATALOG_ITEM },
        })}
        canEdit
      />
    );

    expect(screen.getByText("catalog")).toBeDefined();
    expect(screen.queryByText("address")).toBeNull();
  });
});
