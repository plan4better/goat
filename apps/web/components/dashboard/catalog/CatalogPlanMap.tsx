"use client";

import { Box, Skeleton, useTheme } from "@mui/material";
import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { catalogCollectionId } from "@/lib/catalog/preview";
import { previewStyle } from "@/lib/catalog/style";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import { isDrawableStyle } from "@/lib/style/version";
import { type LngLatBounds, extentWkt } from "@/lib/utils/externalService";
import type { CatalogItem } from "@/lib/validations/catalog";

import BundleMapPreview from "@/components/dashboard/bundle/BundleMapPreview";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/**
 * An XPlan plan on one map, drawn by `BundleMapPreview` from geoapi's `catalog:<item id>`
 * tiles in each layer's published style.
 */
const CatalogPlanMap = ({ members }: { members: CatalogItem[] }) => {
  const theme = useTheme();
  const { cache, mutate } = useSWRConfig();
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
        extent: member.bbox?.length === 4 ? extentWkt(member.bbox as LngLatBounds) : "",
      })),
    [drawable]
  );
  const { data: styles } = useSWR<Record<string, ViewLayer["style"]>>(
    drawable.length ? ["catalog-plan-styles", ...drawable.map((member) => member.id)] : null,
    async () => {
      // `useCatalogStyle`'s cache entries (keyed by href), so each style is fetched once.
      const documents = await Promise.all(
        drawable.map((member) => {
          const href = member.assets?.style?.href as string;
          const cached = cache.get(href)?.data;
          return cached ?? mutate(href, fetcher(href), { revalidate: false }).catch(() => null);
        })
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
      {/* Drawn once the styles are in, never first without them. */}
      {styles ? (
        <BundleMapPreview layers={layers} styles={styles} />
      ) : (
        <Skeleton variant="rectangular" width="100%" height="100%" />
      )}
    </Box>
  );
};

export default CatalogPlanMap;
