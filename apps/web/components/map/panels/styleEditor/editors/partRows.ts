// The groups of the symbol section and the rows of each group's editor (prototype 2.5 and 4.1). A group edits one
// part of the symbol; its rows name the part's keys. Ranges come from SLIDERS, values from DEFAULTS.
import type { Geometry } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";
import { drawsAsImage, isPin } from "@/lib/style/markerShapes";

interface RowBase {
  key: string;
  /** The row's label key. */
  label: string;
  note?: string;
  /** The value shown while unset, when the reference default does not fit (label placement per geometry), or the
   * part's value decides it. */
  fallback?: unknown | ((part: JsonObject) => unknown);
  /** Only for these geometries. */
  only?: Geometry[];
  /** Shown only while the part's value passes. */
  when?: (part: JsonObject) => boolean;
}

export type PartRow =
  | (RowBase & {
      type: "color";
      /** A choice that takes the color from another part: writes `value` (undefined deletes the key). */
      sentinel?: { label: string; value: "fill" | undefined };
    })
  | (RowBase & { type: "number" })
  | (RowBase & { type: "switch" })
  /** An icon reference, picked in the icon picker. */
  | (RowBase & { type: "icon" })
  /** A fill pattern: in the Fill editor a row that opens the pattern editor; there, the patterns as tiles. */
  | (RowBase & { type: "pattern" | "pattern_tiles"; values: readonly string[] })
  | (RowBase & {
      type: "choice";
      values: readonly string[];
      /** Values with a one-line sub (`style_editor.value_<key>_<value>_sub`). */
      subs?: readonly string[];
    });

export interface PartGroup {
  /** The group's id: its label is `style_editor.part_<id>`, its name in sentences `style_editor.part_name_<id>`. */
  id: string;
  /** The symbol part its rows edit. */
  part: string;
  /** Has an on/off switch. */
  toggle: boolean;
  /** The part key the switch turns off (`false`) and on, instead of the whole part: the points' Fill switches
   * `marker.fill` (hollow markers), the marker itself stays. */
  switchKey?: "fill";
  /** The key the group row summarizes, and the color key its swatch shows. */
  summary: string;
  swatch?: string;
  rows: PartRow[];
  /** A group shown as this one row in the section instead of a row that opens an editor (point Size). */
  inline?: PartRow;
}

const DASHES = ["solid", "dashed", "dotted", "dash_dot"] as const;
const SAME_AS_FILL = "style_editor.same_as_fill";

const repeats = (part: JsonObject) => part.placement === undefined || part.placement === "repeat";
export const hasPattern = (part: JsonObject) => part.pattern !== undefined && part.pattern !== "none";
export const PATTERNS = [
  "none",
  "hatch_45",
  "hatch_135",
  "vertical",
  "horizontal",
  "cross",
  "grid",
  "dots",
] as const;

const FILL: PartGroup = {
  id: "fill",
  part: "fill",
  toggle: true,
  summary: "color",
  swatch: "color",
  rows: [
    { type: "color", key: "color", label: "style_editor.color" },
    { type: "number", key: "opacity", label: "style_editor.opacity" },
    { type: "pattern", key: "pattern", label: "style_editor.pattern", values: PATTERNS },
  ],
};

/** The pattern editor's rows (opened from the Fill editor's Pattern row): the patterns, then for a pattern its color,
 * spacing and thickness, worded for dots where the pattern is dots. */
export function patternRows(dots: boolean): PartRow[] {
  return [
    { type: "pattern_tiles", key: "pattern", label: "style_editor.pattern", values: PATTERNS },
    {
      type: "color",
      key: "pattern_color",
      label: dots ? "style_editor.pattern_dot_color" : "style_editor.pattern_color",
      note: "style_editor.note_pattern_color",
      sentinel: { label: SAME_AS_FILL, value: undefined },
      when: hasPattern,
    },
    { type: "number", key: "pattern_spacing", label: "style_editor.pattern_spacing", when: hasPattern },
    {
      type: "number",
      key: "pattern_width",
      label: dots ? "style_editor.pattern_dot_size" : "style_editor.pattern_width",
      when: hasPattern,
    },
  ];
}

const OUTLINE: PartGroup = {
  id: "outline",
  part: "outline",
  toggle: true,
  summary: "width",
  swatch: "color",
  rows: [
    {
      type: "color",
      key: "color",
      label: "style_editor.color",
      sentinel: { label: SAME_AS_FILL, value: "fill" },
    },
    { type: "number", key: "width", label: "style_editor.width" },
    { type: "number", key: "opacity", label: "style_editor.opacity" },
    { type: "choice", key: "dash", label: "style_editor.dash", values: DASHES, only: ["polygon"] },
  ],
};

const LINE: PartGroup = {
  id: "line",
  part: "line",
  toggle: false,
  summary: "width",
  swatch: "color",
  rows: [
    { type: "color", key: "color", label: "style_editor.color" },
    { type: "number", key: "width", label: "style_editor.width" },
    { type: "number", key: "opacity", label: "style_editor.opacity" },
    { type: "choice", key: "dash", label: "style_editor.dash", values: DASHES },
    {
      type: "choice",
      key: "cap",
      label: "style_editor.ends",
      values: ["butt", "round", "square"],
      subs: ["square"],
    },
    { type: "choice", key: "join", label: "style_editor.corners", values: ["miter", "round", "bevel"] },
    { type: "number", key: "offset", label: "style_editor.offset", note: "style_editor.note_line_offset" },
  ],
};

