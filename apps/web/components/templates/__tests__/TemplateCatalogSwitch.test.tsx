import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TemplateInput } from "@/lib/validations/template";

import TemplateCatalogSwitch from "@/components/templates/TemplateCatalogSwitch";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));

const shipped = (name: string, fromCatalog: boolean): TemplateInput => ({
  key: name,
  label: name,
  mode: "ship",
  layer_id: "00000000-0000-0000-0000-000000000001",
  layer_type: "feature",
  geometry_type: null,
  from_catalog: fromCatalog,
});

describe("TemplateCatalogSwitch", () => {
  it("says a published template is in the catalog and stays there on update", () => {
    render(
      <TemplateCatalogSwitch
        published
        publishedAt="2026-09-06T10:00:00Z"
        checked
        onChange={() => {}}
        blocked={[]}
        updating
      />
    );
    expect(screen.getByText(/published_in_catalog_since/)).toBeInTheDocument();
    expect(screen.getByText(/catalog_stays_published/)).toBeInTheDocument();
  });

  it("warns that switching a published template off unpublishes on save", () => {
    render(<TemplateCatalogSwitch published checked={false} onChange={() => {}} blocked={[]} />);
    expect(screen.getByText("unpublish_on_save")).toBeInTheDocument();
  });

  it("names the uploaded dataset that blocks a publish", () => {
    render(
      <TemplateCatalogSwitch published={false} checked onChange={() => {}} blocked={[shipped("GTFS stops", false)]} />
    );
    expect(screen.getByText('publish_blocked_uploaded:{"names":"GTFS stops"}')).toBeInTheDocument();
  });

  it("shows no status for an unpublished template with the switch off", () => {
    render(<TemplateCatalogSwitch published={false} checked={false} onChange={() => {}} blocked={[]} />);
    expect(screen.queryByText(/publish_blocked|unpublish_on_save|published_in_catalog/)).not.toBeInTheDocument();
  });

  it("reports the switch change", () => {
    const onChange = vi.fn();
    render(<TemplateCatalogSwitch published={false} checked={false} onChange={onChange} blocked={[]} />);
    screen.getByRole("checkbox", { name: "publish_to_goat_catalog" }).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
