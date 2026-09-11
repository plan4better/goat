import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem, Space } from "@/lib/validations/content";

import { ContentActions } from "@/types/common";

import { canActOn, useContentActions } from "@/hooks/dashboard/content/useContentActions";

const { useUserProfileMock } = vi.hoisted(() => ({ useUserProfileMock: vi.fn() }));

// Identity for a bare key; a key called with interpolation vars gets them
// appended so the one test that cares about interpolation (the shortcut's
// "open in {{name}}" label) can assert the value was actually passed through.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));
vi.mock("@/lib/api/users", () => ({ useUserProfile: useUserProfileMock }));

const item = (overrides: Partial<ContentItem>): ContentItem => ({
  type: "layer",
  id: "item-1",
  name: "Item",
  space_id: "space-1",
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  shared_with: null,
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
  ...overrides,
});

const space = (overrides: Partial<Space> = {}): Space => ({
  id: "space-1",
  kind: "personal",
  name: "My Content",
  default_role: "viewer",
  ...overrides,
});

describe("useContentActions.getMenuItems", () => {
  const ids = (menu: ReturnType<ReturnType<typeof useContentActions>["getMenuItems"]>) =>
    menu.map((m) => m.id);

  beforeEach(() => {
    useUserProfileMock.mockReset().mockReturnValue({ userProfile: { id: "u-me", is_superuser: false } });
  });

  it("a viewer on a feature layer gets OPEN, DETAILS, DOWNLOAD", () => {
    const { result } = renderHook(() => useContentActions());
    const layer = item({ type: "layer", layer_type: "feature", my_role: "viewer" });

    expect(ids(result.current.getMenuItems(layer, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.DOWNLOAD,
    ]);
  });

  it("an owner on a project gets the full project action set", () => {
    const { result } = renderHook(() => useContentActions());
    const project = item({ type: "project", my_role: "owner" });

    expect(ids(result.current.getMenuItems(project, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.EDIT_METADATA,
      ContentActions.MOVE,
      ContentActions.SHARE,
      ContentActions.DUPLICATE,
      ContentActions.EXPORT,
      ContentActions.DELETE,
    ]);
  });

  it("an owner on a folder gets OPEN, DETAILS, RENAME, MOVE, SHARE, DELETE", () => {
    const { result } = renderHook(() => useContentActions());
    const folder = item({ type: "folder", my_role: "owner" });

    expect(ids(result.current.getMenuItems(folder, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.RENAME,
      ContentActions.MOVE,
      ContentActions.SHARE,
      ContentActions.DELETE,
    ]);
  });

  it("an editor on a bundle only gets OPEN, DETAILS — bundle actions are owner-only", () => {
    const { result } = renderHook(() => useContentActions());
    const bundle = item({ type: "bundle", my_role: "editor" });

    expect(ids(result.current.getMenuItems(bundle, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
    ]);
  });

  it("a shortcut gets OPEN only, whatever the role or target type", () => {
    const { result } = renderHook(() => useContentActions());
    const shortcut = item({ type: "project", my_role: "viewer", is_shortcut: true });

    expect(ids(result.current.getMenuItems(shortcut, undefined))).toEqual([ContentActions.OPEN]);
  });

  it("an owner on a bundle gets the full owner action set", () => {
    const { result } = renderHook(() => useContentActions());
    const bundle = item({ type: "bundle", my_role: "owner" });

    expect(ids(result.current.getMenuItems(bundle, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.MOVE,
      ContentActions.SHARE,
      ContentActions.DELETE,
    ]);
  });

  it("a viewer item in an owner space still only gets viewer actions — the space never raises item.my_role", () => {
    const { result } = renderHook(() => useContentActions());
    // The backend's `effective_role` already folds space membership into
    // `item.my_role`; an owner can deliberately narrow one item below the
    // space's own default (spec D8), so the space's role must never lift it
    // back up here.
    const layer = item({ type: "layer", layer_type: "table", my_role: "viewer" });
    const ownerSpace = space({ my_role: "owner" });

    expect(ids(result.current.getMenuItems(layer, ownerSpace))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.DOWNLOAD,
    ]);
  });

  it("an owner item in a viewer space still gets the full owner action set — the space never downgrades it either", () => {
    const { result } = renderHook(() => useContentActions());
    const layer = item({ type: "layer", layer_type: "feature", my_role: "owner" });
    const viewerSpace = space({ my_role: "viewer" });

    expect(ids(result.current.getMenuItems(layer, viewerSpace))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.EDIT_METADATA,
      ContentActions.MOVE,
      ContentActions.SHARE,
      ContentActions.DOWNLOAD,
      ContentActions.UPDATE,
      ContentActions.DELETE,
    ]);
  });

  it("labels the shortcut's OPEN action with the target space's name", () => {
    const { result } = renderHook(() => useContentActions());
    const shortcut = item({ type: "layer", is_shortcut: true });
    const target = space({ id: "space-2", kind: "team", name: "Mobility Team" });

    const menu = result.current.getMenuItems(shortcut, target);
    expect(menu[0].label).toBe('open_in:{"name":"Mobility Team"}');
  });

  it("an owner on a template gets the same move/share set as a project, plus Edit and Delete", () => {
    const { result } = renderHook(() => useContentActions());
    const template = item({ type: "template", my_role: "owner" });

    expect(ids(result.current.getMenuItems(template, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.USE_TEMPLATE,
      ContentActions.MOVE,
      ContentActions.SHARE,
      ContentActions.EDIT_TEMPLATE,
      ContentActions.DELETE,
    ]);
  });

  it("offers a template editor and viewer neither transfer nor move", () => {
    const { result } = renderHook(() => useContentActions());

    for (const role of ["editor", "viewer"] as const) {
      const menu = ids(result.current.getMenuItems(item({ type: "template", my_role: role }), undefined));
      expect(menu).not.toContain(ContentActions.TRANSFER);
      expect(menu).not.toContain(ContentActions.MOVE);
    }
  });

  it("an editor on a template gets OPEN, DETAILS, USE_TEMPLATE and Edit only", () => {
    const { result } = renderHook(() => useContentActions());
    const template = item({ type: "template", my_role: "editor" });

    expect(ids(result.current.getMenuItems(template, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.USE_TEMPLATE,
      ContentActions.EDIT_TEMPLATE,
    ]);
  });

  it("labels Edit with an ellipsis, since it opens a dialog", () => {
    const { result } = renderHook(() => useContentActions());
    const menu = result.current.getMenuItems(item({ type: "template", my_role: "owner" }), undefined);

    expect(menu.find((entry) => entry.id === ContentActions.EDIT_TEMPLATE)?.label).toBe("edit…");
  });

  it("a viewer on a template gets only OPEN, DETAILS and USE_TEMPLATE", () => {
    const { result } = renderHook(() => useContentActions());
    const template = item({ type: "template", my_role: "viewer" });

    expect(ids(result.current.getMenuItems(template, undefined))).toEqual([
      ContentActions.OPEN,
      ContentActions.DETAILS,
      ContentActions.USE_TEMPLATE,
    ]);
  });

  it("offers no Publish, Unpublish, Rename or thumbnail redraw in the menu — the edit dialog carries them", () => {
    for (const superuser of [true, false]) {
      useUserProfileMock.mockReturnValue({ userProfile: { id: "u-me", is_superuser: superuser } });
      const { result } = renderHook(() => useContentActions());
      for (const status of ["none", "published"] as const) {
        const menu = ids(
          result.current.getMenuItems(
            item({ type: "template", my_role: "owner", template_catalog_status: status }),
            undefined
          )
        );
        expect(menu).not.toContain(ContentActions.PUBLISH_TO_GOAT_CATALOG);
        expect(menu).not.toContain(ContentActions.UNPUBLISH_FROM_GOAT_CATALOG);
        expect(menu).not.toContain(ContentActions.RENAME);
        expect(menu).not.toContain(ContentActions.REGENERATE_THUMBNAIL);
        expect(menu).toContain(ContentActions.EDIT_TEMPLATE);
      }
    }
  });
});

describe("canActOn", () => {
  it("admits an item the caller owns", () => {
    expect(canActOn(item({ my_role: "owner" }))).toBe(true);
  });

  it("refuses an editor and a viewer", () => {
    expect(canActOn(item({ my_role: "editor" }))).toBe(false);
    expect(canActOn(item({ my_role: "viewer" }))).toBe(false);
  });

  it("refuses a shortcut even when its target's role is owner", () => {
    // A shortcut row carries the *target's* id and role, so Share/Move/
    // Delete on it would act on the target in whatever space it now lives
    // in — the kebab offers a shortcut nothing but OPEN, and every bulk
    // path has to agree.
    expect(canActOn(item({ my_role: "owner", is_shortcut: true }))).toBe(false);
  });

  it("disables the action bar for a selection that contains a shortcut", () => {
    // The gates the page computes: one owned row plus a shortcut.
    const selected = [
      item({ id: "a", my_role: "owner" }),
      item({ id: "b", my_role: "owner", is_shortcut: true }),
    ];
    const canShare = selected.length === 1 && canActOn(selected[0]);
    const canMove =
      selected.length > 0 && selected.every((i) => canActOn(i) && i.space_id === selected[0].space_id);
    const canDelete = selected.length > 0 && selected.every(canActOn);

    expect(canShare).toBe(false);
    expect(canMove).toBe(false);
    expect(canDelete).toBe(false);
  });
});
