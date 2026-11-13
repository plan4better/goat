import { MAX_EDITABLE_LAYER_SIZE } from "@/lib/constants";

import type { Layer } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";

import { isCatalogLayer } from "@/lib/utils/catalog-layer";

export type CanEditLayerFieldsArgs = {
  /** Id of the signed-in user. */
  currentUserId?: string | null;
  /** Owner of the underlying dataset (`projectLayer.user_id`). */
  layerOwnerId?: string | null;
  /** Owner of the project the layer is viewed in (`project.owned_by.id`). */
  projectOwnerId?: string | null;
  /** Whether the user holds project-owner/project-editor on this project. */
  isProjectEditor: boolean;
  /** Catalog datasets are read-only regardless of role. */
  inCatalog?: boolean | null;
  /** Bundle member layers are written through the bundle's batch endpoint
   *  only; geoapi 403s every per-feature/column write to them. Callers with
   *  their own bundle-aware path (the map editor) pass nothing here. */
  inBundle?: boolean | null;
  /** D7: the current user has no access of their own to this layer — the
   *  backend whitelists the row to a handful of fields and blanks its
   *  style/data, so there is nothing here to edit. */
  locked?: boolean | null;
};

export type CanEditLayerFeaturesArgs = CanEditLayerFieldsArgs & {
  /** Dataset size in bytes; layers above the limit are not editable. */
  layerSize?: number | null;
};

/**
 * Whether to offer changing a layer's fields — adding, renaming or deleting a
 * column, and editing field display config.
 *
 * Mirrors the server rule the `/collections/{id}/columns` endpoints apply
 * (geoapi `_get_authorized_metadata` + `LayerService.user_can_edit_layer`):
 * a catalog layer is a shared read-only snapshot and every write to one is
 * refused with 403 "Catalog layers are read-only", so offering the action can
 * only produce an error toast. The owner may always edit, and a project editor
 * may edit a layer whose owner also edits that project.
 *
 * The client cannot see whether a *third* collaborator holds an edit grant,
 * so it approximates "layer owner is also an editor here" as "layer owner is
 * the project owner". That under-approximates: a layer contributed by another
 * collaborator shows no edit action even though the server would allow it.
 * Erring this way hides an action rather than surfacing one that 403s.
 *
 * A `locked` layer (D7) refuses unconditionally: the row it renders from
 * carries no `properties`/`query`/owner the server didn't already blank, so
 * there is nothing to edit and every write would 403 anyway.
 *
 * A bundle member is *not* refused here, unlike its features: columns can be
 * added to one, and the ones the bundle brought are protected individually
 * (`is_protected` per field) rather than by withholding the whole action.
 */
export function canEditLayerFields({
  currentUserId,
  layerOwnerId,
  projectOwnerId,
  isProjectEditor,
  inCatalog,
  locked,
}: CanEditLayerFieldsArgs): boolean {
  if (!isProjectEditor || inCatalog || locked) return false;
  if (!currentUserId || !layerOwnerId) return false;

  if (layerOwnerId === currentUserId) return true;
  return !!projectOwnerId && layerOwnerId === projectOwnerId;
}

/**
 * Whether to offer feature editing for a layer in a project.
 *
 * Everything {@link canEditLayerFields} requires, plus two things that apply to
 * rows but not to columns.
 *
 * A bundle member's features are edited through the bundle, so that its derived
 * artifacts are rebuilt from what changed — the per-feature endpoints refuse a
 * member outright. Columns are different: adding one is additive, so
 * {@link canEditLayerFields} allows it and protects the bundle's own columns
 * individually.
 *
 * And a size cap: feature editing loads the features into the browser, so
 * beyond `MAX_EDITABLE_LAYER_SIZE` it is not offered. Column operations run in
 * the database and carry no such limit.
 */
export function canEditLayerFeatures({
  layerSize,
  ...fields
}: CanEditLayerFeaturesArgs): boolean {
  if (!canEditLayerFields(fields)) return false;
  if (fields.inBundle) return false;
  if (layerSize && layerSize > MAX_EDITABLE_LAYER_SIZE) return false;
  return true;
}

/**
 * Whether to offer "Set as default style".
 *
 * That action copies a named style over the DATASET's default style, where it
 * becomes the default for everyone who adds the dataset afterwards — so it
 * needs write access to the dataset, not only to the project (core's
 * `set-as-default` checks `layer` `write` on the dataset).
 *
 * A catalog layer never qualifies. It is a shared read-only snapshot with no
 * owner: core keeps its default style read only, and `check_layer` grants it
 * only `layer-viewer`. Offering it can only produce an error toast.
 *
 * Otherwise the dataset write is approximated as {@link canEditLayerFields}
 * does for columns: a project editor who owns the dataset, or a dataset of the
 * project's owner; a locked row never.
 */
export function canSetDefaultStyle(
  layer: Layer | ProjectLayer | null | undefined,
  access: Pick<CanEditLayerFieldsArgs, "currentUserId" | "projectOwnerId" | "isProjectEditor">
): boolean {
  if (!layer || isCatalogLayer(layer)) return false;
  return canEditLayerFields({
    ...access,
    layerOwnerId: layer.user_id,
    locked: "locked" in layer ? layer.locked : false,
  });
}
