"use client";

// A condition's value picked from the field's values (is, is not, includes, excludes), inline in the condition's
// editor: a search, then the values with how many features of the whole layer hold each (or of the features a given
// filter keeps), a bar behind the count showing its share of the most frequent. The values picked when the editor opened come first, so a pick never moves
// a row under the pointer. The search is sent to the server as a `like` after a pause, the list grows by a page when
// scrolled to its end, and a value that is not listed can be typed and used. The editor mounts only when its row is
// opened, so a closed row asks the server for nothing.
import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Checkbox,
  Divider,
  InputBase,
  MenuList,
  Radio,
  type Theme,
  Typography,
  alpha,
} from "@mui/material";
import { type KeyboardEvent, type Ref, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useLayerUniqueValues } from "@/lib/api/layers";
import { FILTER_LIMITS } from "@/lib/filter/generated/operators";
import type { FieldType } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";

import { MenuRow } from "@/components/common/MenuRow";
import { SEARCH_INPUT } from "@/components/common/SearchableMenu";

/** Values a page of the list holds. */
export const VALUES_PAGE = 50;
/** The pause after the last key before the search is sent. */
export const SEARCH_PAUSE = 250;
/** The characters `like` reads as wildcards: a search with one is not sent. */
export const WILDCARD = /[%_]/;
/** How far from its end a scrolled list asks for the next page. */
export const NEAR_END = 48;

const numeric = (type: FieldType | undefined) => type === "number" || type === "integer";

/** A listed or typed value as the row holds it: a number for a number field, else text; null for no value. */
function valueOf(text: string, type: FieldType | undefined): string | number | null {
  if (!text) return null;
  if (!numeric(type)) return text;
  const n = Number(text.trim());
  return text.trim() && Number.isFinite(n) ? n : null;
}

/** The values a row holds, as a list. */
const pickedOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];

type Value = string | number;

// The mark before a value: a checkbox for several, a radio for one. Hidden from assistive technology: the row is the
// option and says whether it is picked.
const MARK_SX = { p: 0, flex: "none" } as const;
const MARK_INPUT = { "aria-hidden": true, tabIndex: -1 } as const;

const ROW_SX = {
  height: 32,
  minHeight: 32,
  py: 0,
  px: 2,
  gap: 2.5,
  borderRadius: "6px",
  fontWeight: 500,
  "&[aria-selected='true']": { fontWeight: 700 },
} as const;

const COUNT_SX = {
  position: "relative",
  flex: "none",
  minWidth: 48,
  px: 1,
  textAlign: "right",
  typography: "caption",
  color: "text.secondary",
  fontVariantNumeric: "tabular-nums",
} as const;

const BAR_SX = {
  position: "absolute",
  top: 0,
  bottom: 0,
  right: 0,
  borderRadius: "3px",
  bgcolor: (theme: Theme) => alpha(theme.palette.text.primary, 0.08),
} as const;

/** One value of the list. `selected` and `disabled` are also what the list reads to place the keyboard's stop. */
export const ValueRow = memo(function ValueRow({
  value,
  label,
  count,
  share,
  selected,
  disabled,
  multiple,
  onPick,
  ...rest
}: {
  value: Value;
  label: string;
  /** After the label: how many features hold the value. */
  count?: string;
  /** The count against the highest one listed, 0 to 1; no bar without it. */
  share?: number;
  selected: boolean;
  disabled: boolean;
  multiple: boolean;
  onPick: (value: Value) => void;
  // From the list: the keyboard's stop.
  tabIndex?: number;
  autoFocus?: boolean;
}) {
  const mark = multiple ? (
    <Checkbox size="small" checked={selected} disableRipple inputProps={MARK_INPUT} sx={MARK_SX} />
  ) : (
    <Radio size="small" checked={selected} disableRipple inputProps={MARK_INPUT} sx={MARK_SX} />
  );
  return (
    <MenuRow
      {...rest}
      role="option"
      aria-selected={selected}
      disabled={disabled}
      icon={mark}
      label={label}
      trailing={
        count !== undefined && (
          <Box component="span" sx={COUNT_SX}>
            {share !== undefined && (
              <Box component="span" aria-hidden sx={BAR_SX} style={{ width: `${share * 100}%` }} />
            )}
            <Box component="span" sx={{ position: "relative" }}>
              {count}
            </Box>
          </Box>
        )
      }
      sx={ROW_SX}
      onClick={() => onPick(value)}
    />
  );
});

