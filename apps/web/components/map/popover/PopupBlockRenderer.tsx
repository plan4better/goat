import { Box, Button, Divider, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useMemo, useState } from "react";

// Same soft separator used in MapFeaturePopover for the header→body line.
// ~8% of text.primary reads as a very light hairline in both themes.
const ROW_DIVIDER_SX = (theme: import("@mui/material").Theme) =>
  alpha(theme.palette.text.primary, 0.08);

import { formatFieldValue } from "@/lib/utils/formatFieldValue";
import { formatNumber } from "@/lib/utils/format-number";
import type {
  Attribute,
  PopupBlock,
  PopupFieldListBlock,
} from "@/lib/validations/layer";

import type { LayerField } from "./formatFeatureProperties";
import { sanitizePopupHtml } from "./sanitize";
import { substituteTokens } from "./tokens";

export interface PopupBlockRendererProps {
  block: PopupBlock;
  valuesByColumn: Record<string, string>;
  /**
   * Raw feature properties — needed by FieldList blocks that override
   * per-attribute number formatting (format_config). Other blocks only
   * read from `valuesByColumn`.
   */
  rawValues?: Record<string, unknown>;
  layerFields?: LayerField[];
  /** Locale for number formatting (passed through to formatNumber). */
  lang?: string;
}

