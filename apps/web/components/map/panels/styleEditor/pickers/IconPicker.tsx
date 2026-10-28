"use client";

// The icon picker: GOAT's symbols (the marker shapes and pins among them), emoji and the user's own icons in tabs, each
// with its search. Reads and writes icon references (spec 1); the Icon editor's switch takes the icon off.
import { Box, Tab, Tabs } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultResolveIcon } from "@/lib/style/compile/images";
import { ICON_GROUPS } from "@/lib/style/generated/catalog";

import { CustomIconPane } from "@/components/map/panels/styleEditor/pickers/CustomIconPane";
import { EmojiPane } from "@/components/map/panels/styleEditor/pickers/EmojiPane";
import { SymbolGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import { iconLabel, loadEmoji, useSymbols } from "@/components/map/panels/styleEditor/pickers/iconRefs";
import {
  IconTile,
  PANE_HEIGHT,
  PANE_LIST,
  PaneEmpty,
  PaneHeading,
  PaneSearch,
  TileGrid,
  usePaneGroups,
} from "@/components/map/panels/styleEditor/pickers/iconTiles";

type IconTab = "symbols" | "emoji" | "custom";

const tabOf = (ref: string | undefined): IconTab =>
  ref?.startsWith("emoji:") ? "emoji" : ref?.startsWith("asset:") ? "custom" : "symbols";

function SymbolsPane({ value, onPick }: { value?: string; onPick: (ref: string) => void }) {
  const { t } = useTranslation("common");
  const [query, setQuery] = useState("");
  // All tiles from one file; one image per icon only when that file does not load.
  const symbols = useSymbols();
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ICON_GROUPS.map((group) => ({
      ...group,
      icons: group.icons.filter(
        (name) =>
          !q ||
          name.replace(/[-_]+/g, " ").toLowerCase().includes(q) ||
          t(group.labelKey).toLowerCase().includes(q)
      ),
    })).filter((group) => group.icons.length);
  }, [query, t]);
  // The list opens on the selected symbol.
  const reveal = useMemo(() => {
    const name = value?.startsWith("goat:") ? value.slice("goat:".length) : undefined;
    const group = name ? groups.find((g) => g.icons.includes(name)) : undefined;
    return group && name ? { id: group.id, index: group.icons.indexOf(name) } : null;
  }, [groups, value]);
  const pane = usePaneGroups(
    useMemo(() => groups.map((group) => group.id), [groups]),
    reveal
  );
  const current = groups.find((group) => group.id === pane.current);
  return (
    <>
      <PaneSearch label={t("style_editor.icon_search")} value={query} onChange={setQuery} />
      {current && (
        <Box sx={{ px: 3 }}>
          <PaneHeading>{t(current.labelKey)}</PaneHeading>
        </Box>
      )}
      <Box
        ref={pane.list}
        onScroll={pane.onScroll}
        data-pane-list
        sx={{ ...PANE_LIST, position: "relative", px: 3, pb: 2 }}>
        {groups.map((group, i) => {
          const [first, last] = pane.rows(group.id);
          return (
            <Box key={group.id} ref={pane.ref(group.id)}>
              {i > 0 && <PaneHeading>{t(group.labelKey)}</PaneHeading>}
              <TileGrid count={group.icons.length} cols={pane.cols} first={first}>
                {group.icons.slice(first * pane.cols, last * pane.cols).map((name) => {
                  const ref = `goat:${name}`;
                  const symbol = symbols?.get(name);
                  const url = symbols === null ? defaultResolveIcon(ref)?.url : undefined;
                  return (
                    <IconTile
                      key={name}
                      label={iconLabel(ref, [])}
                      selected={value === ref}
                      onClick={() => onPick(ref)}>
                      <SymbolGlyph symbol={symbol} url={url} />
                    </IconTile>
                  );
                })}
              </TileGrid>
            </Box>
          );
        })}
        {!groups.length && <PaneEmpty>{t("no_icons_found")}</PaneEmpty>}
      </Box>
    </>
  );
}

export interface IconPickerProps {
  value?: string;
  /** An icon reference (the icon's switch takes the icon off). */
  onChange: (ref: string) => void;
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const { t } = useTranslation("common");
  const [tab, setTab] = useState<IconTab>(() => tabOf(value));
  // The emoji load while the picker is idle, so their tab draws at once.
  useEffect(() => {
    const load = () => void loadEmoji();
    if (typeof window.requestIdleCallback !== "function") {
      const timer = window.setTimeout(load, 200);
      return () => window.clearTimeout(timer);
    }
    const idle = window.requestIdleCallback(load, { timeout: 2000 });
    return () => window.cancelIdleCallback(idle);
  }, []);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", px: 3, borderBottom: 1, borderColor: "divider" }}>
        <Tabs
          value={tab}
          onChange={(_, next: IconTab) => setTab(next)}
          sx={{
            flex: 1,
            minHeight: 40,
            "& .MuiTab-root": { minHeight: 40, minWidth: 0, px: 2, textTransform: "none" },
          }}>
          <Tab value="symbols" label={t("style_editor.icon_tab_symbols")} />
          <Tab value="emoji" label={t("style_editor.icon_tab_emoji")} />
          <Tab value="custom" label={t("style_editor.icon_tab_custom")} />
        </Tabs>
      </Box>
      {/* One height for every tab, so switching tabs never resizes (or moves) the picker. */}
      <Box sx={{ height: PANE_HEIGHT, display: "flex", flexDirection: "column" }}>
        {tab === "symbols" && <SymbolsPane value={value} onPick={onChange} />}
        {tab === "emoji" && <EmojiPane value={value} onPick={onChange} />}
        {tab === "custom" && <CustomIconPane value={value} onPick={onChange} />}
      </Box>
    </Box>
  );
}
