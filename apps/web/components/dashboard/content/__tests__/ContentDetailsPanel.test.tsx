import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";

import ContentDetailsPanel from "@/components/dashboard/content/ContentDetailsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
  Trans: ({ i18nKey, values }: { i18nKey?: string; values?: Record<string, unknown> }) => (
    <span>{values ? `${i18nKey}:${JSON.stringify(values)}` : i18nKey}</span>
  ),
}));

vi.mock("@/lib/api/users", () => ({
  useUserProfile: () => ({
    userProfile: { id: "u-me", firstname: "Marco", lastname: "Albrecht", avatar: "" },
  }),
}));
vi.mock("@/components/dashboard/common/KindBadges", () => ({
  default: ({ kinds }: { kinds: string[] }) => <div data-testid="kind-badges">{JSON.stringify(kinds)}</div>,
}));

const teamSpace: Space = {
  id: "space-1",
  kind: "team",
  name: "Design Team",
  default_role: "viewer",
  my_role: "owner",
  team_id: "team-1",
  organization_id: null,
};

const ownerLayer: ContentItem = {
  type: "layer",
  id: "item-1",
  name: "Layer A",
  space_id: "space-1",
  folder_id: null,
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  created_by: { id: "u-lena", name: "Lena Schmidt", avatar: null },
  shared_with: {
    teams: [{ id: "team-2", role: "layer-viewer", name: "Marketing", avatar: null }],
    organizations: [],
    users: [],
  },
  thumbnail_url: null,
  layer_type: "feature",
  feature_layer_geometry_type: "point",
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
};

const secondItem: ContentItem = { ...ownerLayer, id: "item-2", name: "Layer B" };

const defaultLocation = { icon: ICON_NAME.FOLDER, name: "Design Team", rows: [] as [string, string][] };

const noop = () => {};

const renderPanel = (overrides: Partial<ComponentProps<typeof ContentDetailsPanel>> = {}) =>
  render(
    <ContentDetailsPanel
      selected={[ownerLayer]}
      spaces={[teamSpace]}
      folders={[]}
      location={defaultLocation}
      onClose={noop}
      onShare={noop}
      onMove={noop}
      onDelete={noop}
      {...overrides}
    />
  );

