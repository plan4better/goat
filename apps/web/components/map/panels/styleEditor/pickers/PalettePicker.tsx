// The palette picker (prototype 5.2, redrawn on the design canvas): GOAT's catalogue by kind as plain strips in two
// columns (in classes when `steps` is given), the hovered or chosen palette's name in one line above them, an inline
// palette as "Yours", and Reverse as a toggle. Reverse lives only here, for every editor that opens the picker; a
// palette's own colors are edited in the list under its Palette row (`PaletteColors`).
import { Box, ButtonBase, Chip, IconButton, Tooltip, Typography } from "@mui/material";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { PALETTES } from "@/lib/style/generated/catalog";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";

export type PaletteKind = "sequential" | "diverging" | "qualitative";

export { paletteColors };

export interface PalettePickerProps {
  value: string | string[];
  reverse?: boolean;
  onChange: (value: string | string[]) => void;
  onReverse?: (reverse: boolean) => void;
  steps?: number;
  kinds: PaletteKind[];
}

/** A strip of `colors`: blended, or in equal blocks for classes. */
export function stripBackground(colors: string[], stepped: boolean): string {
  if (colors.length < 2) return colors[0] ?? "transparent";
  if (!stepped) return `linear-gradient(90deg, ${colors.join(", ")})`;
  const n = colors.length;
  return `linear-gradient(90deg, ${colors
    .map((c, i) => `${c} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`)
    .join(", ")})`;
}

const ordered = (colors: string[], reverse?: boolean) => (reverse ? [...colors].reverse() : colors);

/** The colors a strip shows: in classes, the colors `steps` classes get from the palette (`paletteSteps`, as the
 * classes are colored; a list in a picker of qualitative palettes only, the categories', repeats in order); else the
 * palette's own colors. Turned round where `reverse` says so. */
function stripColors(
  value: string | string[],
  { steps, reverse, kinds }: { steps?: number; reverse?: boolean; kinds: PaletteKind[] }
): string[] {
  if (steps === undefined) return ordered(Array.isArray(value) ? value : paletteColors(value), reverse);
  const qualitative = Array.isArray(value) && kinds.length === 1 && kinds[0] === "qualitative";
  return paletteSteps(value, steps, { reverse, kind: qualitative ? "qualitative" : undefined });
}

function Strip({
  name,
  colors,
  stepped,
  selected,
  onPick,
  onHover,
}: {
  name: string;
  colors: string[];
  stepped: boolean;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <ButtonBase
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={onPick}
      onMouseEnter={onHover}
      onFocus={onHover}
      sx={{
        display: "block",
        width: "100%",
        height: 22,
        borderRadius: 1.5,
        background: stripBackground(colors, stepped),
        boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`,
        outline: selected ? 2 : 0,
        outlineColor: "primary.main",
        outlineOffset: 2,
        "&:hover, &.Mui-focusVisible": {
          outline: 2,
          outlineColor: selected ? "primary.main" : "text.secondary",
          outlineOffset: 2,
        },
      }}
    />
  );
}

export function PalettePicker({ value, reverse, onChange, onReverse, steps, kinds }: PalettePickerProps) {
  const { t } = useTranslation("common");
  const [kind, setKind] = useState<PaletteKind | "all">("all");
  const [hover, setHover] = useState<string | null>(null);
  // All palettes: a group of the catalogue (the science ramps) first, under its own heading; a kind lists every
  // palette of it in the catalogue's order.
  const shown = useMemo(() => {
    const fitting = Object.entries(PALETTES).filter(
      ([, p]) => kinds.includes(p.kind) && (kind === "all" || p.kind === kind)
    );
    return kind === "all"
      ? [...fitting.filter(([, p]) => p.group), ...fitting.filter(([, p]) => !p.group)]
      : fitting;
  }, [kinds, kind]);
  /** The heading over a palette in All palettes: its group's, else its kind's, where it starts a run of them. */
  const sectionOf = (p: (typeof PALETTES)[string]) =>
    p.group ? `style_editor.palette_group_${p.group}` : `style_editor.palette_kind_${p.kind}`;
  const stepped = steps !== undefined;

  const custom = Array.isArray(value) ? value : undefined;
  const named = (id: string) => {
    if (id === "custom") return { name: t("style_editor.my_colors"), kind: t("style_editor.palette_custom") };
    const p = PALETTES[id];
    return p ? { name: p.name, kind: t(`style_editor.palette_kind_${p.kind}`) } : undefined;
  };
  const current = custom ? "custom" : (value as string);
  const label = named(hover ?? current) ?? named(current);
  const heading = (text: string) => (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{
        gridColumn: "1 / -1",
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        pt: 1,
      }}>
      {text}
    </Typography>
  );

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, pt: 1 }}>
        {(["all", ...kinds] as const).map((k) => (
          <Chip
            key={k}
            size="small"
            component="button"
            label={t(`style_editor.palette_kind_${k}`)}
            aria-label={t(`style_editor.palette_kind_${k}`)}
            color={kind === k ? "primary" : "default"}
            onClick={() => setKind(k)}
          />
        ))}
        <Box sx={{ flex: 1 }} />
        {onReverse && (
          <Tooltip title={t("style_editor.reverse")}>
            <IconButton
              size="small"
              aria-label={t("style_editor.reverse")}
              aria-pressed={!!reverse}
              color={reverse ? "primary" : "default"}
              onClick={() => onReverse(!reverse)}>
              <Icon iconName={ICON_NAME.REVERSE} sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          height: 36,
          mx: 3,
          my: 2,
          px: 3,
          borderRadius: 2,
          bgcolor: "action.hover",
        }}>
        <Typography variant="body2" fontWeight="bold" noWrap>
          {label?.name}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
          {label?.kind}
        </Typography>
        {(hover ?? current) === current && (
          <Typography variant="caption" color="primary" fontWeight="bold">
            {t("style_editor.palette_in_use")}
          </Typography>
        )}
      </Box>
      <Box
        onMouseLeave={() => setHover(null)}
        sx={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 3,
          px: 3,
          py: 1,
          maxHeight: 360,
          overflowY: "auto",
        }}>
        {custom && (
          <>
            {kind === "all" && heading(t("style_editor.palette_yours"))}
            <Strip
              name={t("style_editor.my_colors")}
              colors={stripColors(custom, { steps, reverse, kinds })}
              stepped={stepped}
              selected
              onPick={() => onChange(custom)}
              onHover={() => setHover("custom")}
            />
          </>
        )}
        {shown.map(([id, palette], i) => (
          <Fragment key={id}>
            {kind === "all" &&
              (i === 0 || sectionOf(shown[i - 1][1]) !== sectionOf(palette)) &&
              heading(t(sectionOf(palette)))}
            <Strip
              name={palette.name}
              colors={stripColors(id, { steps, reverse, kinds })}
              stepped={stepped}
              selected={value === id}
              onPick={() => onChange(id)}
              onHover={() => setHover(id)}
            />
          </Fragment>
        ))}
      </Box>
    </Box>
  );
}
