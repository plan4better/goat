// The color picker (prototype 5.1): an optional "Same as fill/line" first, swatches (the colors of this style, GOAT's
// colors and the last ten picked, kept in this browser when it allows), then the color field and hue bar with the
// color as Hex, RGB or HSL. Opacity is not here: each part has its own Opacity row, by zoom and by classes too.
import { Box, ButtonBase, Typography, styled } from "@mui/material";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

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
  // A color listed twice (a palette's repeated stop) shows once.
  const unique = [...new Set(colors.map((c) => c.toLowerCase()))];
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
            aria-label={color}
            aria-pressed={color.toLowerCase() === selected}
            onClick={() => onPick(color)}
            style={{ background: color }}
          />
        ))}
      </Box>
    </Box>
  );
});

/** A color taken from another part, as a choice of value beside the swatches: marked as a picked swatch is (a primary
 * outline) and with a check while it is the value. */
function SentinelOption({ label, selected, onPick }: Sentinel) {
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

interface Sentinel {
  label: string;
  /** The value is taken from the other part now. */
  selected: boolean;
  onPick: () => void;
}

export interface ColorPickerProps {
  value: string | undefined;
  onChange: (hex: string) => void;
  sentinel?: Sentinel;
  docColors: string[];
  recentKey?: string;
}

export function ColorPicker({
  value,
  onChange,
  sentinel,
  docColors,
  recentKey = "goat.style.recent-colors",
}: ColorPickerProps) {
  const { t } = useTranslation("common");
  const [recent, setRecent] = useState<string[]>(() => readRecent(recentKey));
  const latest = useRef(value);
  latest.current = value;
  const opened = useRef(value);

  // The color the picker closes with counts as picked.
  useEffect(
    () => () => {
      const last = latest.current;
      if (last && last !== opened.current)
        writeRecent(recentKey, [last, ...readRecent(recentKey).filter((c) => c !== last)]);
    },
    [recentKey]
  );

  const pick = useCallback(
    (hex: string) => {
      onChange(hex);
      setRecent((list) => {
        const next = [hex, ...list.filter((c) => c !== hex)].slice(0, RECENT_MAX);
        writeRecent(recentKey, next);
        return next;
      });
    },
    [onChange, recentKey]
  );
  // A swatch is selected only when the color is one of them: while dragging, the swatches do not render again.
  const all = [...docColors.slice(0, DOC_MAX), ...GOAT_COLORS, ...recent].map((c) => c.toLowerCase());
  // Taken from another part, the color the picker starts at is not a swatch's.
  const selected =
    !sentinel?.selected && value && all.includes(value.toLowerCase()) ? value.toLowerCase() : undefined;
  const docKey = docColors.slice(0, DOC_MAX).join(",");
  const docSwatches = useMemo(() => (docKey ? docKey.split(",") : []), [docKey]);

  return (
    <Box sx={{ pb: 2 }}>
      {sentinel && <SentinelOption {...sentinel} />}
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
          value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"}
          onChange={onChange}
        />
      </Box>
    </Box>
  );
}
