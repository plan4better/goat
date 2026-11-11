import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CatalogSpatialDialog from "@/components/dashboard/catalog/CatalogSpatialDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    // The point's centre is formatted in the reader's language.
    i18n: { language: "en" },
  }),
}));

vi.mock("react-map-gl/maplibre", () => ({
  Map: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
  Layer: () => null,
  Source: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/dashboard/common/DetailMapAttribution", () => ({
  default: () => <div data-testid="attribution" />,
}));
vi.mock("@/hooks/catalog/useCatalogBasemapStyle", () => ({
  useCatalogBasemapStyle: () => undefined,
}));
vi.mock("@/hooks/catalog/useCatalogNutsGeometries", () => ({
  useCatalogNutsGeometries: () => ({ geometries: {}, names: {} }),
}));
vi.mock("@/lib/api/catalog", () => ({
  useCatalogNutsRegions: (query?: string) => ({
    regions: query && query.length >= 2 ? [{ nuts_id: "DE2", nuts_name: "Bayern", level: 1 }] : [],
    isLoading: false,
  }),
}));

describe("CatalogSpatialDialog", () => {
  it("shows the title and keeps Apply disabled with no shape and no existing filter", () => {
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={vi.fn()} />);

    expect(screen.getByText("catalog_set_spatial_filter")).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Apply once a region is already in force, so the dialog can be used to clear it", () => {
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "region", nutsIds: ["DE1"], names: { DE1: "Baden-Württemberg" } }}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />
    );

    expect((screen.getByRole("button", { name: "apply" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("chooses the way of picking with the area selector the fetch dialog uses, not a segmented switch", () => {
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "fetch_features_area_by" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    // One group of fields under the dialog's title: no section heading of its own.
    expect(screen.queryByText("catalog_location")).toBeNull();
    // Clearing is done in place (chips, trash), so the footer holds Cancel and Apply only.
    expect(screen.queryByRole("button", { name: "clear_all" })).toBeNull();
  });

  it("applies null once the last region chip is removed from an existing filter", async () => {
    const onApply = vi.fn();
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "region", nutsIds: ["DE1"], names: { DE1: "Baden-Württemberg" } }}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );

    const chip = screen.getByRole("button", { name: "Baden-Württemberg" });
    await userEvent.click(within(chip).getByTestId("CancelIcon"));
    await userEvent.click(screen.getByRole("button", { name: "apply" }));

    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("switches to a point through the selector and asks for a click on the map", async () => {
    render(<CatalogSpatialDialog open initial={null} onClose={vi.fn()} onApply={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: "fetch_features_area_by" }));
    await userEvent.click(await screen.findByRole("option", { name: "fetch_features_area_mode_point" }));

    expect(screen.getByText("fetch_features_area_pick_on_map")).toBeInTheDocument();
    expect(screen.getByText("fetch_features_area_radius")).toBeInTheDocument();
  });

  it("shows a point filter's centre and clears it with the trash action beside it", async () => {
    const onApply = vi.fn();
    render(
      <CatalogSpatialDialog
        open
        initial={{ kind: "point", lng: 11.5, lat: 48.1, km: 3 }}
        onClose={vi.fn()}
        onApply={onApply}
      />
    );

    expect(screen.getByText(/48[.,]1000, 11[.,]5000/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "clear_all" }));
    expect(screen.getByText("fetch_features_area_pick_on_map")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "apply" }));

    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("applies a region picked from the search, and Cancel applies nothing", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<CatalogSpatialDialog open initial={null} onClose={onClose} onApply={onApply} />);

    await userEvent.type(screen.getByPlaceholderText("catalog_search_region"), "Bay");
    await userEvent.click(await screen.findByRole("option", { name: /Bayern/ }));
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    expect(onApply).toHaveBeenCalledWith({ kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } });
  });
});
