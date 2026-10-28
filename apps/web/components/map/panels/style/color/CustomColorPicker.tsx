import { Box, ButtonBase, IconButton, Menu, MenuItem, OutlinedInput, Tooltip, debounce } from "@mui/material";
import { useEffect, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type ColorFormat, formatColor, parseColor } from "@/lib/utils/colorFormats";
import { hexToRgb, isValidHex } from "@/lib/utils/helpers";

import type { SingleColorSelectorProps } from "@/types/map/color";

type CustomColorPickerProps = Partial<SingleColorSelectorProps> & {
  /** A hex color; with `onChange` the picker reports every change at once, as hex. */
  value?: string;
  onChange?: (hex: string) => void;
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

/** The color field and hue bar, the eyedropper where the browser has one, and the color as text in the format
 * chosen (Hex, RGB or HSL), which also reads what is typed. */
function CustomColorPicker({
  selectedColor: selected,
  onSelectColor,
  value,
  onChange,
}: CustomColorPickerProps) {
  const { t } = useTranslation("common");
  const selectedColor = value ?? selected ?? "#000000";
  const valid = isValidHex(selectedColor) && selectedColor.length === 7;
  const [format, setFormat] = useState<ColorFormat>(readFormat);
  const [draft, setDraft] = useState(() => (valid ? formatColor(selectedColor, format) : ""));
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [canDrop] = useState(() => eyeDropper() !== null);

  // The text follows the color unless it is being typed.
  useEffect(() => {
    if (!typing && valid) setDraft(formatColor(selectedColor, format));
  }, [selectedColor, format, typing, valid]);

  const reportDebounced = debounce((hex: string) => onSelectColor?.(hexToRgb(hex), undefined), 100);
  const report = (hex: string, now = false) => {
    if (onChange) onChange(hex);
    else if (now) onSelectColor?.(hexToRgb(hex));
    else reportDebounced(hex);
  };

  const pickFromScreen = async () => {
    try {
      const result = await eyeDropper()?.open();
      if (result && isValidHex(result.sRGBHex)) report(result.sRGBHex.toLowerCase(), true);
    } catch {
      // Escape or a refused pick leaves the color as it was.
    }
  };

  return (
    <Box
      sx={{
        mt: 1,
        "& .react-colorful": { width: "100%", height: 168 },
        "& .react-colorful__saturation": { borderRadius: "6px", borderBottom: "none" },
        "& .react-colorful__last-control": {
          borderRadius: "6px",
          height: "12px",
          marginTop: "12px",
          // Room on the left for the eyedropper.
          ...(canDrop ? { marginLeft: "36px", width: "calc(100% - 36px)" } : {}),
        },
        "& .react-colorful__pointer": {
          width: 16,
          height: 16,
          borderWidth: 2,
          boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.3)",
        },
      }}>
      <Box sx={{ position: "relative" }}>
        <HexColorPicker color={valid ? selectedColor : "#ffffff"} onChange={(hex) => report(hex)} />
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
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 3 }}>
        <OutlinedInput
          size="small"
          fullWidth
          value={draft}
          onFocus={() => setTyping(true)}
          onChange={(event) => {
            setDraft(event.target.value);
            const hex = parseColor(event.target.value, format);
            if (hex) report(hex, true);
          }}
          onBlur={() => {
            setTyping(false);
            if (valid) setDraft(formatColor(selectedColor, format));
          }}
          inputProps={{ "aria-label": t("color_value"), spellCheck: false }}
          sx={{ height: 32, fontSize: "0.8125rem", fontVariantNumeric: "tabular-nums" }}
        />
        <ButtonBase
          aria-label={t("color_format")}
          aria-haspopup="menu"
          onClick={(event) => setMenu(event.currentTarget)}
          sx={{
            flex: "none",
            gap: 0.5,
            height: 32,
            px: 1.5,
            borderRadius: 1,
            fontSize: "0.8125rem",
            fontWeight: 600,
          }}>
          {FORMAT_NAMES[format]}
          <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 10, color: "text.secondary" }} />
        </ButtonBase>
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
