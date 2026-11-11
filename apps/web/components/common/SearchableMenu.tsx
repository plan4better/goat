"use client";

// A list to pick from, opened at its control: the app's menu card (popoverSurface, lifted as MUI's menus are) with
// MenuRow rows and MenuHeading headings. A long list has a search row at the top (a field list from SEARCH_FROM_FIELDS
// rows on, a list of fixed choices from SEARCH_FROM_CHOICES), flush with the rows
// and above them (the rows scroll under the divider, never under the search). Down moves from the search into the
// rows, Enter takes the first match, typing on a row goes on in the search. It opens with the chosen row in view,
// closes on a pointer-down outside it, and Escape closes it alone and gives the focus back to its control.
import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Checkbox,
  ClickAwayListener,
  Divider,
  FormControl,
  InputBase,
  MenuList,
  Paper,
  Popper,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ICON_NAME } from "@p4b/ui/components/Icon";
import { POPOVER_GAP, popoverSurface } from "@p4b/ui/theme/popoverSurface";

import { MenuHeading, MenuRow } from "@/components/common/MenuRow";
import { POPOVER_LIST_PADDING, POPOVER_ROW_SX } from "@/components/common/popoverRow";

/** From this many rows on, a list of a layer's fields has a search row: fields are many and unknown in advance. */
export const SEARCH_FROM_FIELDS = 9;
/** From this many rows on, a list of fixed choices (a mode, a method, a position) has one. */
export const SEARCH_FROM_CHOICES = 13;

/** A search box's input attributes: a search, not a form field, so browsers (autofill, one-time codes, spelling) and
 * password managers suggest nothing over the list under it. */
export const SEARCH_INPUT = {
  name: "menu-search",
  autoComplete: "off",
  spellCheck: false,
  autoCorrect: "off",
  autoCapitalize: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;

/** The narrowest a menu is, under a narrow field; it grows with its longest label up to MAX_WIDTH. */
const MIN_WIDTH = 240;
const MAX_WIDTH = 360;

export interface SearchableMenuItem {
  label: string;
  /** A line under the label saying what it does. */
  sub?: ReactNode;
  /** An icon name (drawn muted, at the rows' size) or a glyph of its own (drawn in a fixed-width column). */
  icon?: ICON_NAME | ReactNode;
  /** A CSS background for a swatch before the label. */
  swatch?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Why a disabled row is, on hover. */
  tooltip?: string;
  /** A heading row, not selectable. */
  heading?: boolean;
  /** Matched by the search besides the label (a field's name under its display name). */
  keywords?: string;
  onClick?: () => void;
}

export type MenuPlacement = "bottom-start" | "bottom-end";

export interface SearchableMenuProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** The rows, or the rows matching a search (the caller filters; '' for all). */
  items: SearchableMenuItem[] | ((needle: string) => SearchableMenuItem[]);
  title?: string;
  /** A line under the rows saying what the menu is for. */
  hint?: string;
  /** "menu" for actions and modes, "listbox" for the value of a field (its options). */
  role?: "menu" | "listbox";
  /** Several values: each row has a checkbox and a pick keeps the menu open. */
  multiple?: boolean;
  /** Under the search, above the rows (a multiple pick's "Select all"). */
  header?: ReactNode;
  /** At least this wide (240 px by default), and at least as wide as its control. */
  width?: number;
  /** Under the control, its start or its end aligned. */
  placement?: MenuPlacement;
  searchLabel?: string;
  /** Shown when the search matches nothing. */
  emptyText?: string;
  /** The search row from this many rows on. */
  searchFrom?: number;
  /** The element focused when the menu closes by keyboard (the control's own focusable part). */
  focusOnClose?: HTMLElement | null;
}

const matches = (item: SearchableMenuItem, needle: string) =>
  item.label.toLocaleLowerCase().includes(needle) || !!item.keywords?.toLocaleLowerCase().includes(needle);

/** A row's own glyph beside its label (a field's kind, a line's dash): muted, in a column of one width so the labels
 * of every row start at one place. */
export function MenuGlyph({ children, twoLines }: { children: ReactNode; twoLines?: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        flex: "none",
        color: "text.secondary",
        "& svg": { fontSize: 14 },
        ...(twoLines ? { mt: "1px" } : {}),
      }}>
      {children}
    </Box>
  );
}

