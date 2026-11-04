/**
 * Formats that need an answer before they can be imported: which row is the header, and
 * which worksheet. Guessing produces a plausible, wrong layer, so these open the dialog.
 */
export const NEEDS_SETUP = ["csv", "xlsx", "xls"];

/** Formats that carry their own geometry and fields, so there is nothing to ask. */
export const IMPORTS_DIRECTLY = ["gpkg", "geojson", "kml", "zip", "parquet"];

/** Every format a drop takes, on the editor or on the assistant dock. */
export const DROP_FILE_EXTENSIONS = [...NEEDS_SETUP, ...IMPORTS_DIRECTLY];

export const extensionOf = (file: File): string => file.name.split(".").pop()?.toLowerCase() ?? "";

/**
 * Whether a drag carries files from outside the page, as opposed to an in-page drag such as
 * reordering layers. Takes React's synthetic events and native ones alike.
 */
export const carriesFiles = (event: { dataTransfer: Pick<DataTransfer, "types"> | null }): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");
