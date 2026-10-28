"use client";

// The values of a category class, picked by hand: the class's name, its values ticked, then the field's other values,
// most frequent first, each with its feature count and the class it is in now. Ticking a value of another class moves
// it here; unticking leaves it in no class. The search asks the server across all values of the field.
import { Box, Checkbox, InputBase, MenuItem, MenuList, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUniqueValues } from "@/lib/api/processes";
import { categoryValue, moveCategoryValue } from "@/lib/style/editor/classify";
import { targetsOf } from "@/lib/style/editor/forms";
import { formatNumberText } from "@/lib/style/editor/labels";
import { getIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { TextRow } from "@/components/map/panels/styleEditor/rows";

/** The values the list starts with: the most frequent ones, as the classification editor loads them. */
export const VALUES_LIMIT = 100;
const SHOWN = 50;
const SEARCH_DELAY_MS = 300;

/** Where `classify.<id>.classes.<id>` is now: classes move and go while the picker is open. */
function locate(all: unknown, ci: number, cid?: string, kid?: string, k?: number): [number, number] {
  const list = Array.isArray(all) ? all : [];
  const at = cid === undefined ? ci : list.findIndex((c) => isObject(c) && c.id === cid);
  const c = list[at];
  const classes = isObject(c) && Array.isArray(c.classes) ? c.classes : [];
  const kAt = kid === undefined ? (k ?? -1) : classes.findIndex((r) => isObject(r) && r.id === kid);
  return [at, kAt];
}

const text = (v: unknown) => String(v);

export function ClassValues({
  ci: openedCi,
  k: openedK,
  classificationId,
  classId,
}: {
  ci: number;
  k: number;
  classificationId?: string;
  classId?: string;
}) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const all = useStyleValue<unknown>("classify");
  const [ci, k] = locate(all, openedCi, classificationId, classId, openedK);
  const c = (Array.isArray(all) && isObject(all[ci]) ? all[ci] : {}) as JsonObject;
  const classes = (Array.isArray(c.classes) ? c.classes : []).filter(isObject);
  const record = classes[k];
  const field = typeof c.field === "string" ? c.field : "";
  const fieldType = data.fieldTypes[field];
  const layerId = data.layerId || undefined;
  const number = (n: number) => formatNumberText(n, {}, i18n.language);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const { data: top } = useUniqueValues(layerId, field, { limit: VALUES_LIMIT });
  const { data: found } = useUniqueValues(query ? layerId : undefined, field, {
    limit: SHOWN,
    filter: JSON.stringify({ op: "like", args: [{ property: field }, `%${query}%`] }),
  });
  if (!record) return null;

  const counts = new Map<string, number>();
  for (const v of [...(top?.values ?? []), ...(found?.values ?? [])])
    if (v.value !== null) counts.set(text(v.value), v.count);
  const owner = new Map<string, number>();
  classes.forEach((r, i) => (Array.isArray(r.values) ? r.values : []).forEach((v) => owner.set(text(v), i)));
  const needle = query.toLocaleLowerCase();
  // A search narrows the class's own values too.
  const own = (Array.isArray(record.values) ? record.values : [])
    .map(text)
    .filter((v) => !needle || v.toLocaleLowerCase().includes(needle));
  const source = (query ? found?.values : top?.values) ?? [];
  const others = source
    .filter((v) => v.value !== null && owner.get(text(v.value)) !== k)
    .slice(0, SHOWN)
    .map((v) => text(v.value));
  const total = top?.total ?? 0;
  const target = targetsOf(c, data.geometry)[0];
  const color = (i: number) => {
    const value = getIn(classes[i], target);
    return typeof value === "string" && value.startsWith("#") ? value : undefined;
  };
  const className = (i: number) => {
    const name = classes[i]?.name;
    return typeof name === "string" && name ? name : t("style_editor.class_n", { n: i + 1 });
  };
  const toggle = (value: string, on: boolean) =>
    store.update((doc) => moveCategoryValue(doc, ci, categoryValue(value, fieldType), on ? null : k));

  const item = (value: string, on: boolean) => {
    const at = owner.get(value);
    const elsewhere = at !== undefined && at !== k;
    const dot = elsewhere ? color(at) : undefined;
    const where = elsewhere
      ? t("style_editor.value_in_class", { name: className(at) })
      : on
        ? undefined
        : t("style_editor.value_in_no_class");
    const count = counts.get(value);
    return (
      <MenuItem key={value} title={where} onClick={() => toggle(value, on)} sx={{ gap: 1.5 }}>
        <Checkbox size="small" checked={on} tabIndex={-1} disableRipple sx={{ p: 0 }} />
        <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {value}
        </Typography>
        {elsewhere &&
          (dot ? (
            <Box
              component="span"
              aria-label={where}
              sx={{ width: 10, height: 10, flex: "none", borderRadius: "50%", bgcolor: dot }}
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              {at + 1}
            </Typography>
          ))}
        {count !== undefined && (
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {number(count)}
          </Typography>
        )}
      </MenuItem>
    );
  };

  const note = (label: string) => (
    <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 3, py: 0.5 }}>
      {label}
    </Typography>
  );

  const heading = (label: string) => (
    <Typography
      variant="caption"
      color="text.secondary"
      component="p"
      sx={{ px: 3, pt: 2, pb: 0.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
      {label}
    </Typography>
  );

  return (
    <Box>
      <TextRow
        label={t("style_editor.class_name")}
        value={typeof record.name === "string" ? record.name : ""}
        placeholder={own.join(", ") || t("style_editor.class_n", { n: k + 1 })}
        onChange={(v) => store.set(`classify.${ci}.classes.${k}.name`, v || undefined)}
      />
      <InputBase
        value={search}
        autoFocus
        placeholder={t("style_editor.search_values", { total: number(total) })}
        inputProps={{ "aria-label": t("style_editor.search_values", { total: number(total) }) }}
        onChange={(event) => setSearch(event.target.value)}
        sx={{ px: 3, py: 1, width: "100%", typography: "body2" }}
      />
      <MenuList dense sx={{ maxHeight: 360, overflowY: "auto", py: 0 }}>
        {heading(`${t("style_editor.in_this_class")} · ${own.length}`)}
        {own.map((v) => item(v, true))}
        {!own.length && !query && note(t("style_editor.no_values_yet"))}
        {heading(query ? t("style_editor.value_matches") : t("style_editor.more_values"))}
        {others.map((v) => item(v, false))}
        {!others.length && query && found && note(t("style_editor.no_other_matches"))}
      </MenuList>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 3, pt: 1.5 }}>
        {query
          ? t("style_editor.values_search_note")
          : total > SHOWN
            ? t("style_editor.values_most_frequent", { shown: SHOWN, total: number(total) })
            : t("style_editor.values_all", { total: number(total) })}
      </Typography>
    </Box>
  );
}
