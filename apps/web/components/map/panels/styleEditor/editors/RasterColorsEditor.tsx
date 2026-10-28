"use client";

// The colors of a raster color range or hillshade (prototype 4.7; spec 9.2, 9.4): a palette over a written range,
// continuous or in classes written by hand (computed classes need the raster service), or own colors at own values.
import { Box, Button, IconButton } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { equalClasses } from "@/lib/style/editor/raster";
import { getIn, setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";
import { seedDomain } from "@/lib/style/raster/metadata";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import {
  useEditor,
  useRasterSample,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { StopsEditor } from "@/components/map/panels/styleEditor/editors/StopsEditor";
import { PalettePicker } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  ColorField,
  NavRow,
  NumberInput,
  Row,
  SwitchRow,
} from "@/components/map/panels/styleEditor/rows";

const COUNTS = [3, 4, 5, 6, 7, 8, 9];
/** Methods that compute classes from the band's histogram: listed, not offered until the raster service. */
const LATER = ["equal_interval", "quantile", "natural_breaks"];

/** A palette as a CSS gradient (continuous) or in steps (classes). */
export function paletteStrip(colors: string[], stepped: boolean): string | undefined {
  if (!colors.length) return undefined;
  if (!stepped) return `linear-gradient(90deg, ${colors.join(", ")})`;
  const n = colors.length;
  return `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(", ")})`;
}

/** The colors a render shows, in order: its stops, its classes or its palette. */
export function renderColors(render: JsonObject): { colors: string[]; stepped: boolean } {
  if (Array.isArray(render.stops))
    return {
      colors: render.stops.filter(isObject).map((s) => String(s.color)),
      stepped: render.interpolate === "nearest",
    };
  const palette = (render.palette ?? DEFAULTS["continuous.palette"]) as string | string[];
  const classify = isObject(render.classify) ? render.classify : null;
  if (classify && Array.isArray(classify.classes)) {
    const steps = paletteSteps(palette, classify.classes.length);
    const colors = render.reverse === true ? [...steps].reverse() : steps;
    return {
      colors: classify.classes.map((c, i) =>
        isObject(c) && typeof c.color === "string" ? c.color : colors[i]
      ),
      stepped: true,
    };
  }
  const colors = paletteColors(palette);
  return { colors: render.reverse === true ? [...colors].reverse() : colors, stepped: false };
}

function ClassRows({ domain }: { domain: [number, number] }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const render = useStyleValue<JsonObject>("render");
  const classify = isObject(render?.classify) ? render.classify : {};
  const classes = (Array.isArray(classify.classes) ? classify.classes : []).filter(isObject);
  const { colors } = renderColors(render ?? {});
  const path = (i: number) => `render.classify.classes.${i}`;
  const rangeText = (c: JsonObject) =>
    typeof c.from !== "number"
      ? t("style_editor.class_under", { value: c.to ?? domain[1] })
      : typeof c.to !== "number"
        ? t("style_editor.class_and_more", { value: c.from })
        : t("style_editor.class_between", { from: c.from, to: c.to });
  return (
    <>
      {classes.map((c, i) => {
        const hidden = c.visible === false;
        return (
          <Row
            key={i}
            actions={
              <IconButton
                size="small"
                aria-label={t(hidden ? "style_editor.show_class" : "style_editor.hide_class")}
                onClick={() => store.set(`${path(i)}.visible`, hidden ? undefined : false)}>
                <Icon iconName={hidden ? ICON_NAME.EYE_SLASH : ICON_NAME.EYE} sx={{ fontSize: 12 }} />
              </IconButton>
            }>
            <Box sx={{ display: "flex", gap: 2, flex: 1, minWidth: 0, alignItems: "center" }}>
              <TextFieldInput
                value={typeof c.name === "string" ? c.name : ""}
                placeholder={rangeText(c)}
                clearable={false}
                inputProps={{ "aria-label": t("style_editor.class_name") }}
                onChange={(text) => store.set(`${path(i)}.name`, text || undefined)}
              />
              <ColorField
                value={colors[i]}
                onOpenPicker={(anchor) =>
                  popover.open("picker", {
                    key: `raster-class-color:${i}`,
                    title: rangeText(c),
                    anchorTop: anchorTopOf(anchor),
                    anchorEl: anchor,
                    render: () => (
                      <PathColorPicker
                        path={`${path(i)}.color`}
                        fallback={colors[i]}
                        write={(color) => store.set(`${path(i)}.color`, color)}
                      />
                    ),
                  })
                }
              />
              {i > 0 && (
                <NumberInput
                  value={c.from as number | undefined}
                  ariaLabel={t("style_editor.class_lower_bound")}
                  onChange={(v) =>
                    store.update(
                      (doc) => setIn(setIn(doc, `${path(i)}.from`, v), `${path(i - 1)}.to`, v),
                      `${path(i)}.from`
                    )
                  }
                />
              )}
            </Box>
          </Row>
        );
      })}
    </>
  );
}

export function RasterColorsEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const sample = useRasterSample();
  const { raster } = useStyleData();
  const value = useStyleValue<unknown>("render");
  const [note, setNote] = useState<string | null>(null);
  const render: JsonObject = isObject(value) ? value : {};
  const terrain = render.type === "terrain";
  const band = typeof render.band === "number" ? render.band : 1;
  const stops = Array.isArray(render.stops) ? render.stops.filter(isObject) : null;
  const domain = (Array.isArray(render.domain) ? render.domain : [0, 1]) as [number, number];
  const classify = isObject(render.classify) ? render.classify : null;
  const count = classify && Array.isArray(classify.classes) ? classify.classes.length : 5;
  const colored = !terrain || render.palette !== undefined;

  const fromData = async () => {
    const found = await sample(band);
    const seeded = found && raster?.info ? seedDomain(found, raster.info) : null;
    if (!seeded) {
      setNote(t("style_editor.range_nothing_found"));
      return;
    }
    setNote(null);
    store.update((doc) => {
      let next = setIn(doc, "render.domain", seeded);
      if (classify) next = setIn(next, "render.classify.classes", equalClasses(seeded, count));
      return next;
    }, "render.domain");
  };

  /** Hillshade colors on start from a written range or the values on the map; with neither they stay off. */
  const toggleColors = async () => {
    if (colored) {
      store.update((doc) => {
        const next = { ...render };
        for (const key of ["palette", "reverse", "domain", "classify", "outside"]) delete next[key];
        return setIn(doc, "render", next);
      });
      return;
    }
    let range = Array.isArray(render.domain) ? (render.domain as [number, number]) : null;
    if (!range) {
      const found = await sample(band);
      range = found && raster?.info ? seedDomain(found, raster.info) : null;
    }
    if (!range) {
      setNote(t("style_editor.range_nothing_found"));
      return;
    }
    setNote(null);
    const seeded = range;
    store.update((doc) => {
      const now = getIn(doc, "render");
      const base = isObject(now) ? now : render;
      return setIn(doc, "render", { ...base, palette: DEFAULTS["continuous.palette"], domain: seeded });
    });
  };

  const setKind = (kind: string) =>
    store.update((doc) => {
      if (kind === "stops") {
        const colors = paletteSteps(
          (render.palette ?? DEFAULTS["continuous.palette"]) as string | string[],
          5
        );
        const ordered = render.reverse === true ? [...colors].reverse() : colors;
        const [d0, d1] = domain;
        const next = {
          ...render,
          stops: ordered.map((color, i) => ({ value: d0 + ((d1 - d0) * i) / 4, color })),
        };
        for (const key of ["palette", "reverse", "domain", "classify"]) delete next[key];
        return setIn(doc, "render", next);
      }
      const values = (stops ?? []).map((s) => s.value as number);
      const next: JsonObject = { ...render, domain: [values[0] ?? 0, values[values.length - 1] ?? 1] };
      delete next.stops;
      delete next.interpolate;
      return setIn(doc, "render", next);
    }, "render.colors");

  const setMethod = (method: string) =>
    store.set(
      "render.classify",
      method === "manual" ? { method, classes: equalClasses(domain, 5) } : undefined
    );

  const openPalette = (anchor: HTMLElement) =>
    popover.open("picker", {
      key: "raster:palette",
      title: t("style_editor.palette"),
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => <RasterPalettePicker steps={classify ? count : undefined} />,
    });

  const { colors, stepped } = renderColors(render);
  return (
    <>
      {terrain && (
        <SwitchRow
          label={t("style_editor.hillshade_colors")}
          on={colored}
          valueText={t(colored ? "style_editor.hillshade_colors_on" : "style_editor.hillshade_colors_off")}
          note={colored ? undefined : (note ?? undefined)}
          onToggle={() => void toggleColors()}
        />
      )}
      {!terrain && (
        <ChoiceRow<string>
          label={t("style_editor.colors_kind")}
          value={stops ? "stops" : "palette"}
          options={["palette", "stops"].map((v) => ({
            value: v,
            label: t(`style_editor.colors_${v}`),
            sub: t(`style_editor.colors_${v}_sub`),
          }))}
          onChange={setKind}
        />
      )}
      {stops ? (
        <StopsEditor />
      ) : (
        colored && (
          <>
            <ChoiceRow<string>
              label={t("style_editor.method")}
              value={classify ? "manual" : "continuous"}
              options={[
                ...["continuous", "manual"].map((v) => ({
                  value: v,
                  label: t(`style_editor.raster_method_${v}`),
                  sub: t(`style_editor.raster_method_${v}_sub`),
                })),
                ...LATER.map((v) => ({
                  value: v,
                  label: t(`style_editor.method_${v}`),
                  sub: t("style_editor.needs_raster_service"),
                  disabled: true,
                })),
              ]}
              onChange={setMethod}
            />
            {classify && (
              <ChoiceRow<number>
                label={t("style_editor.classes")}
                value={count}
                options={COUNTS.map((n) => ({
                  value: n,
                  label: t("style_editor.count_classes", { count: n, defaultValue: String(n) }),
                }))}
                onChange={(n) =>
                  store.update((doc) => {
                    const before = (classify.classes as JsonObject[]) ?? [];
                    const next = equalClasses(domain, n).map((c, i) => {
                      const { name, color, visible } = before[i] ?? {};
                      return {
                        ...c,
                        ...(name ? { name } : {}),
                        ...(color ? { color } : {}),
                        ...(visible === false ? { visible } : {}),
                      };
                    });
                    return setIn(doc, "render.classify.classes", next);
                  })
                }
              />
            )}
            <NavRow
              label={t("style_editor.palette")}
              value={
                Array.isArray(render.palette)
                  ? t("style_editor.palette_custom")
                  : String(render.palette ?? DEFAULTS["continuous.palette"])
              }
              swatch={{ background: paletteStrip(colors, stepped) ?? "transparent", wide: true }}
              onOpen={openPalette}
            />
            <Row label={t("style_editor.range")}>
              <Box sx={{ display: "flex", gap: 2, alignItems: "center", flex: 1, minWidth: 0 }}>
                <NumberInput
                  value={domain[0]}
                  ariaLabel={t("style_editor.range_lowest")}
                  onChange={(v) =>
                    store.update((doc) => setIn(doc, "render.domain", [v, domain[1]]), "render.domain")
                  }
                />
                <NumberInput
                  value={domain[1]}
                  ariaLabel={t("style_editor.range_highest")}
                  onChange={(v) =>
                    store.update((doc) => setIn(doc, "render.domain", [domain[0], v]), "render.domain")
                  }
                />
              </Box>
            </Row>
            <Row note={note ?? undefined}>
              <Button size="small" color="inherit" onClick={() => void fromData()}>
                {t("style_editor.range_from_data")}
              </Button>
            </Row>
            {!classify && (
              <ChoiceRow<string>
                label={t("style_editor.outside")}
                value={render.outside === "hide" ? "hide" : "clamp"}
                options={["clamp", "hide"].map((v) => ({
                  value: v,
                  label: t(`style_editor.outside_${v}`),
                  sub: t(`style_editor.outside_${v}_sub`),
                }))}
                onChange={(v) => store.set("render.outside", v === "clamp" ? undefined : v)}
              />
            )}
            {classify && <ClassRows domain={domain} />}
          </>
        )
      )}
    </>
  );
}

function RasterPalettePicker({ steps }: { steps?: number }) {
  const store = useEditor();
  const palette = useStyleValue<string | string[] | undefined>("render.palette");
  const reverse = useStyleValue<boolean | undefined>("render.reverse");
  return (
    <PalettePicker
      value={palette ?? (DEFAULTS["continuous.palette"] as string)}
      reverse={reverse === true}
      steps={steps}
      kinds={["sequential", "diverging"]}
      onChange={(next) => store.set("render.palette", next)}
      onReverse={(next) => store.set("render.reverse", next || undefined)}
    />
  );
}