/** A list's search, inline above it. A soft field, not a second frame: the editor is the frame. */
export function ListSearch({
  value,
  onChange,
  label,
  onKeyDown,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  /** The field's name, also shown while it is empty. */
  label: string;
  onKeyDown?: (event: KeyboardEvent) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flex: "none",
        alignItems: "center",
        gap: 2,
        height: 34,
        mx: 2,
        mb: 1.5,
        px: 2.5,
        borderRadius: 2,
        bgcolor: (theme) => alpha(theme.palette.text.primary, 0.06),
        "&:focus-within": {
          bgcolor: "transparent",
          boxShadow: (theme) => `inset 0 0 0 1.5px ${theme.palette.primary.main}`,
        },
      }}>
      <SearchIcon sx={{ fontSize: 16, color: "text.secondary", flex: "none" }} />
      <InputBase
        fullWidth
        value={value}
        placeholder={label}
        inputProps={{ ...SEARCH_INPUT, "aria-label": label, ref: inputRef }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        sx={{ typography: "body2", "& .MuiInputBase-input": { p: 0, height: "auto" } }}
      />
    </Box>
  );
}

export interface ValuePickerProps {
  /** The dataset the values are read from; without it a value can only be typed. */
  layerId?: string;
  field: string;
  type: FieldType | undefined;
  /** Several values (includes, excludes), at most FILTER_LIMITS.values of them. */
  multiple: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The list's name. */
  ariaLabel: string;
  /** Only the features this CQL keeps are listed and counted; the search narrows them further. */
  filter?: JsonObject;
}

const OPTION = "[role='option']";

