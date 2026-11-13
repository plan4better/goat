import { describe, expect, it } from "vitest";

import { MAX_EDITABLE_LAYER_SIZE } from "@/lib/constants";
import {
  canEditLayerFeatures,
  canEditLayerFields,
  canSetDefaultStyle,
} from "@/lib/utils/layerPermissions";

const USER = "user-1";
const PROJECT_OWNER = "project-owner-1";

describe("canEditLayerFeatures", () => {
  it("allows the layer owner to edit their own layer", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
      })
    ).toBe(true);
  });

  it("allows a project editor to edit a layer owned by the project owner", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: PROJECT_OWNER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
      })
    ).toBe(true);
  });

  it("denies a project viewer even on the project owner's layer", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: PROJECT_OWNER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: false,
      })
    ).toBe(false);
  });

  it("denies a project viewer even on their own layer", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: false,
      })
    ).toBe(false);
  });

  it("denies editing a layer owned by neither the user nor the project owner", () => {
    // The backend may still allow this (a third collaborator contributed the
    // layer); the client deliberately under-approximates rather than risk
    // showing an action that 403s.
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: "someone-else",
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
      })
    ).toBe(false);
  });

  it("denies editing when the layer exceeds the editable size limit", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
        layerSize: MAX_EDITABLE_LAYER_SIZE + 1,
      })
    ).toBe(false);
  });

  it("allows editing at exactly the editable size limit", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
        layerSize: MAX_EDITABLE_LAYER_SIZE,
      })
    ).toBe(true);
  });

  it("denies editing catalog layers", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
        inCatalog: true,
      })
    ).toBe(false);
  });

  it("denies editing a locked layer even on the user's own dataset", () => {
    // D7: a locked row's properties/query are already blanked by the
    // backend, so there is nothing here to edit and every write would 403.
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
        locked: true,
      })
    ).toBe(false);
  });

  it("denies editing when the current user is not resolved yet", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: undefined,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
      })
    ).toBe(false);
  });

  it("falls back to ownership when the project owner is unknown", () => {
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: undefined,
        isProjectEditor: true,
      })
    ).toBe(true);
    expect(
      canEditLayerFeatures({
        currentUserId: USER,
        layerOwnerId: "someone-else",
        projectOwnerId: undefined,
        isProjectEditor: true,
      })
    ).toBe(false);
  });
});

describe("canEditLayerFields", () => {
  it("allows the layer owner to change their own layer's fields", () => {
    expect(
      canEditLayerFields({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
      })
    ).toBe(true);
  });

  it("refuses a catalog layer", () => {
    // geoapi answers every /columns write with 403 "Catalog layers are
    // read-only", so offering Edit fields / Delete column on one can only
    // produce an error toast.
    expect(
      canEditLayerFields({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
        inCatalog: true,
      })
    ).toBe(false);
  });

  it("refuses an unowned layer, which is what a promoted catalog layer is", () => {
    // Catalog layers carry no owner at all (`layer.user_id IS NULL`), so this
    // holds even where the project layer carries no catalog marker.
    expect(
      canEditLayerFields({
        currentUserId: USER,
        layerOwnerId: null,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
      })
    ).toBe(false);
  });

  it("refuses a project viewer", () => {
    expect(
      canEditLayerFields({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: false,
      })
    ).toBe(false);
  });

  it("refuses a locked layer", () => {
    expect(
      canEditLayerFields({
        currentUserId: USER,
        layerOwnerId: USER,
        projectOwnerId: PROJECT_OWNER,
        isProjectEditor: true,
        locked: true,
      })
    ).toBe(false);
  });

  it("still allows fields on a layer too large to edit feature by feature", () => {
    // The size cap exists because feature editing loads the features; a
    // column operation runs in the database and the server applies no such
    // limit, so mirroring it here would hide an action the server allows.
    const args = {
      currentUserId: USER,
      layerOwnerId: USER,
      projectOwnerId: PROJECT_OWNER,
      isProjectEditor: true,
      layerSize: MAX_EDITABLE_LAYER_SIZE + 1,
    };

    expect(canEditLayerFields(args)).toBe(true);
    expect(canEditLayerFeatures(args)).toBe(false);
  });
});

describe("canSetDefaultStyle", () => {
  const catalogLayer = { other_properties: { catalog_item: { id: "x" } }, user_id: "me" } as never;
  const ownLayer = { other_properties: {}, user_id: "me" } as never;
  const othersLayer = { other_properties: {}, user_id: "someone" } as never;
  const editor = { currentUserId: "me", projectOwnerId: "owner", isProjectEditor: true };

  it("refuses a catalog layer, whoever asks", () => {
    // The dataset row of a catalog layer is read only: `check_layer` grants
    // only `layer-viewer` on it, and core refuses its default style.
    expect(canSetDefaultStyle(catalogLayer, editor)).toBe(false);
    expect(canSetDefaultStyle(catalogLayer, { ...editor, currentUserId: "owner" })).toBe(false);
  });

  it("refuses a layer still being materialized", () => {
    expect(
      canSetDefaultStyle(
        { other_properties: { catalog_materialize: { status: "pending" } }, user_id: "me" } as never,
        editor
      )
    ).toBe(false);
  });

  it("allows a project editor who may write the dataset: its owner, or a layer of the project's owner", () => {
    expect(canSetDefaultStyle(ownLayer, editor)).toBe(true);
    expect(canSetDefaultStyle({ other_properties: {}, user_id: "owner" } as never, editor)).toBe(true);
  });

  it("refuses a dataset the user may not write, and a project viewer", () => {
    expect(canSetDefaultStyle(othersLayer, editor)).toBe(false);
    expect(canSetDefaultStyle(ownLayer, { ...editor, isProjectEditor: false })).toBe(false);
    expect(canSetDefaultStyle({ other_properties: {}, user_id: "me", locked: true } as never, editor)).toBe(
      false
    );
  });

  it("refuses when there is no layer", () => {
    expect(canSetDefaultStyle(null, editor)).toBe(false);
    expect(canSetDefaultStyle(undefined, editor)).toBe(false);
  });
});
