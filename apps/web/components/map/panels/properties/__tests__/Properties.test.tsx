import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PropertiesPanel from "@/components/map/panels/properties/Properties";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => false } }),
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));

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
