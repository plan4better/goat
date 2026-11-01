"use client";

import { Box, Paper, Typography, useTheme } from "@mui/material";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { assistantErrorKey } from "@/lib/assistant/errors";
import { startConversation } from "@/lib/assistant/startConversation";
import { useDockState } from "@/lib/assistant/store";

import {
  MIN_QUERY_LENGTH,
  type SearchRow,
  parseScope,
  useHomeSearch,
} from "@/hooks/dashboard/home/useHomeSearch";

import ShortcutHint from "@/components/common/ShortcutHint";
import HighlightedText from "@/components/dashboard/common/HighlightedText";
import SearchInput from "@/components/dashboard/common/SearchInput";

/** The layer preview drags the map stack along with it, so Home loads it
 * only once a layer is actually picked. */
const ContentPreviewDialog = dynamic(() => import("@/components/dashboard/content/ContentPreviewDialog"), {
  ssr: false,
});

/** A bundle's preview carries a map of every member, so it is loaded the same
 * way and for the same reason. */
const BundlePreviewDialog = dynamic(() => import("@/components/dashboard/bundle/BundlePreviewDialog"), {
  ssr: false,
});

/** How long focus is held after a blur before the results close — long
 * enough that a `mousedown`→`click` on a row still lands before it. */
const BLUR_DELAY_MS = 120;

/** A scope prefix offered for the empty query. Selecting one types it. */
type TipRow = { kind: "tip"; id: string; icon: ICON_NAME; prefix: string; hintKey: string };

const TIPS: TipRow[] = [
  { kind: "tip", id: "project", icon: ICON_NAME.MAP, prefix: "project:", hintKey: "search_scope_projects" },
  {
    kind: "tip",
    id: "dataset",
    icon: ICON_NAME.LAYERS,
    prefix: "dataset:",
    hintKey: "search_scope_datasets",
  },
  {
    kind: "tip",
    id: "catalog",
    icon: ICON_NAME.GLOBE,
    prefix: "catalog:",
    hintKey: "search_scope_catalog",
  },
];

/** Offered only where the assistant is available, like the header's "Ask AI". */
const ASK_TIP: TipRow = {
  kind: "tip",
  id: "ask",
  icon: ICON_NAME.SPARKLES,
  prefix: "ask:",
  hintKey: "assistant_ask_ai",
};

/** The question after a leading `ask:`, or null when the field does not open with it. */
export const parseAsk = (raw: string): string | null => {
  const trimmed = raw.trimStart();
  return trimmed.toLowerCase().startsWith(ASK_TIP.prefix)
    ? trimmed.slice(ASK_TIP.prefix.length).trim()
    : null;
};

/** Starts a conversation in the assistant dock with the query as its first message. */
type AskRow = { kind: "ask"; id: "ask"; question: string };

type DisplayRow = SearchRow | TipRow | AskRow;
type SelectableRow = Extract<DisplayRow, { kind: "item" } | { kind: "tip" } | { kind: "ask" }>;
const isSelectable = (row: DisplayRow): row is SelectableRow =>
  row.kind === "item" || row.kind === "tip" || row.kind === "ask";

/**
 * The hero search (H3): one field the user just types into, fanning out to the
 * content feed and the catalog through `useHomeSearch` and showing what each
 * store answered as its own group. A leading `project:` / `dataset:` /
 * `catalog:` narrows the fan-out to one store. Ctrl/Cmd+K focuses the field
 * from anywhere on the page; ↑/↓ walk the selectable rows (wrapping), Enter
 * runs the highlighted row, Esc clears the query and blurs.
 *
 * Where the assistant is available, a query also offers "Ask AI" as the last
 * group (Tab picks it from anywhere in the list), and `ask:` narrows the list
 * to that row alone.
 */
