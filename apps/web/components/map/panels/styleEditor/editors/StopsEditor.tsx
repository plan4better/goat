"use client";

// Own colors at own values (spec 9.2 `stops`, today's color maps): a value and a color per stop, sorted by value,
// blended or the nearest stop's color.
import { Box, Button, IconButton } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useEditor, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, ColorField, NumberInput, Row } from "@/components/map/panels/styleEditor/rows";

interface Stop {
  value: number;
  color: string;
}

export function StopsEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const value = useStyleValue<unknown>("render.stops");
  const interpolate = useStyleValue<unknown>("render.interpolate");
  const stops = (Array.isArray(value) ? value : []) as Stop[];
  const write = (next: Stop[]) => store.set("render.stops", next);
  // Sorted when the value box is left: sorting per keystroke would move the stop away from the cursor.
  const sortStops = () => {
    const current = store.get("render.stops");
    if (!Array.isArray(current)) return;
    const next = [...(current as Stop[])].sort((a, b) => a.value - b.value);
    if (next.some((stop, i) => stop !== current[i])) write(next);
  };
  return (
    <>
      {stops.map((stop, i) => (
        <Row
          key={i}
          label={t("style_editor.stop_n", { n: i + 1 })}
          actions={
            stops.length > 2 ? (
              <IconButton
                size="small"
                aria-label={t("style_editor.remove_stop")}
                onClick={() => write(stops.filter((_, j) => j !== i))}>
                <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 12 }} />
              </IconButton>
            ) : undefined
          }>
          <Box sx={{ display: "flex", gap: 2, flex: 1, minWidth: 0 }}>
            <NumberInput
              value={stop.value}
              ariaLabel={t("style_editor.stop_value")}
              onChange={(v) => write(stops.map((s, j) => (j === i ? { ...s, value: v } : s)))}
              onBlur={sortStops}
            />
            <ColorField
              value={stop.color}
              onOpenPicker={(anchor) =>
                popover.open("picker", {
                  key: `stop-color:${i}`,
                  title: t("style_editor.stop_n", { n: i + 1 }),
                  anchorTop: anchorTopOf(anchor),
                  anchorEl: anchor,
                  render: () => (
                    <PathColorPicker
                      path={`render.stops.${i}.color`}
                      write={(color) => color && store.set(`render.stops.${i}.color`, color)}
                    />
                  ),
                })
              }
            />
          </Box>
        </Row>
      ))}
      <Box sx={{ px: 3 }}>
        <Button
          size="small"
          color="inherit"
          onClick={() => {
            const last = stops[stops.length - 1];
            write([...stops, { value: (last?.value ?? 0) + 1, color: last?.color ?? "#9aa3ad" }]);
          }}>
          {t("style_editor.add_stop")}
        </Button>
      </Box>
      <ChoiceRow<string>
        label={t("style_editor.interpolate")}
        value={interpolate === "nearest" ? "nearest" : "linear"}
        options={["linear", "nearest"].map((v) => ({
          value: v,
          label: t(`style_editor.interpolate_${v}`),
          sub: t(`style_editor.interpolate_${v}_sub`),
        }))}
        onChange={(v) => store.set("render.interpolate", v === "linear" ? undefined : v)}
      />
    </>
  );
}
