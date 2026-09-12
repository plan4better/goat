import { Box, Tooltip, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FieldKind } from "@/lib/validations/layer";

/** Everything a field-type indicator can represent: the editable field kinds
 * plus the structural types that appear in field lists. */
export type FieldIndicatorKind = FieldKind | "object" | "geometry";

export const FIELD_KIND_ICONS: Record<FieldIndicatorKind, ICON_NAME> = {
  string: ICON_NAME.LETTER_T,
  number: ICON_NAME.HASHTAG,
  area: ICON_NAME.RULES_COMBINED,
  perimeter: ICON_NAME.RULER_HORIZONTAL,
  length: ICON_NAME.RULER_HORIZONTAL,
  datetime: ICON_NAME.CALENDAR,
  boolean: ICON_NAME.CHECK,
  formula: ICON_NAME.CODE,
  object: ICON_NAME.CODE,
  geometry: ICON_NAME.MAP,
};

const FIELD_KIND_LABEL_KEYS: Record<FieldIndicatorKind, string> = {
  string: "field_kind_text",
  number: "field_kind_number",
  area: "field_kind_area",
  perimeter: "field_kind_perimeter",
  length: "field_kind_length",
  datetime: "field_kind_date",
  boolean: "field_kind_boolean",
  formula: "field_kind_formula",
  object: "field_kind_object",
  geometry: "field_kind_geometry",
};

/** Kinds rendered as a text glyph (Atlas/Felt style) instead of an icon. */
const FIELD_KIND_GLYPHS: Partial<Record<FieldIndicatorKind, string>> = {
  string: "A",
  number: "123",
  object: "{}",
};

/** Resolve a field's indicator kind: the declared kind when known (formula
 * columns keep the formula indicator), otherwise inferred from the type —
 * which may be a JSON type ("number") or a raw DB type ("BIGINT"). */
export const fieldIndicatorKind = (field: { type?: string; kind?: string }): FieldIndicatorKind => {
  const kind = field.kind as FieldIndicatorKind | undefined;
  if (kind && kind in FIELD_KIND_ICONS) return kind;
  const type = (field.type ?? "").toLowerCase();
  if (type === "object" || type === "json") return "object";
  if (
    type.includes("geom") ||
    type.includes("geography") ||
    type.includes("point") ||
    type.includes("polygon") ||
    type.includes("linestring")
  ) {
    return "geometry";
  }
  if (type.includes("bool")) return "boolean";
  if (type.includes("date") || type.includes("time")) return "datetime";
  if (
    type === "number" ||
    type.includes("int") ||
    type.includes("double") ||
    type.includes("float") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("real")
  ) {
    return "number";
  }
  return "string";
};

interface FieldKindIconProps {
  kind: FieldIndicatorKind;
  /** Render in the theme's error color (e.g. invalid field rows). */
  error?: boolean;
}

/** Muted field-type chip, with the type name as tooltip. Text, number and
 * object render as "A" / "123" / "{}" glyphs; other kinds keep their icon.
 * The single source of truth for field-type indicators — use it wherever a
 * field's type is shown (tables, field lists, selectors). */
const FieldKindIcon = ({ kind, error = false }: FieldKindIconProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const glyph = FIELD_KIND_GLYPHS[kind];
  const color = error ? theme.palette.error.main : theme.palette.text.secondary;
  return (
    <Tooltip title={t(FIELD_KIND_LABEL_KEYS[kind] ?? FIELD_KIND_LABEL_KEYS.string)}>
      <Box
        component="span"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          height: 18,
          minWidth: 18,
          px: 0.5,
          borderRadius: "4px",
          // Chips placed inline with text must center on the line box, not
          // sit on the baseline (which makes them ride high next to labels)
          verticalAlign: "middle",
          // action.hover adapts to light/dark mode by design
          backgroundColor: theme.palette.action.hover,
          color,
          lineHeight: 1,
          userSelect: "none",
        }}>
        {glyph ? (
          <Box
            component="span"
            sx={{
              fontSize: glyph.length > 1 ? 9 : 11,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: glyph.length > 1 ? "-0.3px" : 0,
            }}>
            {glyph}
          </Box>
        ) : (
          <Icon
            iconName={FIELD_KIND_ICONS[kind] ?? FIELD_KIND_ICONS.string}
            // display:block strips the FontAwesome baseline offset
            // (vertical-align -0.125em) so the icon truly centers in the chip
            style={{ fontSize: 10, display: "block" }}
            htmlColor={color}
          />
        )}
      </Box>
    </Tooltip>
  );
};

export default FieldKindIcon;
