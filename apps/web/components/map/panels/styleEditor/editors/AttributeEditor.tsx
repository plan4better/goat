"use client";

// A value by attribute (spec 4.3): the field, then a palette over it (colors) or a range and a scale (numbers), and
// the values the server computed for the field. A field or scale change saves at once; the values follow with the
// reply. "Fixed range" writes the domain as a clamp the server never replaces.
import { Box, Typography } from "@mui/material";
import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { domainPending } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import { keyOf } from "@/lib/style/editor/forms";
import { formatNumberText } from "@/lib/style/editor/labels";
import { type Path, setIn } from "@/lib/style/editor/store";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { type JsonObject, isObject } from "@/lib/style/json";

import { IssueNotice, useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import type { FieldProfile } from "@/components/map/panels/styleEditor/context";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { PalettePicker, paletteColors } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
import {
  anchorTopOf,
  useCloseWhenGone,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  FormButton,
  NavRow,
  NumberInput,
  Row,
  SliderRow,
  SwitchRow,
} from "@/components/map/panels/styleEditor/rows";

const SCALES = ["linear", "sqrt", "log"];

/** "12 to 9,800" for a number field's profile. */
export function profileRange(
  profile: FieldProfile | undefined,
  locale: string,
  to: string
): string | undefined {
  if (profile?.min === undefined || profile.max === undefined) return undefined;
  return `${formatNumberText(profile.min, {}, locale)} ${to} ${formatNumberText(profile.max, {}, locale)}`;
}

function AttributePalettePicker({ path }: { path: Path }) {
  const store = useEditor();
  const palette = useStyleValue<string | string[]>(`${path}.palette`);
  const reverse = useStyleValue<boolean | undefined>(`${path}.reverse`);
  return (
    <PalettePicker
      value={palette}
      reverse={reverse === true}
      kinds={["sequential", "diverging"]}
      onChange={(next) => store.set(`${path}.palette`, next)}
      onReverse={(next) => store.set(`${path}.reverse`, next || undefined)}
    />
  );
}

/** A value by attribute: a field with a palette (colors) or a range (numbers). */
const byAttribute = (form: unknown): form is Record<string, unknown> & { field: string } =>
  isObject(form) && typeof form.field === "string" && ("palette" in form || "range" in form);

export function AttributeEditor({ path }: { path: Path }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const popover = usePopover();
  const form = useStyleValue<unknown>(path);
  const issues = useIssueAt(path);
  // Each reply changes the stored document: the values may stop pending.
  const subscribe = useCallback((listener: () => void) => store.saver.subscribe(listener), [store]);
  const readStored = () => store.saver.stored;
  useSyncExternalStore(subscribe, readStored, readStored);
  // Made fixed (or by zoom) while open, by the row's mode or an undo: the editor closes.
  useCloseWhenGone(!byAttribute(form));
  if (!byAttribute(form))
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>
        {t("style_editor.not_by_attribute")}
      </Typography>
    );

  const key = keyOf(path);
  const isColor = CAPABILITIES[key]?.kind === "color";
  const slider = SLIDERS[key];
  const locale = i18n.language;
  const number = (n: number) => formatNumberText(n, {}, locale);
  const field = form.field;
  const fieldLabel = data.fields.find((f) => f.name === field)?.label ?? field;
  const computed =
    isObject(form.computed) && Array.isArray(form.computed.domain) ? form.computed.domain : undefined;
  const domain = (Array.isArray(form.domain) ? form.domain : computed) as [number, number] | undefined;
  const pending = domainPending(store, path);
  // Edits of one key coalesce into one undo step (a slider drag, typing a number).
  const write = (patch: JsonObject) =>
    store.update(
      (doc) => Object.entries(patch).reduce((next, [k, v]) => setIn(next, `${path}.${k}`, v), doc),
      `${path}.${Object.keys(patch).join(",")}`
    );

  const pickField = (anchor: HTMLElement) =>
    popover.open("picker", {
      key: `attr-field:${path}`,
      title: t("style_editor.field"),
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => (
        <FieldPicker
          fields={data.fields}
          filter="number"
          value={field}
          profile={(_, loaded) => profileRange(loaded, locale, t("style_editor.to"))}
          onChange={(name) => {
            // A domain written for the old field means nothing for the new one; the server computes the new one.
            write({ field: name, domain: undefined, computed: undefined });
            popover.close("picker");
          }}
        />
      ),
    });

  let values: string;
  if (pending || !domain) values = t("style_editor.values_pending");
  else if (isColor)
    values = t("style_editor.values_along_palette", { min: number(domain[0]), max: number(domain[1]) });
  else {
    const [a, b] = (Array.isArray(form.range) ? form.range : [0, 0]) as [number, number];
    const unit = (n: number) =>
      slider?.pct ? `${Math.round(n * 100)}%` : `${number(n)}${slider?.unit ? ` ${slider.unit}` : ""}`;
    values = t("style_editor.values_map", {
      min: number(domain[0]),
      max: number(domain[1]),
      a: unit(a),
      b: unit(b),
    });
  }

  const range = (Array.isArray(form.range) ? form.range : [0, 1]) as [number, number];
  // The fixed value's bounds, so a drag cannot raise its own end; a value past them is typed in the number. They start
  // at 0 at the latest: the smallest value may draw nothing, which keeps proportional symbols proportional.
  const fixedBounds = slider ?? { min: 0, max: 100, step: 1 };
  const bounds = { ...fixedBounds, min: Math.min(0, fixedBounds.min) };
  const fixed = Array.isArray(form.domain);
  const palette = (form.palette ?? "goat:green") as string | string[];
  const colors = paletteColors(palette);
  if (form.reverse === true) colors.reverse();

  return (
    <>
      <Row label={t("style_editor.field")}>
        <FormButton text={fieldLabel} onOpen={pickField} />
      </Row>
      {isColor ? (
        <>
          <NavRow
            label={t("style_editor.palette")}
            value={`${
              Array.isArray(palette) ? t("style_editor.palette_custom") : (PALETTES[palette]?.name ?? palette)
            }${form.reverse === true ? `, ${t("style_editor.reversed")}` : ""}`}
            swatch={{ background: `linear-gradient(90deg, ${colors.join(", ")})`, wide: true }}
            onOpen={(anchor) =>
              popover.open("picker", {
                key: `attr-palette:${path}`,
                title: t("style_editor.palette"),
                anchorTop: anchorTopOf(anchor),
                anchorEl: anchor,
                render: () => <AttributePalettePicker path={path} />,
              })
            }
          />
        </>
      ) : (
        <>
          <SliderRow
            label={t("style_editor.range_smallest")}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            unit={bounds.unit}
            pct={bounds.pct}
            value={range[0]}
            onChange={(v) => write({ range: [v, range[1]] })}
          />
          <SliderRow
            label={t("style_editor.range_largest")}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            unit={bounds.unit}
            pct={bounds.pct}
            value={range[1]}
            onChange={(v) => write({ range: [range[0], v] })}
          />
        </>
      )}
      <ChoiceRow<string>
        label={t("style_editor.scale")}
        value={typeof form.scale === "string" ? form.scale : "linear"}
        options={SCALES.map((s) => ({
          value: s,
          label: t(`style_editor.scale_${s}`),
          sub: t(
            isColor && s === "sqrt" ? "style_editor.scale_sqrt_sub_color" : `style_editor.scale_${s}_sub`
          ),
        }))}
        onChange={(scale) => write({ scale })}
      />
      <Row label={t("style_editor.values")}>
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
          {values}
        </Typography>
      </Row>
      <SwitchRow
        label={t("style_editor.fixed_range")}
        note={t("style_editor.note_fixed_range")}
        on={fixed}
        onToggle={() => {
          if (fixed) write({ domain: undefined });
          else {
            const profile = data.profile(field);
            const start = computed ?? [profile?.min ?? 0, profile?.max ?? 1];
            write({ domain: [...start] });
          }
        }}
      />
      {fixed && (
        <Row label={t("style_editor.domain")}>
          <NumberInput
            value={domain?.[0]}
            width={72}
            ariaLabel={t("style_editor.domain_from")}
            onChange={(v) => write({ domain: [v, domain?.[1] ?? v] })}
          />
          <Typography variant="caption" color="text.secondary">
            {t("style_editor.to")}
          </Typography>
          <NumberInput
            value={domain?.[1]}
            width={72}
            ariaLabel={t("style_editor.domain_to")}
            onChange={(v) => write({ domain: [domain?.[0] ?? v, v] })}
          />
        </Row>
      )}
      {issues.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1, px: 3, pt: 2 }}>
          {issues.map((issue, i) => (
            <IssueNotice key={`${issue.code}-${i}`} issue={issue} />
          ))}
        </Box>
      )}
    </>
  );
}
