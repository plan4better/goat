"use client";

// The number format of a label (level 2; spec 18.3, prototype 4.12): decimals, thousands separator, abbreviation,
// sign, prefix and suffix. Only what differs from the defaults is written; an empty format removes the key, so the
// field's own format from the dataset applies again.
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import type { NumberFormatSpec } from "@/lib/style/compile/labels";
import { formatNumberText } from "@/lib/style/editor/labels";
import type { Path } from "@/lib/style/editor/store";

import { useEditor, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ChoiceRow, SwitchRow, TextRow } from "@/components/map/panels/styleEditor/rows";

const DECIMALS = ["auto", "0", "1", "2", "3", "4", "5"];
/** The number the format's preview shows. */
export const PREVIEW_NUMBER = 12345.678;

const DEFAULT_FORMAT: Required<Omit<NumberFormatSpec, "prefix" | "suffix">> = {
  decimals: "auto",
  thousands_separator: true,
  abbreviate: false,
  always_show_sign: false,
};

/** The format without the keys at their defaults; undefined when nothing is left. */
function minimal(format: NumberFormatSpec): NumberFormatSpec | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(format)) {
    if (value === undefined || value === "" || DEFAULT_FORMAT[key as keyof typeof DEFAULT_FORMAT] === value)
      continue;
    out[key] = value;
  }
  return Object.keys(out).length ? (out as NumberFormatSpec) : undefined;
}

export function NumberFormatEditor({ path }: { path: Path }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const format = (useStyleValue<NumberFormatSpec | undefined>(path) ?? {}) as NumberFormatSpec;
  const write = (patch: Partial<NumberFormatSpec>) => store.set(path, minimal({ ...format, ...patch }));
  const decimals = String(format.decimals ?? "auto");
  const values = DECIMALS.includes(decimals) ? DECIMALS : [...DECIMALS, decimals];
  const label = t("style_editor.decimals");
  return (
    <>
      <ChoiceRow<string>
        label={label}
        value={decimals}
        options={values.map((v) => ({ value: v, label: v === "auto" ? t("style_editor.auto") : v }))}
        onChange={(v) => write({ decimals: v === "auto" ? "auto" : Number(v) })}
      />
      <SwitchRow
        label={t("style_editor.thousands")}
        note={t("style_editor.note_thousands")}
        on={format.thousands_separator !== false}
        onToggle={() => write({ thousands_separator: format.thousands_separator === false })}
      />
      <SwitchRow
        label={t("style_editor.abbreviate")}
        note={t("style_editor.note_abbreviate")}
        on={format.abbreviate === true}
        onToggle={() => write({ abbreviate: format.abbreviate !== true })}
      />
      <SwitchRow
        label={t("style_editor.sign")}
        note={t("style_editor.note_sign")}
        on={format.always_show_sign === true}
        onToggle={() => write({ always_show_sign: format.always_show_sign !== true })}
      />
      <TextRow
        label={t("style_editor.prefix")}
        placeholder={t("style_editor.prefix_placeholder")}
        value={format.prefix ?? ""}
        onChange={(prefix) => write({ prefix })}
      />
      <TextRow
        label={t("style_editor.suffix")}
        placeholder={t("style_editor.suffix_placeholder")}
        value={format.suffix ?? ""}
        onChange={(suffix) => write({ suffix })}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pt: 2 }}>
        {t("style_editor.format_hint", { preview: formatNumberText(PREVIEW_NUMBER, format, i18n.language) })}
      </Typography>
    </>
  );
}
