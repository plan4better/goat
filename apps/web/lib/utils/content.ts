import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { CatalogKind, ContentTone, MarkKind } from "@/lib/catalog/kind";
import { markFor, toneFor } from "@/lib/catalog/kind";
import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";
import type { Layer } from "@/lib/validations/layer";

export type { ContentTone } from "@/lib/catalog/kind";

/** Which of the feed's five sections an item belongs in. A shortcut always
 * shows in "shortcuts", whatever type of content it points at. */
export const sectionOf = (
  item: ContentItem
): "folders" | "shortcuts" | "projects" | "templates" | "datasets" => {
  if (item.type === "folder") return "folders";
  if (item.is_shortcut) return "shortcuts";
  if (item.type === "project") return "projects";
  if (item.type === "template") return "templates";
  return "datasets";
};

/** The i18n key for a layer's type label, keyed on the layer type
 * (feature/raster/table). */
export const layerTypeLabelKey = (type: Layer["type"] | null | undefined): string => {
  if (type === "raster") return "raster_layer";
  if (type === "table") return "table_layer";
  return "feature_layer";
};

/** The i18n key for an item's type chip. Layers key off `layer_type`
 * (feature/raster/table) rather than off the generic "layer" content type,
 * reusing the same keys today's dataset cards render (`feature_layer`,
 * `raster_layer`, `table_layer`). */
export const typeLabelKey = (item: ContentItem): string => {
  if (item.type === "folder") return "folder_label";
  if (item.type === "project") return "project";
  if (item.type === "bundle") return "bundle";
  if (item.type === "template") return "template";
  // `layer_type` is stored as a free string; the only values written are the
  // three layer types.
  return layerTypeLabelKey(item.layer_type as Layer["type"] | null | undefined);
};

/** The icon for a bare content type, with no layer-type/geometry detail —
 * used wherever only `type` is known, such as a trash row (`TrashItem`
 * carries no `layer_type`). `iconFor` layers layer-specific detail on top
 * of this for the feed's full items. */
export const iconForType = (type: ContentItem["type"]): ICON_NAME =>
  markFor({
    kind:
      type === "folder"
        ? "folder"
        : type === "project"
          ? "project"
          : type === "template"
            ? "template"
            : "unknown",
  });

/** The icon for an item's row/card, from the shared `markFor` mapping. */
export const iconFor = (item: ContentItem): ICON_NAME =>
  markFor({ kind: markKindOf(item), geometryType: item.feature_layer_geometry_type });

/** The tone an item's type carries wherever its icon or placeholder
 * thumbnail is tinted, from the shared `toneFor` mapping. Read the colour
 * with `toneColorOf(theme, tone)`. */
export const typeToneFor = (item: ContentItem): ContentTone => toneFor(markKindOf(item));

/** The catalog kind a dataset-shaped item maps to, so a layer or bundle in
 * Content gets the very same picture `ContentThumbnail` draws for it in the
 * catalog. `undefined` for a project or folder: neither is a catalog thing,
 * and both keep the Content-specific tinted block instead. */
export const catalogKindOf = (item: ContentItem): CatalogKind | undefined => {
  if (item.type === "bundle") return "bundle";
  if (item.type !== "layer") return undefined;
  if (item.layer_type === "raster") return "raster";
  if (item.layer_type === "table") return "table";
  if (item.layer_type === "feature" || item.feature_layer_geometry_type) return "vector";
  return "unknown";
};

/** The kind an item is marked and tinted as: its catalog kind where it has
 * one, and `project`/`folder`/`template` for the things the catalog does not
 * carry. Everything that draws an item's glyph or tint goes through this, so
 * the catalog and the Content feed cannot drift apart. */
export const markKindOf = (item: ContentItem): MarkKind => {
  if (item.type === "folder") return "folder";
  if (item.type === "project") return "project";
  if (item.type === "template") return "template";
  return catalogKindOf(item) ?? "unknown";
};

/** A space's display name — the personal space always reads as "My Content"
 * (never the space's own literal `name`), the way the breadcrumb, rows/
 * cards, and a shortcut's "in {space}" caption all need it to. */
export const spaceDisplayName = (space: Space | undefined, t: (key: string) => string): string => {
  if (!space) return "";
  return space.kind === "personal" ? t("my_content") : space.name;
};

/** The icon for a space, by kind — the breadcrumb's "you are here" trail
 * and the details panel's owner/access rows both need the same marker next
 * to a space's name. */
export const spaceIconFor = (space: Space | undefined): ICON_NAME => {
  if (!space) return ICON_NAME.FOLDER;
  if (space.kind === "personal") return ICON_NAME.USER;
  if (space.kind === "team") return ICON_NAME.USERS;
  return ICON_NAME.ORGANIZATION;
};

