import { useTheme } from "@mui/material";

import { BASEMAPS } from "@/lib/constants/basemaps";

import type { BuiltInBasemap } from "@/types/map/common";

/** The built-in basemap the catalog's maps draw: Dark in the dark theme, else Light. */
export const useCatalogBasemap = (): BuiltInBasemap | undefined => {
  const theme = useTheme();
  const value = theme.palette.mode === "dark" ? "dark" : "light";
  return BASEMAPS.find((basemap) => basemap.value === value);
};

/** The basemap style matching the current theme. */
export const useCatalogBasemapStyle = (): string | undefined => useCatalogBasemap()?.url;
