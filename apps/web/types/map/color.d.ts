import type { MouseEvent } from "react";

import type { RGBColor } from "@/lib/constants/color";
import type { ColorRange } from "@/lib/validations/layer";

export type SingleColorSelectorProps = {
  onSelectColor: (color: RGBColor | ColorRange, e?: MouseEvent) => void;
  selectedColor: string;
};

export type RGBColor = [number, number, number];
export type HexColor = string;

export type ColorItem = {
  id: string;
  color: string;
};