describe("ContentDetailsPanel", () => {
  it("shows the owning space, the team grant, and an enabled Share button for a single owned item", () => {
    renderPanel();

    expect(screen.getByText('owned_by:{"name":"Design Team"}')).toBeInTheDocument();
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    expect(screen.getByText("viewer")).toBeInTheDocument();
    const shareButton = screen.getByRole("button", { name: "share" }) as HTMLButtonElement;
    expect(shareButton.disabled).toBe(false);
  });

  it("hides Share and Move for a viewer", () => {
    renderPanel({ selected: [{ ...ownerLayer, my_role: "viewer" }] });

    expect(screen.queryByRole("button", { name: "share" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "move_to" })).not.toBeInTheDocument();
  });

  it("shows an n_selected heading for a multi-item selection", () => {
    renderPanel({ selected: [ownerLayer, secondItem] });

    expect(screen.getByText('n_selected:{"count":2}')).toBeInTheDocument();
  });

  it("hides Share and Move for a shortcut, whatever its target's role says", () => {
    // A shortcut row carries the target's id and role — acting on it would
    // act on the real item in the space it now lives in.
    renderPanel({ selected: [{ ...ownerLayer, is_shortcut: true }] });

    expect(screen.queryByRole("button", { name: "share" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "move_to" })).not.toBeInTheDocument();
  });

  it("offers the bulk Move for a selection that is all in one space", () => {
    renderPanel({ selected: [ownerLayer, secondItem] });

    expect(screen.getByRole("button", { name: "move_to" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "delete" })).toBeInTheDocument();
  });

  it("hides the bulk Move for a selection spanning two spaces, but keeps Delete", () => {
    // `MoveDialog` browses one space's folder tree and `moveContentItems`
    // walks the selection sequentially, so a cross-space Move would offer the
    // first item's folders to all of them and half-apply before the backend
    // refused the rest. Leaving a space is a transfer, not a move.
    renderPanel({ selected: [ownerLayer, { ...secondItem, space_id: "space-2" }] });

    expect(screen.queryByRole("button", { name: "move_to" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "delete" })).toBeInTheDocument();
  });

  it("hides the bulk Move/Delete when the selection contains a shortcut", () => {
    renderPanel({ selected: [ownerLayer, { ...secondItem, is_shortcut: true }] });

    expect(screen.queryByRole("button", { name: "move_to" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "delete" })).not.toBeInTheDocument();
  });

  it("says only_you for an item in a personal space", () => {
    const personalSpace: Space = {
      id: "space-p",
      kind: "personal",
      name: "My Content",
      default_role: "editor",
      my_role: "owner",
      team_id: null,
      organization_id: null,
    };
    renderPanel({
      selected: [{ ...ownerLayer, space_id: "space-p", shared_with: null }],
      spaces: [personalSpace],
    });

    expect(screen.getByText('owned_by:{"name":"only_you"}')).toBeInTheDocument();
  });

  it("shows the restricted note for an item that is itself restricted", () => {
    renderPanel({ selected: [{ ...ownerLayer, restricted: true }] });

    expect(screen.getByText("restricted_note")).toBeInTheDocument();
  });

  it("does not claim space members can see a restricted item", () => {
    renderPanel({ selected: [{ ...ownerLayer, restricted: true }] });

    expect(screen.getByText("restricted_note")).toBeInTheDocument();
    expect(screen.queryByText("space_members")).not.toBeInTheDocument();
    // the explicit grant is still listed — it is who *can* see it
    expect(screen.getByText("Marketing")).toBeInTheDocument();
  });

  it("does not claim space members can see an item restricted through its folder", () => {
    renderPanel({ selected: [{ ...ownerLayer, restricted: false, restricted_inherited: true }] });

    expect(screen.queryByText("space_members")).not.toBeInTheDocument();
  });

  it("still lists the space as an audience for an ordinary item", () => {
    renderPanel();

    expect(screen.getByText("space_members")).toBeInTheDocument();
  });

  it("shows the inherited note, naming the restricted ancestor, when only inherited", () => {
    const folders: Folder[] = [
      { id: "root", name: "Root", parent_id: null, depth: 0, is_owned: true, restricted: false },
      { id: "closed", name: "Closed Folder", parent_id: "root", depth: 1, is_owned: true, restricted: true },
    ];
    renderPanel({
      selected: [{ ...ownerLayer, restricted: false, restricted_inherited: true, folder_id: "closed" }],
      folders,
    });

    expect(
      screen.getByText('common:restricted_inherited_note:{"folder":"Closed Folder"}')
    ).toBeInTheDocument();
    expect(screen.queryByText("restricted_note")).not.toBeInTheDocument();
  });

  it("does not show either restricted note for an ordinary item", () => {
    renderPanel();

    expect(screen.queryByText("restricted_note")).not.toBeInTheDocument();
    expect(screen.queryByText(/restricted_inherited_note/)).not.toBeInTheDocument();
  });

  it("labels a template row with the template type, and renders its kind badges", () => {
    const template: ContentItem = {
      ...ownerLayer,
      type: "template",
      layer_type: null,
      feature_layer_geometry_type: null,
      template_kinds: ["workflow", "layout"],
      template_catalog_status: "none",
    };
    renderPanel({ selected: [template] });

    expect(screen.getByText("template")).toBeInTheDocument();
    expect(screen.getByTestId("kind-badges")).toHaveTextContent('["workflow","layout"]');
  });

  it("shows the GOAT catalog status line once a template is published", () => {
    const template: ContentItem = {
      ...ownerLayer,
      type: "template",
      layer_type: null,
      feature_layer_geometry_type: null,
      template_kinds: ["workflow"],
      template_catalog_status: "published",
    };
    renderPanel({ selected: [template] });

    expect(screen.getByText("goat_catalog")).toBeInTheDocument();
  });

  it("leaves out the GOAT catalog status line for an unpublished template", () => {
    const template: ContentItem = {
      ...ownerLayer,
      type: "template",
      layer_type: null,
      feature_layer_geometry_type: null,
      template_kinds: ["workflow"],
      template_catalog_status: "none",
    };
    renderPanel({ selected: [template] });

    expect(screen.queryByText("goat_catalog")).not.toBeInTheDocument();
  });

  it("names the creator in the metadata, as You when it is the caller", () => {
    renderPanel();
    expect(screen.getByText("creator")).toBeInTheDocument();
    expect(screen.getByText("Lena Schmidt")).toBeInTheDocument();

    cleanup();
    renderPanel({
      selected: [{ ...ownerLayer, created_by: { id: "u-me", name: "Marco Albrecht", avatar: null } }],
    });
    expect(screen.getByText("you")).toBeInTheDocument();
  });

  it("names the creator as owner when the item's space is not one of the caller's", () => {
    // A folder shared in from someone else's personal space lists items in
    // a space the caller cannot see — the panel still renders them.
    renderPanel({
      selected: [
        {
          ...ownerLayer,
          my_role: "viewer",
          space_id: "00000000-0000-0000-0000-0000000000ff",
          created_by: { id: "00000000-0000-0000-0000-0000000000aa", name: "Camila R." },
        },
      ],
    });

    expect(screen.getByText('owned_by:{"name":"Camila R."}')).toBeInTheDocument();
    expect(screen.queryByText("space_members")).not.toBeInTheDocument();
  });
});
