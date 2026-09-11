import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Space } from "@/lib/validations/content";
import type { TemplateRead } from "@/lib/validations/template";

import TemplateSourceChoice from "@/components/templates/TemplateSourceChoice";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));

const space: Space = {
  id: "00000000-0000-0000-0000-00000000000a",
  kind: "organization",
  name: "Organization",
  default_role: "viewer",
  my_role: "owner",
  team_id: null,
  organization_id: "00000000-0000-0000-0000-00000000000b",
};

const tpl = (id: string, name: string, updated: string): TemplateRead =>
  ({
    id,
    name,
    description: null,
    categories: [],
    thumbnail_url: null,
    space_id: space.id,
    folder_id: "00000000-0000-0000-0000-00000000000f",
    created_by: null,
    payload_kind: "workflow",
    kinds: ["workflow"],
    inputs: [],
    ships_sample_data: false,
    catalog_status: "none",
    source_ref: {},
    my_role: "owner",
    created_at: updated,
    updated_at: updated,
    datasets_needing_share: [],
  }) as unknown as TemplateRead;

const candidates = [
  tpl("00000000-0000-0000-0000-000000000001", "ÖV-Güteklassenanalyse", "2026-09-09T10:00:00Z"),
  tpl("00000000-0000-0000-0000-000000000002", "ÖV – Berlin", "2026-08-20T10:00:00Z"),
];

const renderChoice = (over: Partial<React.ComponentProps<typeof TemplateSourceChoice>> = {}) =>
  render(
    <TemplateSourceChoice
      kindLabel="workflow"
      candidates={candidates}
      mode="update"
      onModeChange={() => {}}
      selectedId={candidates[0].id}
      onSelect={() => {}}
      spaces={[space]}
      {...over}
    />
  );

describe("TemplateSourceChoice", () => {
  it("renders nothing without candidates", () => {
    const { container } = renderChoice({ candidates: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the candidates and offers both modes", () => {
    renderChoice();
    expect(screen.getByText('templates_from_source:{"count":2,"kind":"workflow"}')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save_as_new" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "update_existing" })).toBeInTheDocument();
  });

  it("lists the candidates in update mode, marking the newest as latest", async () => {
    renderChoice();
    expect(screen.getByText("ÖV-Güteklassenanalyse")).toBeInTheDocument();
    expect(screen.getByText("latest")).toBeInTheDocument();
    await expect(screen.getByRole("radio", { name: /ÖV-Güteklassenanalyse/ })).toBeChecked();
  });

  it("hides the list in save-as-new mode", () => {
    renderChoice({ mode: "new" });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("reports a pick and a mode change", () => {
    const onSelect = vi.fn();
    const onModeChange = vi.fn();
    renderChoice({ onSelect, onModeChange });
    screen.getByRole("radio", { name: /ÖV – Berlin/ }).click();
    expect(onSelect).toHaveBeenCalledWith(candidates[1].id);
    screen.getByRole("button", { name: "save_as_new" }).click();
    expect(onModeChange).toHaveBeenCalledWith("new");
  });
});
