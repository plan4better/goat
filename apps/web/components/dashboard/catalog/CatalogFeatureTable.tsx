"use client";

import { useMemo } from "react";

import type { CatalogColumn } from "@/lib/validations/catalog";
import type { DatasetCollectionItems } from "@/lib/validations/layer";

import type { FeatureTableField } from "@/components/common/FeatureTable";
import FeatureTableFrame from "@/components/dashboard/common/FeatureTableFrame";

/** The dataset's actual rows — the preview sample, one line per feature. */

/** Columns that are the feature's shape rather than its attributes. */
const STRUCTURAL = new Set(["geometry", "geom", "bbox"]);

/** Rows this table puts in the DOM.
 *
 * The sample the map draws is far larger than the sample worth tabulating:
 * every row here becomes a `<TableRow>` of one cell per column, and the table
 * does not virtualise, so the whole preview would be tens of thousands of
 * cells laid out at once. Nobody scrolls a preview that far — the question a
 * data tab answers is "what does a record look like", which the first screenful
 * answers as well as the last. */
export const TABLE_ROWS = 100;

const CatalogFeatureTable = ({
  features,
  columns,
  rows = TABLE_ROWS,
  maxHeight,
}: {
  /** A geometry-less dataset's rows arrive as Features with a `null` geometry;
   * this table reads attributes either way. */
  features: GeoJSON.Feature<GeoJSON.Geometry | null>[];
  columns: CatalogColumn[];
  /** Rows to show: fewer where the table is a glance (the assistant's card preview). */
  rows?: number;
  /** Height the table scrolls within; the frame's own default when left out. */
  maxHeight?: number;
}) => {
  const shown = useMemo(() => features.slice(0, rows), [features, rows]);

  /** Declared columns first, then anything the data carries beyond them. */
  const fields = useMemo<FeatureTableField[]>(() => {
    const declared = columns.filter((column) => !!column.name && !STRUCTURAL.has(column.name));
    const seen = new Set(declared.map((column) => column.name));
    const extra: FeatureTableField[] = [];
    for (const feature of shown) {
      for (const key of Object.keys(feature.properties ?? {})) {
        if (!seen.has(key)) {
          seen.add(key);
          // A value nobody declared is still a value.
          extra.push({ name: key, type: "string" });
        }
      }
    }
    return [...declared.map((column) => ({ name: column.name, type: column.type ?? "string" })), ...extra];
  }, [columns, shown]);

  /** The sample as the table's own page shape. */
  const data = useMemo<DatasetCollectionItems>(
    () => ({
      type: "FeatureCollection",
      title: "",
      links: [],
      numberMatched: shown.length,
      numberReturned: shown.length,
      features: shown.map((feature, index) => ({
        type: "Feature",
        // Positional: preview features carry no id, and the table only needs a
        // stable key per row.
        id: index,
        properties: (feature.properties ?? {}) as Record<string, unknown>,
      })),
    }),
    [shown]
  );

  if (!fields.length || !shown.length) return null;

  return (
    /* How much of the dataset this is stands in the card's heading, where the
       dataset's own size already is — the reader compares the two numbers in
       one place rather than finding one above the table and one below it. */
    <FeatureTableFrame fields={fields} data={data} maxHeight={maxHeight} />
  );
};

export default CatalogFeatureTable;
