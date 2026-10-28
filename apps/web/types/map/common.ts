import type { ReactNode } from "react";

import type { ICON_NAME } from "@p4b/ui/components/Icon";

import type { CustomBasemap } from "@/lib/validations/project";

export type BuiltInBasemap = {
  source: "builtin";
  type: "vector";
  value: string;
  url: string;
  title: string;
  subtitle: string;
  thumbnail: string;
};

export type Basemap = BuiltInBasemap | (CustomBasemap & { source: "custom"; value: string });

export interface IMarker {
  id: string;
  lat: number;
  long: number;
  iconName: string;
}

export enum MapSidebarItemID {
  LAYERS = "layers",
  LEGEND = "legend",
  CHARTS = "charts",
  HELP = "help",
  PROPERTIES = "properties",
  FILTER = "filter",
  STYLE = "style",
  TOOLBOX = "toolbox",
  FEATURE_EDITOR = "feature_editor",
}

export type SelectorItem = {
  value: string | number;
  label: string;
  icon?: ICON_NAME;
  /** Custom indicator (e.g. FieldKindIcon chip) — takes precedence over `icon`. */
  iconNode?: ReactNode;
  /** Shown but not choosable. */
  disabled?: boolean;
  /** A line under the label in the menu saying what the choice does. */
  sub?: string;
};