const HomeSearch = () => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  /** The arrow keys moved the highlight: the list scrolls it into view (Ask AI is last, often below). */
  const keyboardMove = useRef(false);

  // The same gate as the header's "Ask AI": without it the palette has no trace of the assistant.
  const askEnabled = useDockState().enabled;
  // `ask:` puts nothing to the stores: the hook gets an empty query and its rows are not shown.
  const askScoped = askEnabled ? parseAsk(value) : null;
  const { rows, previewLayerId, previewBundleId, closePreview } = useHomeSearch(
    askScoped === null ? value : ""
  );
  const { scope, query } = parseScope(value);
  const question = askScoped ?? (scope === "all" ? query : "");
  const showAsk = askEnabled && question.length > 0;
  // A prefix with nothing worth searching after it yet. The hook answers that
  // state with the scoped group and its prompt; the tips stay up so the user
  // can swap prefixes without clearing the field first.
  const isPrefixOnly =
    askScoped !== null ? askScoped.length === 0 : scope !== "all" && query.length < MIN_QUERY_LENGTH;
  const showTips = isPrefixOnly || value.trim().length === 0;
  const tips = askEnabled ? [...TIPS, ASK_TIP] : TIPS;
  const tipsHead: SearchRow = { kind: "head", label: t("search_tips") };
  const askHead: SearchRow = { kind: "head", label: t("assistant_ask_ai") };
  const searchRows: DisplayRow[] =
    askScoped === null
      ? rows
      : isPrefixOnly
        ? [askHead, { kind: "note", label: t("search_type_to_ask_ai") }]
        : [];
  const noResults = askScoped === null && query.length >= MIN_QUERY_LENGTH && !searchRows.some(isSelectable);
  const displayRows: DisplayRow[] = [
    ...(noResults ? [] : searchRows),
    ...(showTips ? [tipsHead, ...tips] : []),
    ...(showAsk ? [askHead, { kind: "ask", id: "ask", question } satisfies AskRow] : []),
  ];
  const selectable = displayRows.filter(isSelectable);

  // The prefix already in the field is the one the tips group opens on, so the
  // state the user is in is the row that reads as chosen.
  const activeTipId = !isPrefixOnly ? null : askScoped !== null ? ASK_TIP.id : scope;
  const activeTip = selectable.findIndex((row) => row.kind === "tip" && row.id === activeTipId);
  const defaultHighlight = Math.max(activeTip, 0);

  useEffect(() => {
    setHighlight(defaultHighlight);
  }, [displayRows.length, defaultHighlight]);

  useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    listRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    []
  );

  const handleFocus = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setFocused(true);
  };

  const handleBlur = () => {
    blurTimer.current = setTimeout(() => setFocused(false), BLUR_DELAY_MS);
  };

  /** The dock opens on a new conversation that sends the question; an error stays on this page. */
  const ask = (text: string) => {
    setValue("");
    startConversation(text, { origin: "home", context: null }).catch((error: unknown) => {
      toast.error(t(assistantErrorKey(error)));
    });
  };

  /** Typing a tip rather than following it: the field keeps the caret so the
   * user carries straight on with the term they came to search for. */
  const activate = (row: SelectableRow) => {
    if (row.kind === "tip") {
      setValue(`${row.prefix} `);
      inputRef.current?.focus();
      return;
    }
    if (row.kind === "ask") ask(row.question);
    else row.go();
    setFocused(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      keyboardMove.current = true;
      if (selectable.length) setHighlight((current) => (current + 1) % selectable.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      keyboardMove.current = true;
      if (selectable.length) setHighlight((current) => (current - 1 + selectable.length) % selectable.length);
    } else if (event.key === "Enter") {
      const row = selectable[highlight];
      if (row) activate(row);
    } else if (event.key === "Tab" && !event.shiftKey && showAsk) {
      // Tab asks AI whichever row is highlighted; Shift+Tab still leaves the field.
      event.preventDefault();
      activate({ kind: "ask", id: "ask", question });
    } else if (event.key === "Escape") {
      setValue("");
      inputRef.current?.blur();
    }
  };

  const placeholder = t("search_placeholder_short");

  let rowIndex = -1;

  return (
    <Box sx={{ position: "relative" }}>
      {previewLayerId && <ContentPreviewDialog layerId={previewLayerId} onClose={closePreview} />}
      {previewBundleId && <BundlePreviewDialog bundleId={previewBundleId} onClose={closePreview} />}
      <SearchInput
        ref={inputRef}
        size="hero"
        value={value}
        onChange={setValue}
        onClear={() => {
          setValue("");
          inputRef.current?.focus();
        }}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        fullWidth
        endAdornment={<ShortcutHint letter="K" />}
      />

      {focused && (
        <Paper
          elevation={6}
          sx={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            right: 0,
            zIndex: theme.zIndex.appBar + 1,
            borderRadius: "12px",
            overflow: "hidden",
          }}>
          <Box ref={listRef} sx={{ py: "8px", maxHeight: 360, overflowY: "auto" }}>
            {noResults && (
              <Typography
                sx={{ px: "16px", py: "10px", fontSize: 13.5, color: theme.palette.text.secondary }}>
                {t("no_results_for", { q: query })}
              </Typography>
            )}
            {displayRows.map((row, index) => {
              if (row.kind === "head") {
                // The same group-header grammar the map's search results use
                // (SearchResultsList): a bold caption in the secondary colour.
                return (
                  <Typography
                    key={`head-${index}`}
                    variant="caption"
                    role="presentation"
                    noWrap
                    sx={{
                      display: "block",
                      px: "16px",
                      pt: index === 0 && !noResults ? "6px" : "12px",
                      pb: "6px",
                      fontSize: 12.5,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                      color: theme.palette.text.secondary,
                    }}>
                    {row.label}
                  </Typography>
                );
              }

              if (row.kind === "note") {
                return (
                  <Typography
                    key={`note-${index}`}
                    role="presentation"
                    sx={{
                      px: "16px",
                      py: "8px",
                      fontSize: 13.5,
                      color: theme.palette.text.secondary,
                    }}>
                    {row.label}
                  </Typography>
                );
              }

              rowIndex += 1;
              const optionIndex = rowIndex;
              const highlighted = optionIndex === highlight;
              return (
                <Box
                  key={`${row.kind}-${row.id}`}
                  role="option"
                  aria-selected={highlighted}
                  onMouseEnter={() => setHighlight(optionIndex)}
                  onClick={() => activate(row)}
                  sx={{
                    mx: "8px",
                    px: "8px",
                    minHeight: 44,
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    cursor: "pointer",
                    borderRadius: "10px",
                    bgcolor: highlighted ? theme.palette.action.hover : "transparent",
                  }}>
                  <Icon
                    iconName={row.kind === "ask" ? ICON_NAME.SPARKLES : row.icon}
                    style={{
                      fontSize: 15,
                      color: row.kind === "ask" ? theme.palette.primary.main : theme.palette.text.secondary,
                    }}
                  />
                  {row.kind === "ask" ? (
                    <Box sx={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: "6px" }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 500, flexShrink: 0 }} noWrap>
                        {t("assistant_ask_ai")}
                      </Typography>
                      <Typography sx={{ fontSize: 13, color: theme.palette.text.secondary }} noWrap>
                        {t("search_quoted_query", {
                          q: row.question,
                          // React escapes the query; i18next must not as well.
                          interpolation: { escapeValue: false },
                        })}
                      </Typography>
                    </Box>
                  ) : row.kind === "tip" ? (
                    <Box sx={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: "6px" }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 500 }} noWrap>
                        {row.prefix}
                      </Typography>
                      <Typography sx={{ fontSize: 13, color: theme.palette.text.secondary }} noWrap>
                        — {t(row.hintKey)}
                      </Typography>
                    </Box>
                  ) : (
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 500 }} noWrap>
                        <HighlightedText text={row.label} query={query} />
                      </Typography>
                      {row.meta && (
                        <Typography sx={{ fontSize: 12, color: theme.palette.text.secondary }} noWrap>
                          {row.meta}
                        </Typography>
                      )}
                    </Box>
                  )}
                  {highlighted && (
                    <Icon
                      iconName={ICON_NAME.CHEVRON_RIGHT}
                      style={{ fontSize: 12, color: theme.palette.text.secondary }}
                    />
                  )}
                </Box>
              );
            })}
          </Box>

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              px: "16px",
              py: "8px",
              borderTop: `1px solid ${theme.palette.divider}`,
              backgroundColor: theme.palette.action.hover,
            }}>
            <KeyboardHint keys={["↑", "↓"]} label={t("kbd_to_navigate")} />
            <KeyboardHint keys={["↵"]} label={t("kbd_to_select")} />
            <KeyboardHint keys={["esc"]} label={t("kbd_to_close")} />
            {askEnabled && <KeyboardHint keys={["Tab"]} label={t("kbd_to_ask_ai")} />}
          </Box>
        </Paper>
      )}
    </Box>
  );
};

/** One footer hint: the key caps, then what they do. */
const KeyboardHint = ({ keys, label }: { keys: string[]; label: string }) => {
  const theme = useTheme();
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: "4px" }}>
      {keys.map((key) => (
        <Box
          key={key}
          component="kbd"
          sx={{
            fontFamily: "inherit",
            fontSize: 11,
            lineHeight: 1.4,
            color: theme.palette.text.secondary,
            border: `1px solid ${theme.palette.divider}`,
            backgroundColor: theme.palette.background.paper,
            borderRadius: "4px",
            px: "5px",
          }}>
          {key}
        </Box>
      ))}
      <Typography sx={{ fontSize: 11.5, color: theme.palette.text.secondary }}>{label}</Typography>
    </Box>
  );
};

export default HomeSearch;
