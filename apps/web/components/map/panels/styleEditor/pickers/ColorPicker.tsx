// The color picker (prototype 5.1): the color's choices first as small buttons
// ("Auto", "None", "Same as fill/line"), swatches (the colors of this style, GOAT's colors and the last ten picked, kept
// in this browser when it allows), then the color field, the hue bar and under it the color's own transparency, with
// the color as Hex, RGB or HSL and its percent beside it. A color is never shown with eight digits. The part's opacity
// is not here: each part has its own Opacity row, by zoom and by classes too; the two multiply (spec 4.6).
import { Box, ButtonBase, Typography, styled } from "@mui/material";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { checkered } from "@/lib/style/checker";
import { alphaOf, isNone, opaque } from "@/lib/style/colors";
import { colorLabel } from "@/lib/style/editor/summaries";
import { withAlpha } from "@/lib/utils/colorFormats";

import CustomColorPicker from "@/components/map/panels/style/color/CustomColorPicker";
import { HATCH } from "@/components/map/panels/styleEditor/rows/ColorField";

export const GOAT_COLORS = [
  "#2bb381",
  "#1a6b4d",
  "#80d1b3",
  "#d9f2e8",
  "#3a3541",
  "#6b7280",
  "#c9ced6",
  "#ffffff",
  "#2166ac",
  "#4393c3",
  "#92c5de",
  "#7f3c8d",
  "#e7298a",
  "#d7301f",
  "#f46d43",
  "#fdae61",
  "#fee08b",
  "#ffd400",
  "#4daf4a",
  "#11a5c9",
];
const RECENT_MAX = 10;
const DOC_MAX = 10;

function readRecent(key: string): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((c): c is string => typeof c === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function writeRecent(key: string, colors: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(colors.slice(0, RECENT_MAX)));
  } catch {
    // Private windows and blocked storage: the list stays for this page only.
  }
}

/** A swatch's color in lower case, six digits where it is opaque. */
const swatchColor = (color: string) => {
  const alpha = alphaOf(color);
  return alpha === undefined ? color.toLowerCase() : withAlpha(color, alpha);
};

/** One swatch: a plain button with one shared class, as a drag re-renders the picker on every move. */
const SwatchButton = styled("button")(({ theme }) => ({
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: 4,
  border: `2px solid ${theme.palette.divider}`,
  cursor: "pointer",
  '&[aria-pressed="true"]': { borderColor: theme.palette.primary.main },
}));

const Swatches = memo(function Swatches({
  title,
  colors,
  selected,
  onPick,
}: {
  title: string;
  colors: string[];
  /** The swatch of the current color (lower case), if any. */
  selected?: string;
  onPick: (hex: string) => void;
}) {
  const { t } = useTranslation("common");
  // A color listed twice (a palette's repeated stop) shows once; a None color is the None choice's, not a swatch.
  const unique = [...new Set(colors.map(swatchColor))].filter((c) => !isNone(c));
  if (!unique.length) return null;
  return (
    <Box sx={{ px: 3, pt: 2 }}>
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, pt: 1 }}>
        {unique.map((color) => (
          <SwatchButton
            key={color}
            type="button"
            aria-label={colorLabel(t, color)}
            aria-pressed={color === selected}
            onClick={() => onPick(color)}
            style={{ background: checkered(color) }}
          />
        ))}
      </Box>
    </Box>
  );
});

/** A value taken from elsewhere (a color from another part, the arrows' own icon), as a choice beside the picker's
 * swatches or tiles: marked as a picked swatch is (a primary outline) and with a check while it is the value. */
export function SentinelOption({ label, selected, onPick, glyph }: Sentinel) {
  return (
    <Box sx={{ px: 3, pt: 2 }}>
      <ButtonBase
        aria-pressed={selected}
        onClick={onPick}
        sx={{
          width: "100%",
          height: 36,
          gap: 2,
          px: 2,
          justifyContent: "flex-start",
          borderRadius: 1,
          border: 2,
          borderColor: selected ? "primary.main" : "divider",
          color: selected ? "primary.main" : "text.secondary",
        }}>
        {glyph ?? (
          <Box
            sx={{
              width: 16,
              height: 16,
              flex: "none",
              borderRadius: "4px",
              boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`,
              background: HATCH,
            }}
          />
        )}
        <Typography
          variant="body2"
          fontWeight="bold"
          color="inherit"
          noWrap
          sx={{ flex: 1, textAlign: "left" }}>
          {label}
        </Typography>
        {selected && <Icon iconName={ICON_NAME.CHECK} sx={{ fontSize: 12 }} />}
      </ButtonBase>
    </Box>
  );
}

export interface Sentinel {
  label: string;
  /** The value is taken from the other part now (for None: the color is at 0 %). */
  selected: boolean;
  onPick: () => void;
  /** Drawn before the label in place of the hatched swatch. */
  glyph?: ReactNode;
  /** The None choice: shown with a checkerboard, and it leaves the transparency editable. */
  none?: boolean;
}

/** The color's choices as one row of small buttons in front of the swatches, pressed while one is the value. */
function ChoiceButtons({ choices }: { choices: Sentinel[] }) {
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, px: 3, pt: 2 }}>
      {choices.map((choice) => (
        <ButtonBase
          key={choice.label}
          aria-pressed={choice.selected}
          onClick={choice.onPick}
          sx={{
            height: 28,
            gap: 1,
            px: 2,
            borderRadius: 1,
            border: 2,
            borderColor: choice.selected ? "primary.main" : "divider",
            color: choice.selected ? "primary.main" : "text.secondary",
            fontSize: "0.8125rem",
            fontWeight: 700,
          }}>
          {choice.none && (
            <Box
              aria-hidden
              sx={{
                width: 12,
                height: 12,
                flex: "none",
                borderRadius: "3px",
                boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`,
                background: checkered("#00000000"),
              }}
            />
          )}
          {choice.label}
        </ButtonBase>
      ))}
    </Box>
  );
}

