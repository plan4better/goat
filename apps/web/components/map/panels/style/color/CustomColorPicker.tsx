import {
  Box,
  ButtonBase,
  IconButton,
  Menu,
  MenuItem,
  OutlinedInput,
  Slider,
  Tooltip,
  Typography,
  debounce,
} from "@mui/material";
import { useState } from "react";
import { HexColorPicker } from "react-colorful";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { checkered } from "@/lib/style/checker";
import {
  type ColorFormat,
  alphaOfPercent,
  formatColor,
  parseColor,
  percentOf,
  withAlpha,
} from "@/lib/utils/colorFormats";
import { hexToRgb, isValidHex } from "@/lib/utils/helpers";

import type { SingleColorSelectorProps } from "@/types/map/color";

type CustomColorPickerProps = Partial<SingleColorSelectorProps> & {
  /** A hex color; with `onChange` the picker reports every change at once, as hex. */
  value?: string;
  onChange?: (hex: string) => void;
  /** The color's own transparency, edited beside the color; `locked`: shown, not changed. */
  transparency?: { locked?: boolean };
};

const FORMATS: ColorFormat[] = ["hex", "rgb", "hsl"];
const FORMAT_NAMES: Record<ColorFormat, string> = { hex: "Hex", rgb: "RGB", hsl: "HSL" };
/** The format people last typed colors in, kept in this browser when it allows. */
const FORMAT_KEY = "goat.color-format";

function readFormat(): ColorFormat {
  try {
    const stored = window.localStorage.getItem(FORMAT_KEY);
    return FORMATS.includes(stored as ColorFormat) ? (stored as ColorFormat) : "hex";
  } catch {
    return "hex";
  }
}

function writeFormat(format: ColorFormat): void {
  try {
    window.localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // Private windows and blocked storage: the format stays for this page only.
  }
}

interface EyeDropperResult {
  sRGBHex: string;
}

/** The browser's eyedropper (Chrome and Edge), or null where there is none. */
function eyeDropper(): { open: () => Promise<EyeDropperResult> } | null {
  if (typeof window === "undefined" || !("EyeDropper" in window)) return null;
  const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<EyeDropperResult> } })
    .EyeDropper;
  return new Dropper();
}

const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** The look of react-colorful's pointer, which the transparency bar's thumb takes too. */
const POINTER_SHADOW = "0 0 0 1px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.3)";

/** The color field and hue bar, the eyedropper where the browser has one, and the color as text in the format
 * chosen (Hex, RGB or HSL, inside the text field), which also reads what is typed. With `transparency`, the color's
 * own transparency: a bar of its own under the hue bar, over the swatch checkerboard, in steps of one percent, and a
 * percent beside the text field. react-colorful draws and reports the color alone (six digits), so an answer to its
 * own move is always the color it sent; the alpha never passes through it. The color is reported with eight digits
 * below 100 %; its alpha is kept exactly through every change of the color, a color chosen from None (0 %) is opaque
 * again, and a typed or pasted eight-digit hex sets both. `locked`: the transparency is shown and not changed (a color
 * GOAT derives), and a color chosen is opaque. */
