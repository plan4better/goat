"use client";
import { Box, useTheme } from "@mui/material";
import { useMemo } from "react";
import useSWR from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { catalogCollectionId } from "@/lib/catalog/preview";
import { previewStyle } from "@/lib/catalog/style";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import { isDrawableStyle } from "@/lib/style/version";
import type { CatalogItem } from "@/lib/validations/catalog";

import BundleMapPreview from "@/components/dashboard/bundle/BundleMapPreview";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/** A box as WKT, the extent shape a map member carries. */
const extentOf = (bbox: number[] | undefined) => {
  if (!bbox || bbox.length < 4) return null;
  const [w, s, e, n] = bbox;
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
};

/**
 * A typed bundle (an XPlan plan) on one map: every layer with published tiles,
 * drawn by geoapi under `catalog:<item id>` in its published style, the way the
 * plan looks once added. The uploaded bundle's map (`BundleMapPreview`) does the
 * drawing; only the members and their styles come from the catalog.
 */
const CatalogPlanMap = ({ members }: { members: CatalogItem[] }) => {
  const theme = useTheme();
  const drawable = useMemo(
    () =>
      members.filter(
        (member) =>
          member.properties["goat:tiles"] === true &&
          !!member.properties["goat:geometryType"] &&
          !!member.assets?.style?.href
      ),
    [members]
  );
  const layers = useMemo(
    () =>
      drawable.map((member) => ({
        id: member.id,
        layer_id: catalogCollectionId(member.id),
        type: "feature" as const,
        feature_layer_geometry_type: member.properties["goat:geometryType"] as "point" | "line" | "polygon",
        extent: extentOf(member.bbox as number[] | undefined) ?? "",
      })),
    [drawable]
  );
  const { data: styles } = useSWR<Record<string, ViewLayer["style"]>>(
    drawable.length ? ["catalog-plan-styles", ...drawable.map((member) => member.id)] : null,
    async () => {
      const documents = await Promise.all(
        drawable.map((member) => fetcher(member.assets?.style?.href as string).catch(() => null))
      );
      return Object.fromEntries(
        drawable.map((member, i) => [
          member.id,
          isDrawableStyle(documents[i]) ? { document: previewStyle(documents[i]) } : null,
        ])
      );
    },
    { revalidateOnFocus: false }
  );

  if (!layers.length) return null;
  return (
    <Box
      sx={{
        position: "relative",
        height: { xs: 320, md: 460 },
        borderRadius: 2.5,
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
        boxShadow: surfaceShadows(theme).rest,
      }}>
      <BundleMapPreview layers={layers} styles={styles ?? {}} />
    </Box>
  );
};

export default CatalogPlanMap;