export function PopupBlockRenderer({
  block,
  valuesByColumn,
  rawValues,
  layerFields,
  lang,
}: PopupBlockRendererProps) {
  switch (block.type) {
    case "text": {
      const html = sanitizePopupHtml(substituteTokens(block.html, valuesByColumn));
      return (
        <Box
          sx={{ "& p": { m: 0 }, "& > *:not(:last-child)": { mb: 1 } }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }

    case "divider":
      return (
        <Divider
          sx={{
            my: 1,
            borderBottomWidth: block.thickness,
            ...(block.color ? { borderColor: block.color } : null),
          }}
        />
      );

    case "fieldList":
      return (
        <FieldListBlock
          block={block}
          valuesByColumn={valuesByColumn}
          rawValues={rawValues}
          layerFields={layerFields}
          lang={lang}
        />
      );

    case "image": {
      const src =
        block.source === "static" ? block.url : valuesByColumn[block.field ?? ""];
      if (!src) return null;
      const style: React.CSSProperties = {
        width: "100%",
        borderRadius: 4,
        display: "block",
        objectFit: "cover",
      };
      if (block.sizing === "fit") {
        style.height = "auto";
      } else if (block.sizing === "aspect") {
        style.aspectRatio = block.aspect.replace("/", " / ");
      } else {
        style.height = block.height;
      }
      return <img src={src} alt="" style={style} />;
    }

    case "button": {
      const href = substituteTokens(block.url_template, valuesByColumn);
      const color = block.color || undefined; // fall back to MUI primary via sx
      const sxByStyle = {
        link: {
          color: color ?? "primary.main",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: 12,
        },
        outlined: {
          border: 1,
          borderColor: color ?? "primary.main",
          color: color ?? "primary.main",
          px: 1.5,
          py: 0.75,
          borderRadius: 1,
          display: "inline-block",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: 12,
        },
        filled: {
          bgcolor: color ?? "primary.main",
          color: "#fff",
          px: 1.5,
          py: 0.75,
          borderRadius: 1,
          display: "inline-block",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: 12,
        },
      } as const;
      return (
        <Box
          component="a"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          sx={sxByStyle[block.style]}>
          {block.label}
          {block.style === "link" ? " →" : ""}
        </Box>
      );
    }

    case "badge": {
      const val = valuesByColumn[block.field] ?? "";
      // Single-color mode: one color for every value. Per-value mode:
      // look up the value in the palette (fallback gray for unmapped
      // values so the badge still renders).
      const color =
        block.mode === "single"
          ? block.color || "#8A8D93"
          : block.palette[val] || "#8A8D93";
      const label = block.labels?.[val] || val;
      if (!label) return null;
      return (
        <Box
          component="span"
          sx={{
            display: "inline-block",
            // Parent body is a flex column with default `alignItems:
            // stretch`, which would otherwise force the chip to span the
            // popup width. alignSelf controls that: flex-start → chip is
            // content-width; stretch → chip fills the row.
            alignSelf: block.full_width ? "stretch" : "flex-start",
            textAlign: block.full_width ? "center" : "left",
            px: 1,
            py: 0.25,
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            color: "#fff",
            bgcolor: color,
            letterSpacing: 0.3,
          }}>
          {label}
        </Box>
      );
    }

    default:
      return null;
  }
}

const EMPTY_VALUE_PLACEHOLDER = "—";

/** A small square of a value's color before it: a raster cell's color as the map draws it. */
function ValueSwatch({ color }: { color: string }) {
  return (
    <Box
      component="span"
      data-testid="popup-swatch"
      aria-hidden
      style={{ backgroundColor: color }}
      sx={{
        display: "inline-block",
        width: 10,
        height: 10,
        mr: 0.75,
        borderRadius: 0.5,
        verticalAlign: "-1px",
        border: 1,
        borderColor: ROW_DIVIDER_SX,
      }}
    />
  );
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

function FieldListBlock({
  block,
  valuesByColumn,
  rawValues,
  layerFields,
  lang,
}: {
  block: PopupFieldListBlock;
  valuesByColumn: Record<string, string>;
  rawValues?: Record<string, unknown>;
  layerFields?: LayerField[];
  lang?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fieldByName = useMemo(
    () => new Map((layerFields ?? []).map((f) => [f.name, f])),
    [layerFields],
  );
  // Empty `attributes` is the "show every column" default — used by the
  // auto-seeded popup config for layers the user hasn't touched yet, so
  // newly-added layers display their fields without any configuration.
  // Synthesize an attribute entry for each layer field so the rest of
  // this function can iterate uniformly.
  const effectiveAttributes = useMemo<Attribute[]>(() => {
    if (block.attributes.length > 0) return block.attributes;
    return (layerFields ?? []).map((f) => ({
      name: f.name,
      type:
        f.type === "number" || f.type === "boolean"
          ? (f.type as "number" | "boolean")
          : ("string" as const),
    }));
  }, [block.attributes, layerFields]);
  const rows = effectiveAttributes.map((attr) => {
    // A row of several fields' values in one (an image's bands): those there, joined.
    const joined = attr.join
      ?.map((f) => rawValues?.[f] ?? valuesByColumn[f])
      .filter((v) => !isEmpty(v))
      .join(", ");
    // Source of truth for "is this empty" is the raw value, since the
    // pre-formatted byColumn string can be "0" / "false" / etc., which
    // shouldn't count as empty.
    const raw = attr.join ? joined : rawValues?.[attr.name];
    const empty = attr.join ? !joined : isEmpty(raw) && isEmpty(valuesByColumn[attr.name]);
    let value: string;
    if (empty) {
      value = EMPTY_VALUE_PLACEHOLDER;
    } else {
      const field = fieldByName.get(attr.name);
      const isNumber = attr.type === "number" || field?.type === "number";
      const hasFormatConfig = !!attr.format_config && Object.keys(attr.format_config).length > 0;
      if (joined !== undefined) {
        value = joined;
      } else if (isNumber && hasFormatConfig && raw != null && raw !== "" && !Number.isNaN(Number(raw))) {
        // Composable number config takes precedence over the legacy enum.
        value = formatFieldValue(Number(raw), "number", attr.format_config!, lang);
      } else if (isNumber && attr.format && raw != null && raw !== "" && !Number.isNaN(Number(raw))) {
        value = formatNumber(Number(raw), attr.format, lang ?? "en");
      } else {
        value = valuesByColumn[attr.name] ?? (raw == null ? "" : String(raw));
      }
      if (attr.prefix || attr.suffix) {
        value = `${attr.prefix ?? ""}${value}${attr.suffix ?? ""}`;
      }
    }
    return {
      label: attr.label || attr.name,
      value,
      empty,
      swatch: empty ? undefined : attr.swatch,
    };
  });
  const visible =
    block.collapse_after && !expanded ? rows.slice(0, block.collapse_after) : rows;
  const hidden = rows.length - visible.length;
  const isTable = block.layout === "table";

  return (
    <Stack spacing={isTable ? 0 : 1.5} sx={{ width: "100%" }}>
      {isTable ? (
        <Box
          component="table"
          sx={{
            width: "100%",
            borderCollapse: "collapse",
            // Fixed layout + explicit first-row column widths means
            // long values can't expand the column past its share — they
            // wrap inside instead. Without this, a single very long
            // value pushes the table past the popup width.
            tableLayout: "fixed",
          }}>
          <tbody>
            {visible.map((r, i) => {
              const isLast = i === visible.length - 1;
              const isFirst = i === 0;
              const cellSx = {
                py: "7px",
                fontSize: 12,
                borderBottom: isLast ? 0 : 1,
                borderColor: ROW_DIVIDER_SX,
                verticalAlign: "top",
                // Break long unknown content (URLs, comma-joined enums,
                // free-text strings) instead of overflowing the popup.
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              } as const;
              return (
                <Box component="tr" key={i}>
                  <Box
                    component="td"
                    sx={{
                      ...cellSx,
                      color: "text.secondary",
                      pr: 1.5,
                      ...(isFirst ? { width: "40%" } : null),
                    }}>
                    {r.label}
                  </Box>
                  <Box
                    component="td"
                    sx={{
                      ...cellSx,
                      fontWeight: 600,
                      textAlign: "right",
                      // Subdued placeholder for missing values so they
                      // visually read as "no data" rather than blending
                      // with real values.
                      opacity: r.empty ? 0.45 : 1,
                      ...(isFirst ? { width: "60%" } : null),
                    }}>
                    {r.swatch && <ValueSwatch color={r.swatch} />}
                    {r.value}
                  </Box>
                </Box>
              );
            })}
          </tbody>
        </Box>
      ) : (
        visible.map((r, i) => {
          const isLast = i === visible.length - 1;
          return (
            <Stack
              key={i}
              spacing={0.25}
              sx={{
                pb: isLast ? 0 : 1.5,
                borderBottom: isLast ? 0 : 1,
                borderColor: ROW_DIVIDER_SX,
              }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
                {r.label}
              </Typography>
              <Typography
                variant="body2"
                fontWeight={600}
                sx={{
                  opacity: r.empty ? 0.45 : 1,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                }}>
                {r.swatch && <ValueSwatch color={r.swatch} />}
                {r.value}
              </Typography>
            </Stack>
          );
        })
      )}
      {hidden > 0 && (
        <Button
          size="small"
          variant="text"
          onClick={() => setExpanded(true)}
          sx={{ alignSelf: "flex-start", px: 0, fontSize: 11 }}>
          {`See ${hidden} more`}
        </Button>
      )}
    </Stack>
  );
}