/** The i18n key for a stored share role's rank, stripped of its
 * "<kind>-" prefix ("layer-viewer" -> "viewer", "folder-editor" ->
 * "editor") — the same `viewer`/`editor` keys every role chip in Content
 * already renders through. */
export const lastRoleSegment = (role: string): string => role.split("-").pop() ?? role;

/** A folder's parent, `null` at the space root. The folder list endpoint
 * leaves `parent_id` out entirely for a root folder, and `useFolders` hands
 * SWR's raw JSON straight on rather than parsing it through the schema that
 * would default it — so a folder in hand can carry `undefined` where its
 * type promises `null`. Every "is this at the root?" test goes through here
 * so neither shape can slip past it. */
export const parentIdOf = (folder: Folder): string | null => folder.parent_id ?? null;

/** The space's root folder — the backend folds its children into the space
 * root, so this is what a null `folderId` actually resolves to (for
 * fetching documents, and for hiding it from the breadcrumb). */
export const homeFolderOf = (folders: Folder[], spaceId: string): Folder | undefined =>
  folders.find((f) => f.name === "home" && parentIdOf(f) === null && f.space_id === spaceId);

/** Where an item lives, as the folder names from the space root down,
 * `"Field surveys › Round 2 QA"`; `undefined` for an item at the root. The
 * space's own `home` folder is the root and never appears. */
export const folderLocationLabel = (
  folders: Folder[],
  folderId: string | null | undefined
): string | undefined => {
  const names = folderPath(folders, folderId)
    .filter((folder) => folder.name !== "home")
    .map((folder) => folder.name);
  return names.length ? names.join(" › ") : undefined;
};

/** A folder's ancestors, root first, ending with the folder itself. Stops
 * instead of throwing if a `parent_id` points at a folder that isn't in
 * `folders` (a folder outside the caller's visibility, or stale data). */
export const folderPath = (folders: Folder[], folderId: string | null | undefined): Folder[] => {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  let current = byId.get(folderId);
  while (current) {
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
};

/** The name to show in an inherited-restriction note: walking from
 * `folderId` up to the space root, the nearest folder (closest to the item
 * first, `folderId` itself included) that is `restricted`, or — if none of
 * the loaded folders carry that flag — `folderId`'s own folder, so the note
 * still names *something* rather than rendering blank. */
export const restrictedAncestorName = (
  folders: Folder[],
  folderId: string | null | undefined
): string | undefined => {
  const path = folderPath(folders, folderId);
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].restricted) return path[i].name;
  }
  return path[path.length - 1]?.name;
};

export type Audience = {
  kind: "public" | "restricted" | "org" | "shared" | "private" | "space";
  labelKey: string;
  icon: ICON_NAME;
  /** Who the item is shared with, by name, for a "shared" or "org"
   * audience — the chip says only "Shared" and names them on hover. */
  sharedWithNames?: string[];
};

/** The grantees of an item by display name — organizations first, then
 * teams, then people — for the hover on the "Shared" chip. */
export const sharedWithNames = (item: ContentItem): string[] => {
  const sw = item.shared_with;
  if (!sw) return [];
  return [...(sw.organizations ?? []), ...(sw.teams ?? []), ...(sw.users ?? [])]
    .map((entry) => entry.name)
    .filter((name): name is string => !!name);
};

/** Who else can see an item, for the audience badge on a card or row. A
 * published public snapshot (`item.is_public`) always wins — it is a stronger
 * claim than any grant, and the only state that leaves the organisation.
 * Restricted comes next (the item or an ancestor folder narrows who in
 * the space can see it, overriding any grant below). Otherwise: an
 * organization grant beats a team/user grant, and with no grant at all the
 * space itself decides — a personal space with no grant is private, any
 * other space's items are visible to the whole space. */
export const audienceOf = (item: ContentItem, space: Space | undefined): Audience => {
  if (item.is_public) return { kind: "public", labelKey: "public", icon: ICON_NAME.GLOBE };
  if (item.restricted || item.restricted_inherited) {
    return { kind: "restricted", labelKey: "restricted", icon: ICON_NAME.LOCK };
  }

  const sharedWith = item.shared_with;
  if (sharedWith?.organizations?.length) {
    return {
      kind: "org",
      labelKey: "shared",
      icon: ICON_NAME.ORGANIZATION,
      sharedWithNames: sharedWithNames(item),
    };
  }
  if (sharedWith?.teams?.length || sharedWith?.users?.length) {
    return { kind: "shared", labelKey: "shared", icon: ICON_NAME.SHARE, sharedWithNames: sharedWithNames(item) };
  }
  if (space?.kind === "personal") {
    return { kind: "private", labelKey: "private_content", icon: ICON_NAME.LOCK };
  }
  return { kind: "space", labelKey: "in_space", icon: ICON_NAME.USERS };
};
