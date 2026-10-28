// The palette picker (prototype 5.2, redrawn on the design canvas): GOAT's catalogue by kind as plain strips in two
// columns (in classes when `steps` is given), the hovered or chosen palette's name in one line above them, Reverse
// as a toggle, and "Make my own palette": the colors as chips to pick, reorder and remove, each edited with the
// panel's color picker. Reverse lives only here, for every editor that opens the picker.
import { Box, Button, ButtonBase, Chip, Divider, IconButton, Tooltip, Typography } from "@mui/material";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { PALETTES } from "@/lib/style/generated/catalog";
import { paletteColors } from "@/lib/style/palettes";

import { ColorPicker } from "@/components/map/panels/styleEditor/pickers/ColorPicker";

export type PaletteKind = "sequential" | "diverging" | "qualitative";

export { paletteColors };

/** The fewest and most colors of a palette made by hand. */
const MIN_COLORS = 2;
const MAX_COLORS = 9;

export interface PalettePickerProps {
  value: string | string[];
  reverse?: boolean;
  onChange: (value: string | string[]) => void;
  onReverse?: (reverse: boolean) => void;
  steps?: number;
  kinds: PaletteKind[];
  allowCustom?: boolean;
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
        boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
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

export function PalettePicker({
  value,
  reverse,
  onChange,
  onReverse,
  steps,
  kinds,
  allowCustom = true,
}: PalettePickerProps) {
  const { t } = useTranslation("common");
  const [kind, setKind] = useState<PaletteKind | "all">("all");
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const shown = useMemo(
    () =>
      Object.entries(PALETTES).filter(
        ([, p]) => kinds.includes(p.kind) && (kind === "all" || p.kind === kind)
      ),
    [kinds, kind]
  );
  const stepped = steps !== undefined;

  if (editing) {
    const colors = ordered(paletteColors(value, Array.isArray(value) ? undefined : (steps ?? 5)), reverse);
    return (
      <PaletteEditor
        initial={colors.length >= MIN_COLORS ? colors.slice(0, MAX_COLORS) : ["#ffffff", "#000000"]}
        onApply={(colors) => {
          onChange(colors);
          if (reverse) onReverse?.(false);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

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
              colors={ordered(custom, reverse)}
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
              (i === 0 || shown[i - 1][1].kind !== palette.kind) &&
              heading(t(`style_editor.palette_kind_${palette.kind}`))}
            <Strip
              name={palette.name}
              colors={ordered(paletteColors(id, steps), reverse)}
              stepped={stepped}
              selected={value === id}
              onPick={() => onChange(id)}
              onHover={() => setHover(id)}
            />
          </Fragment>
        ))}
      </Box>
      {allowCustom && (
        <>
          <Divider sx={{ mt: 2, mb: 1 }} />
          <Button
            variant="text"
            size="small"
            startIcon={<Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: "12px !important" }} />}
            onClick={() => setEditing(true)}
            sx={{
              ml: 2,
              height: 32,
              px: 2.5,
              borderRadius: 2,
              fontSize: 13,
              fontWeight: 700,
              textTransform: "none",
            }}>
            {t("style_editor.make_my_own_palette")}
          </Button>
        </>
      )}
    </Box>
  );
}

/** A palette made by hand: the colors as chips (pick one to edit it, drag to reorder, remove on hover), a new color
 * at the end, the panel's color picker for the chosen one. Reversing is the picker's Reverse, after Apply. */
export function PaletteEditor({
  initial,
  onApply,
  onCancel,
}: {
  initial: string[];
  onApply: (colors: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const [colors, setColors] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [dragged, setDragged] = useState<number | null>(null);
  const at = Math.min(selected, colors.length - 1);

  const remove = (i: number) => {
    if (colors.length <= MIN_COLORS) return;
    setColors(colors.filter((_, k) => k !== i));
    setSelected(Math.max(0, at >= i ? at - 1 : at));
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...colors];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setColors(next);
    setSelected(to);
  };

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, pt: 1 }}>
        <IconButton size="small" aria-label={t("style_editor.back_to_palettes")} onClick={onCancel}>
          <Icon iconName={ICON_NAME.CHEVRON_LEFT} sx={{ fontSize: 12 }} />
        </IconButton>
        <Typography variant="body2" fontWeight="bold" sx={{ flex: 1 }}>
          {t("style_editor.my_colors")}
        </Typography>
      </Box>
      <Box sx={{ px: 3, pt: 2 }}>
        <Box
          sx={{
            height: 28,
            borderRadius: 2,
            background: stripBackground(colors, false),
            boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.08)",
          }}
        />
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, pt: 3, pb: 1 }}>
          {colors.map((color, i) => (
            <Box
              key={i}
              draggable
              onDragStart={() => setDragged(i)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null) move(dragged, i);
                setDragged(null);
              }}
              sx={{ position: "relative", "&:hover .remove, &:focus-within .remove": { opacity: 1 } }}>
              <ButtonBase
                aria-label={t("style_editor.palette_color", { n: i + 1, hex: color })}
                aria-pressed={i === at}
                onClick={() => setSelected(i)}
                sx={{
                  width: 30,
                  height: 30,
                  borderRadius: 2,
                  bgcolor: color,
                  cursor: "grab",
                  boxShadow: (theme) =>
                    i === at
                      ? `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${theme.palette.primary.main}`
                      : "inset 0 0 0 1px rgba(255, 255, 255, 0.12)",
                }}
              />
              {colors.length > MIN_COLORS && (
                <IconButton
                  className="remove"
                  size="small"
                  aria-label={t("style_editor.remove_color", { n: i + 1 })}
                  onClick={() => remove(i)}
                  sx={{
                    position: "absolute",
                    top: -8,
                    right: -8,
                    width: 18,
                    height: 18,
                    opacity: 0,
                    bgcolor: "background.default",
                    "&:hover": { bgcolor: "background.default" },
                  }}>
                  <Icon iconName={ICON_NAME.XCLOSE} sx={{ fontSize: 9 }} />
                </IconButton>
              )}
            </Box>
          ))}
          {colors.length < MAX_COLORS && (
            <Tooltip title={t("style_editor.add_color")}>
              <ButtonBase
                aria-label={t("style_editor.add_color")}
                onClick={() => {
                  setColors([...colors, colors[colors.length - 1]]);
                  setSelected(colors.length);
                }}
                sx={{
                  width: 30,
                  height: 30,
                  borderRadius: 2,
                  border: "1.5px dashed",
                  borderColor: "text.disabled",
                  color: "text.secondary",
                  "&:hover": { borderColor: "primary.main", color: "primary.main" },
                }}>
                <Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: 12 }} />
              </ButtonBase>
            </Tooltip>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ pb: 1 }}>
          {t("style_editor.palette_edit_note")}
        </Typography>
      </Box>
      <Divider sx={{ my: 1 }} />
      <ColorPicker
        value={colors[at]}
        docColors={[]}
        onChange={(hex) => setColors(colors.map((c, i) => (i === at ? hex : c)))}
      />
      {/* The map popovers' footer: text buttons, the confirming one in the primary color. */}
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, px: 2, pt: 2 }}>
        <Button variant="text" onClick={onCancel}>
          <Typography variant="body2" fontWeight="bold">
            {t("cancel")}
          </Typography>
        </Button>
        <Button variant="text" color="primary" onClick={() => onApply(colors)}>
          <Typography variant="body2" fontWeight="bold" color="inherit">
            {t("apply")}
          </Typography>
        </Button>
      </Box>
    </Box>
  );
}