function CustomColorPicker({
  selectedColor: selected,
  onSelectColor,
  value,
  onChange,
  transparency,
}: CustomColorPickerProps) {
  const { t } = useTranslation("common");
  const selectedColor = value ?? selected ?? "#000000";
  const valid = transparency
    ? HEX_COLOR.test(selectedColor)
    : isValidHex(selectedColor) && selectedColor.length === 7;
  const shown = (valid ? selectedColor : "#ffffff").toLowerCase();
  const alpha = transparency ? (parseInt(shown.slice(7) || "ff", 16) as number) : 255;
  const locked = transparency?.locked === true;
  const rgb = shown.slice(0, 7);
  const [format, setFormat] = useState<ColorFormat>(readFormat);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [percentDraft, setPercentDraft] = useState("");
  const [typingPercent, setTypingPercent] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [canDrop] = useState(() => eyeDropper() !== null);
  // The texts follow the color, worked out here, unless they are being typed.
  const text = valid ? formatColor(selectedColor, format) : "";
  const percent = String(percentOf(shown));

  const reportDebounced = debounce((hex: string) => onSelectColor?.(hexToRgb(hex), undefined), 100);
  const report = (hex: string, now = false) => {
    if (onChange) onChange(hex);
    else if (now) onSelectColor?.(hexToRgb(hex));
    else reportDebounced(hex);
  };
  /** A color chosen: at the transparency it has, opaque from None or while locked. */
  const pickColor = (hex: string, now = false) => {
    const rgb = hex.slice(0, 7).toLowerCase();
    if (!transparency) return report(rgb, now);
    report(withAlpha(rgb, locked || alpha === 0 ? 255 : alpha), now);
  };
  const pickAlpha = (next: number) => {
    if (!locked) report(withAlpha(shown, next), true);
  };

  const pickFromScreen = async () => {
    try {
      const result = await eyeDropper()?.open();
      if (result && isValidHex(result.sRGBHex)) pickColor(result.sRGBHex, true);
    } catch {
      // Escape or a refused pick leaves the color as it was.
    }
  };

  // The bars: the hue, and under it the transparency, in one style; the eyedropper beside the hue bar.
  const bar = {
    borderRadius: "6px",
    height: "12px",
    marginTop: "12px",
    // Room on the left for the eyedropper.
    ...(canDrop ? { marginLeft: "36px", width: "calc(100% - 36px)" } : { width: "100%" }),
  };
  const formatSwitch = (
    <ButtonBase
      aria-label={t("color_format")}
      aria-haspopup="menu"
      onClick={(event) => setMenu(event.currentTarget)}
      sx={{
        flex: "none",
        gap: 0.5,
        height: 28,
        px: 1,
        mr: -1,
        borderRadius: 1,
        fontSize: "0.8125rem",
        fontWeight: 600,
      }}>
      {FORMAT_NAMES[format]}
      <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 10, color: "text.secondary" }} />
    </ButtonBase>
  );

  return (
    <Box
      sx={{
        mt: 1,
        "& .react-colorful": { width: "100%", height: 168 },
        "& .react-colorful__saturation": { borderRadius: "6px", borderBottom: "none" },
        "& .react-colorful__last-control": bar,
        "& .react-colorful__pointer": { width: 16, height: 16, borderWidth: 2, boxShadow: POINTER_SHADOW },
      }}>
      <Box sx={{ position: "relative" }}>
        {transparency ? (
          // The color alone: the transparency is the bar's below.
          <HexColorPicker
            color={rgb}
            onChange={(hex) => {
              if (hex.toLowerCase() !== rgb) pickColor(hex);
            }}
          />
        ) : (
          <HexColorPicker color={shown} onChange={(hex) => report(hex)} />
        )}
        {canDrop && (
          <Tooltip title={t("pick_from_screen")}>
            <IconButton
              size="small"
              aria-label={t("pick_from_screen")}
              onClick={() => void pickFromScreen()}
              // Centred on the hue bar: the bar is 12 px at the bottom, the button 24 px.
              sx={{ position: "absolute", left: -4, bottom: -6 }}>
              <Icon iconName={ICON_NAME.EYEDROPPER} style={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      {transparency && (
        // The color's own transparency, in whole percents: a stored alpha between two percents stays as it is until
        // the bar moves. Its rail is the color from 0 to 100 % over the swatch checkerboard; the thumb looks like
        // react-colorful's pointers.
        <Slider
          aria-label={t("style_editor.transparency")}
          min={0}
          max={100}
          step={1}
          value={percentOf(shown)}
          disabled={locked}
          onChange={(_, next) => pickAlpha(alphaOfPercent(next as number))}
          sx={{
            ...bar,
            display: "block",
            boxSizing: "border-box",
            p: 0,
            "@media (pointer: coarse)": { p: 0 },
            "& .MuiSlider-rail": {
              opacity: 1,
              borderRadius: "6px",
              background: checkered(`linear-gradient(90deg, ${withAlpha(rgb, 0)}, ${rgb})`),
              boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.05)",
            },
            "& .MuiSlider-track": { display: "none" },
            "& .MuiSlider-thumb": {
              width: 16,
              height: 16,
              border: "2px solid #ffffff",
              backgroundColor: shown,
              boxShadow: POINTER_SHADOW,
              "&::before": { boxShadow: "none" },
              // MUI's larger touch area around the thumb would reach past the bar's end and make the popover scroll.
              "&::after": { width: 16, height: 16 },
              "&:hover, &.Mui-focusVisible, &.Mui-active": {
                boxShadow: `${POINTER_SHADOW}, 0 0 0 4px rgba(0, 0, 0, 0.12)`,
              },
            },
            "&.Mui-disabled": { opacity: 0.4 },
            "&.Mui-disabled .MuiSlider-thumb": { backgroundColor: shown },
          }}
        />
      )}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 3 }}>
        <OutlinedInput
          size="small"
          fullWidth
          value={typing ? draft : text}
          onFocus={() => {
            setDraft(text);
            setTyping(true);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            const hex = parseColor(event.target.value, format);
            // Eight digits carry the transparency with them (six digits are written where it is 100 %); the field
            // shows the color alone at once, the percent its transparency.
            if (hex?.length === 9) setDraft(formatColor(hex, format));
            if (hex && hex.length === 9 && transparency)
              report(withAlpha(hex, parseInt(hex.slice(7), 16)), true);
            else if (hex) pickColor(hex, true);
          }}
          onBlur={() => setTyping(false)}
          endAdornment={formatSwitch}
          inputProps={{ "aria-label": t("color_value"), spellCheck: false }}
          sx={{ height: 32, fontSize: "0.8125rem", fontVariantNumeric: "tabular-nums" }}
        />
        {transparency && (
          <OutlinedInput
            size="small"
            value={typingPercent ? percentDraft : percent}
            disabled={locked}
            onFocus={() => {
              setPercentDraft(percent);
              setTypingPercent(true);
            }}
            onChange={(event) => {
              setPercentDraft(event.target.value);
              const text = event.target.value.trim();
              const n = Number(text);
              if (/^\d{1,3}$/.test(text) && n <= 100) pickAlpha(alphaOfPercent(n));
            }}
            onBlur={() => setTypingPercent(false)}
            endAdornment={
              <Typography
                component="span"
                variant="body2"
                color="text.secondary"
                sx={{ fontSize: "0.8125rem" }}>
                %
              </Typography>
            }
            inputProps={{
              "aria-label": t("style_editor.transparency_percent"),
              inputMode: "numeric",
              spellCheck: false,
            }}
            sx={{
              flex: "none",
              width: 72,
              height: 32,
              fontSize: "0.8125rem",
              fontVariantNumeric: "tabular-nums",
            }}
          />
        )}
        {/* Above the popovers that hold the picker (theirs go above MUI's menus), opening upward over the picker. */}
        <Menu
          anchorEl={menu}
          open={!!menu}
          onClose={() => setMenu(null)}
          anchorOrigin={{ vertical: "top", horizontal: "right" }}
          transformOrigin={{ vertical: "bottom", horizontal: "right" }}
          MenuListProps={{ dense: true }}
          sx={{ zIndex: 1500 }}
          slotProps={{
            paper: { sx: { minWidth: 96, mt: -1, "& .MuiMenuItem-root": { fontSize: "0.8125rem" } } },
          }}>
          {FORMATS.map((f) => (
            <MenuItem
              key={f}
              selected={f === format}
              onClick={() => {
                setFormat(f);
                writeFormat(f);
                setMenu(null);
              }}>
              {FORMAT_NAMES[f]}
            </MenuItem>
          ))}
        </Menu>
      </Box>
    </Box>
  );
}

export default CustomColorPicker;