export const ValuePicker = memo(function ValuePicker({
  layerId,
  field,
  type,
  multiple,
  value,
  onChange,
  ariaLabel,
  filter,
}: ValuePickerProps) {
  const { t, i18n } = useTranslation("common");
  const [search, setSearch] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(search.trim()), SEARCH_PAUSE);
    return () => clearTimeout(timer);
  }, [search]);
  const wildcard = WILDCARD.test(needle);
  const like = needle && !wildcard ? { op: "like", args: [{ property: field }, `%${needle}%`] } : undefined;
  const scoped = like && filter ? { op: "and", args: [filter, like] } : (like ?? filter);
  const query = scoped ? JSON.stringify(scoped) : "";
  // The page shown so far, for the search it belongs to: a new search starts at the first again.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const params = useMemo(
    () => ({ size: VALUES_PAGE, page, order: "descendent" as const, ...(query ? { query } : {}) }),
    [page, query]
  );
  const { data, isLoading } = useLayerUniqueValues(wildcard ? "" : (layerId ?? ""), field, params);
  // The pages loaded, by search and page; the list is the pages of the current search up to the one shown.
  const [pages, setPages] = useState<Record<string, Array<{ value: string; count: number }>>>({});
  useEffect(() => {
    if (!data) return;
    const key = `${query}|${data.page}`;
    setPages((loaded) => (loaded[key] === data.items ? loaded : { ...loaded, [key]: data.items }));
  }, [data, query]);
  const listed = useMemo(() => {
    const out: Array<{ value: Value; count: number }> = [];
    for (let i = 1; i <= page; i += 1)
      for (const item of pages[`${query}|${i}`] ?? []) {
        const v = valueOf(item.value, type);
        if (v !== null) out.push({ value: v, count: item.count });
      }
    return out;
  }, [pages, page, query, type]);
  // Every count seen, of any search: a picked value at the top keeps its count while another search is shown.
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const items of Object.values(pages)) for (const item of items) out.set(item.value, item.count);
    return out;
  }, [pages]);
  // A full page may have more after it; counting the listed values against the total would not end where a page
  // held a value left out (no value at all).
  const hasMore = !wildcard && !!data && data.page === page && data.items.length >= VALUES_PAGE;

  const picked = pickedOf(value);
  const pickedKeys = new Set(picked.map(String));
  const full = multiple && picked.length >= FILTER_LIMITS.values;
  const limitText = t("filter_panel.issue_too_many_values", { limit: FILTER_LIMITS.values });

  // The values picked when the editor opened stay first while it is open, picked or not.
  const [first] = useState(() => picked);

  // The rows' pick never changes, so a pick renders the row it changed and not the others.
  const latest = useRef({ picked, multiple, full, onChange });
  latest.current = { picked, multiple, full, onChange };
  const pick = useCallback((v: Value) => {
    const { picked, multiple, full, onChange } = latest.current;
    if (!multiple) return onChange(v);
    if (picked.some((p) => String(p) === String(v)))
      return onChange(picked.filter((p) => String(p) !== String(v)));
    if (!full) onChange([...picked, v]);
  }, []);

  const listedKeys = new Set(listed.map((item) => String(item.value)));
  // At the top: the values picked at the start, and any picked since that is not on the list (typed, or further
  // down), so it can be taken out. A search narrows them too.
  const lower = needle.toLocaleLowerCase();
  const top: Value[] = [];
  const onTop = new Set<string>();
  const firstKeys = new Set(first.map(String));
  for (const p of [...first, ...picked]) {
    const key = String(p);
    if (onTop.has(key) || (!firstKeys.has(key) && listedKeys.has(key))) continue;
    if (lower && !key.toLocaleLowerCase().includes(lower)) continue;
    onTop.add(key);
    top.push(p as Value);
  }
  const rest = listed.filter((item) => !onTop.has(String(item.value)));
  const typed = valueOf(search.trim(), type);
  const offerTyped =
    typed !== null && !listedKeys.has(String(typed)) && !pickedKeys.has(String(typed)) ? typed : null;

  let max = 0;
  for (const key of onTop) max = Math.max(max, counts.get(key) ?? 0);
  for (const item of rest) max = Math.max(max, item.count);
  const number = (n: number) => n.toLocaleString(i18n.language);

  const row = (v: Value, count: number | undefined) => {
    const key = String(v);
    const on = pickedKeys.has(key);
    return (
      <ValueRow
        key={key}
        value={v}
        label={key}
        count={count === undefined ? undefined : number(count)}
        share={count !== undefined && max > 1 ? count / max : undefined}
        selected={on}
        disabled={full && !on}
        multiple={multiple}
        onPick={pick}
      />
    );
  };

  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const rows = () => Array.from(list.current?.querySelectorAll<HTMLElement>(OPTION) ?? []);
  // In the search: down moves into the rows, Enter takes the typed value, else the first listed value not picked.
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (offerTyped !== null) return pick(offerTyped);
      const next = rest.find((item) => !pickedKeys.has(String(item.value)));
      if (next) pick(next.value);
    }
  };
  // On a row: typing goes on in the search (it filters, it does not jump), up from the first row goes back to it.
  // Space stays with the row, which it picks.
  const onRowKey = (event: KeyboardEvent) => {
    if (event.target === input.current || !(event.target as HTMLElement).closest?.(OPTION)) return;
    const printable =
      event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (printable || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      setSearch(printable ? search + event.key : search.slice(0, -1));
      input.current?.focus();
    } else if (event.key === "ArrowUp" && rows()[0] === event.target) {
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
    }
  };

  const nothing = offerTyped === null && !top.length && !rest.length;
  return (
    // A column whose list alone gives up height when its holder is a shorter flex column (the data table's column
    // filter), so the list scrolls on its own and the lines under it stay in view.
    <Box
      sx={{ px: 1, pt: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      onKeyDownCapture={onRowKey}>
      <ListSearch
        value={search}
        onChange={setSearch}
        label={t("filter_panel.search_values")}
        onKeyDown={onSearchKey}
        inputRef={input}
      />
      {wildcard && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 2, pb: 1 }}>
          {t("filter_panel.wildcard")}
        </Typography>
      )}
      <MenuList
        ref={list}
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable={multiple || undefined}
        disablePadding
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollTop + el.clientHeight < el.scrollHeight - NEAR_END) return;
          if (hasMore && !isLoading) setPaging({ query, page: page + 1 });
        }}
        sx={{
          maxHeight: 252,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
        }}>
        {offerTyped !== null && (
          <MenuRow
            role="option"
            aria-selected={false}
            disabled={full}
            icon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 13, width: 20, flexShrink: 0 }} />}
            label={t("filter_panel.use_value", { value: String(offerTyped) })}
            sx={ROW_SX}
            onClick={() => pick(offerTyped)}
          />
        )}
        {top.map((v) => row(v, counts.get(String(v))))}
        {top.length > 0 && rest.length > 0 && <Divider component="li" sx={{ mx: 2, my: 1 }} />}
        {rest.map((item) => row(item.value, item.count))}
      </MenuList>
      {nothing && layerId && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
          {isLoading ? t("loading") : t("filter_panel.no_values")}
        </Typography>
      )}
      {multiple && (
        <Typography
          variant="caption"
          color={full ? "warning.main" : "text.secondary"}
          sx={{ display: "block", px: 2, pt: 1.5 }}>
          {full ? limitText : t("filter_panel.picked", { count: picked.length, limit: FILTER_LIMITS.values })}
        </Typography>
      )}
    </Box>
  );
});