const ROW = "[role='menuitem'], [role='option']";

export default function SearchableMenu({
  anchorEl,
  onClose,
  items,
  title,
  hint,
  role = "menu",
  multiple = false,
  header,
  width = MIN_WIDTH,
  placement = role === "listbox" ? "bottom-start" : "bottom-end",
  searchLabel,
  emptyText,
  searchFrom = SEARCH_FROM_CHOICES,
  focusOnClose,
}: SearchableMenuProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [search, setSearch] = useState("");
  const list = useRef<HTMLUListElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => setSearch(""), [anchorEl]);
  // Opens with the chosen row in the middle of the list: once the list is on the page (the popper draws its content a
  // moment after it opens), scrolled within the list only.
  const scrolledFor = useRef<HTMLElement | null>(null);
  const listRef = useCallback(
    (el: HTMLUListElement | null) => {
      list.current = el;
      if (!el || scrolledFor.current === anchorEl) return;
      scrolledFor.current = anchorEl;
      requestAnimationFrame(() => {
        const chosen = el.querySelector<HTMLElement>("[aria-selected='true'], .Mui-selected");
        if (!chosen) return;
        // Measured against the list itself: its offsetParent is the card, above which sits the search row.
        const top = chosen.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        el.scrollTop = top - el.clientHeight / 2 + chosen.offsetHeight / 2;
      });
    },
    [anchorEl]
  );
  if (!anchorEl) return null;
  // A control in an outlined field (a select, the panel's field buttons) aligns the menu with the whole field.
  const box = (anchorEl.closest(".MuiInputBase-root") as HTMLElement | null) ?? anchorEl;
  const all = typeof items === "function" ? items("") : items;
  const searchable = all.filter((item) => !item.heading).length >= searchFrom;
  const needle = search.trim().toLocaleLowerCase();
  // While searching, the matching rows only (headings drop out unless the caller keeps them).
  const shown = !needle
    ? all
    : typeof items === "function"
      ? items(needle)
      : all.filter((item) => !item.heading && matches(item, needle));
  const giveBack = () => (focusOnClose ?? anchorEl).focus();
  const close = () => {
    onClose();
    giveBack();
  };
  const pick = (item: SearchableMenuItem) => {
    if (item.disabled) return;
    item.onClick?.();
    if (!multiple) close();
  };
  const rows = () => Array.from(list.current?.querySelectorAll<HTMLElement>(ROW) ?? []);
  // In the search: down moves into the rows, Enter takes the first match.
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = shown.find((item) => !item.heading && !item.disabled);
      if (first) pick(first);
    }
  };
  // On a row: typing goes on in the search (a menu with a search filters, it does not jump), up from the first row
  // goes back to it.
  const onRowKey = (event: KeyboardEvent) => {
    if (!searchable || event.target === input.current) return;
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (printable || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      setSearch((text) => (printable ? text + event.key : text.slice(0, -1)));
      input.current?.focus();
    } else if (event.key === "ArrowUp" && rows()[0] === event.target) {
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
    }
  };
  const rowOf = (item: SearchableMenuItem, i: number) => {
    const twoLines = !!item.sub;
    const glyph = item.swatch ? (
      <MenuGlyph twoLines={twoLines}>
        <Box
          component="span"
          sx={{
            width: 16,
            height: 16,
            borderRadius: "4px",
            boxShadow: `inset 0 0 0 1px ${theme.palette.divider}`,
            background: item.swatch,
          }}
        />
      </MenuGlyph>
    ) : typeof item.icon === "string" || !item.icon ? (
      (item.icon as ICON_NAME | undefined)
    ) : (
      <MenuGlyph twoLines={twoLines}>{item.icon}</MenuGlyph>
    );
    const row = (
      <MenuRow
        key={`${item.label}-${i}`}
        role={role === "listbox" ? "option" : "menuitem"}
        aria-selected={role === "listbox" ? !!item.selected : undefined}
        // A multiple pick shows its checkbox, not a check.
        selected={multiple ? false : item.selected}
        disabled={item.disabled}
        icon={
          multiple ? (
            <>
              <Checkbox size="small" checked={!!item.selected} tabIndex={-1} sx={{ p: 0, mr: "-3px" }} />
              {glyph}
            </>
          ) : (
            glyph
          )
        }
        label={item.label}
        secondary={item.sub}
        // Long labels wrap: two options that differ only at their end stay apart.
        sx={{ whiteSpace: "normal" }}
        onClick={() => pick(item)}
      />
    );
    // A disabled row takes no pointer events: the tooltip listens on a wrapper.
    return item.tooltip ? (
      <Tooltip key={`${item.label}-${i}`} title={item.tooltip} placement="right" arrow>
        <span style={{ display: "block" }}>{row}</span>
      </Tooltip>
    ) : (
      row
    );
  };
  return (
    <Popper
      open
      anchorEl={box}
      placement={placement}
      modifiers={[
        { name: "offset", options: { offset: [0, POPOVER_GAP] } },
        { name: "preventOverflow", options: { padding: 12 } },
      ]}
      sx={{ zIndex: 1400 }}>
      {/* A press on the control is left to it, which closes the menu: closing here too would reopen it. */}
      <ClickAwayListener
        mouseEvent="onPointerDown"
        touchEvent={false}
        onClickAway={(event) => {
          if (event.target instanceof Node && box.contains(event.target)) return;
          onClose();
        }}>
        {/* Lifted as MUI's menus are (their elevation), on the app's card: it reads above the panel under it. */}
        <Paper
          elevation={8}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
          sx={{
            ...popoverSurface(theme),
            // At least as wide as its control (and `width`), growing with its longest label up to MAX_WIDTH, where
            // labels wrap. The border is inside the width.
            boxSizing: "border-box",
            minWidth: Math.max(width, box.offsetWidth),
            width: "max-content",
            maxWidth: Math.max(MAX_WIDTH, box.offsetWidth),
            maxHeight: 360,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
          onKeyDownCapture={onRowKey}>
          {title && (
            <Box sx={{ px: POPOVER_LIST_PADDING, pt: POPOVER_LIST_PADDING, flex: "none" }}>
              <MenuHeading>{title}</MenuHeading>
            </Box>
          )}
          {searchable && (
            <>
              {/* A row of the list: its icon in the glyph column, its text where the labels start, one row high. */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: POPOVER_ROW_SX.gap,
                  // The rows' inset: the list's padding and the row's own.
                  px: "16px",
                  // A row's height (MenuRow: 9 px above and below its line), inset from the card's top as the
                  // last row is from its bottom (the list's padding).
                  py: "9px",
                  mt: title ? 0 : POPOVER_LIST_PADDING,
                  flex: "none",
                }}>
                <MenuGlyph>
                  <SearchIcon sx={{ fontSize: "16px !important" }} />
                </MenuGlyph>
                {/* Its own form control: a menu opened from a form field would otherwise count as its second input. */}
                <FormControl fullWidth>
                  <InputBase
                    autoFocus
                    fullWidth
                    value={search}
                    placeholder={searchLabel ?? t("search_placeholder_short")}
                    inputProps={{
                      ...SEARCH_INPUT,
                      "aria-label": searchLabel ?? t("search_placeholder_short"),
                      ref: input,
                    }}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={onSearchKey}
                    sx={{
                      fontSize: POPOVER_ROW_SX.fontSize,
                      lineHeight: 1.5,
                      "& .MuiInputBase-input": { p: 0, height: "auto", lineHeight: 1.5 },
                    }}
                  />
                </FormControl>
              </Box>
              {/* Directly under the search: the theme's dividers keep a margin around them. */}
              <Divider sx={{ my: 0 }} />
            </>
          )}
          {header}
          <MenuList
            ref={listRef}
            role={role}
            disablePadding
            autoFocusItem={!searchable}
            sx={{
              p: POPOVER_LIST_PADDING,
              overflowY: "auto",
              overflowX: "hidden",
              minHeight: 0,
              flex: "1 1 auto",
            }}>
            {shown.map((item, i) =>
              item.heading ? <MenuHeading key={`h-${i}`}>{item.label}</MenuHeading> : rowOf(item, i)
            )}
            {needle && !shown.some((item) => !item.heading) && (
              <Typography
                component="li"
                role="presentation"
                sx={{ p: POPOVER_ROW_SX.p, fontSize: POPOVER_ROW_SX.fontSize, color: "text.secondary" }}>
                {emptyText ?? t("no_results")}
              </Typography>
            )}
          </MenuList>
          {hint && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", px: "16px", pb: 2, flex: "none" }}>
              {hint}
            </Typography>
          )}
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}
