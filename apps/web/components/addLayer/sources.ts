import { ICON_NAME } from "@p4b/ui/components/Icon";

/**
 * The sources a layer can come from — one menu entry each, opening a dialog of its own.
 *
 * Labels are single words where a single word will do: the button is already called Add
 * Layer, so "Dataset Upload" and "Dataset Explorer" repeated its subject back at the reader.
 *
 * Every source has a flow of its own (a controller + a body). Hosts filter the list;
 * nothing else decides which entries exist.
 */

export type AddLayerSourceId = "upload" | "explorer" | "catalog" | "create" | "connect";

/**
 * The two things a source can be: data that does not exist in GOAT yet, or data that does.
 *
 * The menu groups by this rather than by how much work a source is, because it is the only
 * distinction someone has already made before opening the menu — they know whether what
 * they want is in GOAT or on their disk.
 */
export type AddLayerGroup = "new" | "existing";

export type AddLayerSource = {
  id: AddLayerSourceId;
  /** i18n key for the menu label. */
  labelKey: string;
  group: AddLayerGroup;
  icon: ICON_NAME;
  /** Adds to a project, so it is absent where there is none (the Content page). */
  needsProject?: boolean;
  /**
   * Browsing sources lay out their own edges, so their dialog does not pad them: a filter
   * rail has to reach the frame for its rules to read as rules.
   */
  wide?: boolean;
  /** How wide this source's dialog is. A form's 860 by default. */
  width?: number | string;
};

export const ADD_LAYER_SOURCES: AddLayerSource[] = [
  {
    id: "upload",
    labelKey: "upload_file",
    group: "new",
    icon: ICON_NAME.UPLOAD,
    // One view, one column: a drop zone or a single file row, so it needs a little more
    // than a form's 860 and nothing like a catalog's 1360. The file's own settings open in
    // a dialog on top rather than widening this one.
    width: "min(900px, 94vw)",
  },
  {
    id: "explorer",
    // "My datasets" rather than "Explore": it is the counterpart to Catalog,
    // and what distinguishes the two is whose datasets they are.
    labelKey: "my_datasets",
    group: "existing",
    icon: ICON_NAME.DATABASE,
    needsProject: true,
    wide: true,
    // A spaces rail beside a grid of cards: the catalog picker's width.
    width: "min(1360px, 94vw)",
  },
  {
    id: "catalog",
    labelKey: "catalog",
    group: "existing",
    icon: ICON_NAME.GLOBE,
    needsProject: true,
    wide: true,
    // A filter rail beside a grid of cards over thousands of collections: most of a desktop.
    width: "min(1360px, 94vw)",
  },
  {
    id: "create",
    labelKey: "create_layer",
    group: "new",
    icon: ICON_NAME.PLUS,
    // `createEmptyLayer` posts to a project; without one there is nothing to add
    // the new layer to, so the datasets page does not offer it.
    needsProject: true,
  },
  {
    id: "connect",
    labelKey: "connect_service",
    group: "new",
    icon: ICON_NAME.LINK,
    // A layer list beside a preview map, both reaching the frame's edges; a folder is all
    // it needs, so the Content page offers it too.
    wide: true,
    width: "min(1100px, 94vw)",
  },
];

/** The order the groups are shown in, with the i18n key for each heading. */
export const ADD_LAYER_GROUPS: { id: AddLayerGroup; labelKey: string }[] = [
  { id: "new", labelKey: "add_layer_group_new" },
  { id: "existing", labelKey: "add_layer_group_existing" },
];

export const sourcesFor = ({ hasProject }: { hasProject: boolean }): AddLayerSource[] =>
  ADD_LAYER_SOURCES.filter((source) => hasProject || !source.needsProject);
