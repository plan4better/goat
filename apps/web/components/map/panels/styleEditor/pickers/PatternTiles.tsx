"use client";

// The fill patterns as tiles (spec 3.1): each pattern's picture, the chosen one marked, its name in the row above.
import { Box, ButtonBase, Typography } from "@mui/material";
import { Fragment, useId } from "react";
import { useTranslation } from "react-i18next";

import { type PatternKind, patternTile } from "@/lib/style/compile/patternImage";
import { choiceLabel } from "@/lib/style/editor/summaries";

import { Row } from "@/components/map/panels/styleEditor/rows";

/** A pattern's picture in `size` px, its lines or dots in the text color; "none" an empty square. */
export function PatternPicture({ kind, size = 28 }: { kind: string; size?: number }) {
  const id = useId();
  const tile = kind === "none" ? null : patternTile(kind as PatternKind, size / 4, Math.max(1, size / 20));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      style={{ flex: "none" }}>
      {tile && (
        <defs>
          <pattern id={id} patternUnits="userSpaceOnUse" width={tile.size} height={tile.size}>
            <path
              d={tile.path}
              fill={tile.dots ? "currentColor" : "none"}
              stroke={tile.dots ? "none" : "currentColor"}
              strokeWidth={Math.max(1, size / 20)}
            />
          </pattern>
        </defs>
      )}
      <rect width={size} height={size} rx={size / 7} fill={tile ? `url(#${id})` : "none"} />
    </svg>
  );
}

export function PatternTiles({
  label,
  values,
  value,
  onChange,
  mode,
}: {
  label: string;
  values: readonly string[];
  value: string;
  onChange: (pattern: string) => void;
  mode?: React.ReactNode;
}) {
  const { t } = useTranslation("common");
  return (
    <>
      <Row label={label} actions={mode}>
        <Typography variant="body2" noWrap sx={{ color: "text.primary", fontWeight: 600 }}>
          {choiceLabel(t, "fill.pattern", value)}
        </Typography>
      </Row>
      <Box
        role="radiogroup"
        aria-label={label}
        sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 1.5, px: 3, pb: 2 }}>
        {values.map((kind) => {
          const on = kind === value;
          const name = choiceLabel(t, "fill.pattern", kind);
          return (
            <ButtonBase
              key={kind}
              role="radio"
              aria-checked={on}
              aria-label={name}
              title={name}
              onClick={() => onChange(kind)}
              sx={{
                height: 48,
                borderRadius: 2,
                border: 1,
                borderColor: on ? "primary.main" : "divider",
                color: on ? "primary.main" : "text.secondary",
                bgcolor: (theme) => (on ? `${theme.palette.primary.main}14` : "transparent"),
                "&:hover": {
                  borderColor: on ? "primary.main" : "text.disabled",
                  color: on ? undefined : "text.primary",
                },
              }}>
              {kind === "none" ? (
                <Typography variant="caption" sx={{ color: "inherit", fontWeight: 600 }}>
                  {name}
                </Typography>
              ) : (
                <PatternPicture kind={kind} />
              )}
            </ButtonBase>
          );
        })}
      </Box>
    </>
  );
}

/** The patterns of a value by zoom, in zoom order with arrows between; their names on hover and for screen readers. */
export function PatternStops({ value }: { value: unknown }) {
  const { t } = useTranslation("common");
  const stops =
    value && typeof value === "object" && "zoom" in value && Array.isArray(value.zoom) ? value.zoom : [];
  const kinds = stops.map((stop) => (Array.isArray(stop) && typeof stop[1] === "string" ? stop[1] : "none"));
  const names = kinds.map((kind) => choiceLabel(t, "fill.pattern", kind)).join(" → ");
  return (
    <Box
      component="span"
      role="img"
      aria-label={names}
      title={names}
      sx={{ display: "inline-flex", alignItems: "center", gap: 1, verticalAlign: "middle" }}>
      {kinds.map((kind, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <Box component="span" aria-hidden="true" sx={{ color: "text.secondary" }}>
              →
            </Box>
          )}
          {kind === "none" ? (
            <Box component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
              {choiceLabel(t, "fill.pattern", kind)}
            </Box>
          ) : (
            <PatternPicture kind={kind} size={16} />
          )}
        </Fragment>
      ))}
    </Box>
  );
}