const CASING: PartGroup = {
  id: "casing",
  part: "casing",
  toggle: true,
  summary: "width",
  swatch: "color",
  rows: [
    { type: "color", key: "color", label: "style_editor.color" },
    { type: "number", key: "width", label: "style_editor.width", note: "style_editor.note_casing_width" },
    { type: "number", key: "opacity", label: "style_editor.opacity" },
  ],
};

const ARROWS: PartGroup = {
  id: "arrows",
  part: "arrows",
  toggle: true,
  summary: "placement",
  rows: [
    {
      type: "choice",
      key: "direction",
      label: "style_editor.direction",
      values: ["forward", "backward", "both"],
      subs: ["forward"],
    },
    { type: "number", key: "size", label: "style_editor.size" },
    {
      type: "color",
      key: "color",
      label: "style_editor.color",
      sentinel: { label: "style_editor.same_as_line", value: undefined },
    },
    {
      type: "choice",
      key: "placement",
      label: "style_editor.placement",
      values: ["repeat", "center", "start", "end", "both_ends"],
    },
    { type: "number", key: "spacing", label: "style_editor.spacing", when: repeats },
  ],
};

const LABEL: PartGroup = { id: "label", part: "label", toggle: true, summary: "text", rows: [] };

const hasIcon = (marker: JsonObject) => marker.icon !== undefined;

const SIZE: PartGroup = {
  id: "size",
  part: "marker",
  toggle: false,
  summary: "size",
  rows: [],
  inline: { type: "number", key: "size", label: "style_editor.size" },
};

const POINT_FILL: PartGroup = {
  id: "fill",
  part: "marker",
  toggle: true,
  switchKey: "fill",
  summary: "color",
  swatch: "color",
  rows: [
    { type: "color", key: "color", label: "style_editor.color" },
    { type: "number", key: "opacity", label: "style_editor.opacity" },
  ],
};

const alone = (marker: JsonObject) => marker.shape === "icon";
/** A marker drawn as an image: a shape (a circle only with an icon), a pin, or an icon alone. */
const asImage = (marker: JsonObject) => alone(marker) || drawsAsImage(marker.shape, hasIcon(marker));

const ICON: PartGroup = {
  id: "icon",
  part: "marker",
  toggle: false,
  summary: "icon",
  rows: [
    { type: "icon", key: "icon", label: "style_editor.icon" },
    { type: "color", key: "color", label: "style_editor.color", when: (m) => hasIcon(m) && alone(m) },
    {
      type: "color",
      key: "icon_color",
      label: "style_editor.icon_color",
      when: (m) => hasIcon(m) && !alone(m),
      // On a hollow marker the icon takes the marker color until it has its own (spec 3.3).
      fallback: (m: JsonObject) => (m.fill === false && typeof m.color === "string" ? m.color : undefined),
    },
    { type: "number", key: "rotation", label: "style_editor.rotation", when: asImage },
    {
      type: "choice",
      key: "anchor",
      label: "style_editor.anchor",
      values: ["center", "bottom"],
      subs: ["center", "bottom"],
      // A pin stands on its tip (the bottom) unless an anchor is set.
      when: (m) => (hasIcon(m) && alone(m)) || isPin(m.shape),
      fallback: (m: JsonObject) => (isPin(m.shape) ? "bottom" : "center"),
    },
    {
      type: "switch",
      key: "allow_overlap",
      label: "style_editor.overlap",
      note: "style_editor.note_marker_overlap",
      when: asImage,
      // Markers with a shape draw where they collide until overlap is turned off; icons alone do not.
      fallback: (m: JsonObject) => !alone(m),
    },
  ],
};

/** The groups of the symbol section per geometry, in display order. */
export const GROUPS: Readonly<Record<Geometry, PartGroup[]>> = {
  polygon: [FILL, OUTLINE, LABEL],
  line: [LINE, CASING, ARROWS, LABEL],
  point: [SIZE, POINT_FILL, OUTLINE, ICON, LABEL],
};

export const groupOf = (geometry: Geometry, id: string): PartGroup | undefined =>
  GROUPS[geometry].find((group) => group.id === id);

/** Choice keys whose rows live outside GROUPS (the label editor's). */
const OTHER_CHOICES: Record<string, readonly string[]> = { "label.font.weight": ["regular", "bold"] };

/** The values a choice property takes, from its row. */
export function choiceValues(key: string): readonly string[] | undefined {
  const [part, ...rest] = key.split(".");
  const sub = rest.join(".");
  for (const groups of Object.values(GROUPS))
    for (const group of groups)
      if (group.part === part)
        for (const row of group.rows)
          if ((row.type === "choice" || row.type === "pattern") && row.key === sub) return row.values;
  return OTHER_CHOICES[key];
}