/** The None choice of a picker that writes its color itself: the color at 0 %, pressed while it is so. */
export const noneChoice = (
  label: string,
  value: string | undefined,
  onChange: (hex: string) => void
): Sentinel => ({
  label,
  none: true,
  selected: isNone(value),
  onPick: () => onChange(withAlpha(value ?? "#ffffff", 0)),
});

export interface ColorPickerProps {
  value: string | undefined;
  onChange: (hex: string) => void;
  /** The color's choices (Auto, None, Same as fill), as buttons in front of the swatches. */
  sentinels?: Sentinel[];
  docColors: string[];
  recentKey?: string;
  /** The color's own transparency, as a bar and a percent (default: on). */
  transparency?: boolean;
}

export function ColorPicker({
  value,
  onChange,
  sentinels,
  docColors,
  recentKey = "goat.style.recent-colors",
  transparency = true,
}: ColorPickerProps) {
  const { t } = useTranslation("common");
  const [recent, setRecent] = useState<string[]>(() => readRecent(recentKey));
  const latest = useRef(value);
  latest.current = value;
  const opened = useRef(value);
  // A choice that takes the color from elsewhere is the value (Auto, Same as fill): the picker shows the color it
  // draws, its transparency is not the row's to change.
  const derived = sentinels?.some((s) => s.selected && !s.none) ?? false;
  const latestDerived = useRef(derived);
  latestDerived.current = derived;
  const alpha = transparency && value ? (alphaOf(value) ?? 255) : 255;

  // The color the picker closes with counts as picked, as a color without its transparency.
  useEffect(
    () => () => {
      const last = latest.current;
      if (last && last !== opened.current && !latestDerived.current && !isNone(last)) {
        const color = opaque(last.toLowerCase());
        writeRecent(recentKey, [color, ...readRecent(recentKey).filter((c) => c !== color)]);
      }
    },
    [recentKey]
  );

  const pick = useCallback(
    (swatch: string) => {
      // A swatch with a transparency of its own is written as it is; an opaque one takes the color's percent, full
      // from None or from a color taken from elsewhere.
      const keep = derived || alpha === 0 ? 255 : alpha;
      // Without a transparency, every swatch is written as its color alone.
      onChange(
        transparency
          ? withAlpha(swatch, swatch.length === 9 ? parseInt(swatch.slice(7), 16) : keep)
          : opaque(swatch)
      );
      const color = opaque(swatch);
      setRecent((list) => {
        const next = [color, ...list.filter((c) => c !== color)].slice(0, RECENT_MAX);
        writeRecent(recentKey, next);
        return next;
      });
    },
    [onChange, recentKey, derived, alpha, transparency]
  );
  // Without a transparency the swatches show their colors alone.
  const shownAs = (c: string) => (transparency ? swatchColor(c) : opaque(swatchColor(c)));
  const docKey = docColors.slice(0, DOC_MAX).map(shownAs).join(",");
  // A swatch is selected only when the color is one of them: while dragging, the swatches do not render again.
  const all = [...docColors.slice(0, DOC_MAX), ...GOAT_COLORS, ...recent].map(shownAs);
  // Taken from another part, or None, the color the picker starts at is not a swatch's; a color with its own
  // transparency selects the swatch of its color.
  const lower = value ? shownAs(value) : undefined;
  const selected =
    !derived && lower && !isNone(lower)
      ? all.includes(lower)
        ? lower
        : all.includes(opaque(lower))
          ? opaque(lower)
          : undefined
      : undefined;
  const docSwatches = useMemo(() => (docKey ? docKey.split(",") : []), [docKey]);

  return (
    <Box sx={{ pb: 2 }}>
      {!!sentinels?.length && <ChoiceButtons choices={sentinels} />}
      <Swatches
        title={t("style_editor.colors_in_this_style")}
        colors={docSwatches}
        selected={selected}
        onPick={pick}
      />
      <Swatches
        title={t("style_editor.goat_colors")}
        colors={GOAT_COLORS}
        selected={selected}
        onPick={pick}
      />
      <Swatches title={t("style_editor.recent_colors")} colors={recent} selected={selected} onPick={pick} />
      <Box sx={{ mx: 3, mt: 3, borderTop: 1, borderColor: "divider" }} />
      <Box sx={{ px: 3, pt: 1 }}>
        <CustomColorPicker
          value={
            value && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)
              ? transparency
                ? value
                : opaque(value)
              : "#ffffff"
          }
          onChange={onChange}
          transparency={transparency ? { locked: derived } : undefined}
        />
      </Box>
    </Box>
  );
}
