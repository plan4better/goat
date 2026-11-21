"use client";

// The emoji tab of the icon picker: the emoji under their groups (the bar below jumps to one and marks the one in
// view), a search over names and keywords, a skin tone for emoji that have them and the recently used ones; both are
// remembered in this browser. The emoji are a chunk of their own, loaded by the editor's emoji name or the picker; the
// list draws only the rows near view and opens on the selected emoji.
import { Box, ButtonBase, Tooltip, alpha } from "@mui/material";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { ASSETS_URL } from "@/lib/constants";
import type { CatalogueEmoji } from "@/lib/style/generated/emoji";

import { loadEmoji, loadedEmoji } from "@/components/map/panels/styleEditor/pickers/iconRefs";
import {
  IconTile,
  PANE_LIST,
  PaneEmpty,
  PaneHeading,
  PaneSearch,
  TileGrid,
  tileStyles,
  usePaneGroups,
} from "@/components/map/panels/styleEditor/pickers/iconTiles";

const TONE_KEY = "goat-style-emoji-tone";
const RECENT_KEY = "goat-style-recent-emoji";
const RECENT_COUNT = 24;
/** The emoji standing for each group in the bar. */
const GROUP_EMOJI: Record<string, string> = {
  recent: "",
  smileys_emotion: "1f600",
  people_body: "1f44b",
  animals_nature: "1f43b",
  food_drink: "1f354",
  travel_places: "1f697",
  activities: "26bd",
  objects: "1f4a1",
  symbols: "2764-fe0f",
  flags: "1f3c1",
};
/** The raised hand of the tone button, in each tone. */
const HAND = "270b";
const TONES = ["", "1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"];

const EMOJI_URL = `${ASSETS_URL}/icons/emoji`;
/** The sheets' layout (scripts/build-emoji.mjs): cells in rows of this many. */
const SHEET_COLUMNS = 16;

/** Where each emoji sits in the picker's sheets: its group's sheet, or its tone's for a toned code. */
let cells: Map<string, { sheet: string; index: number }> | null = null;

/** The catalogue as the pane reads it, worked out once: the emoji by code (toned codes too, under their emoji) and
 * by group. */
interface Catalogue {
  all: readonly CatalogueEmoji[];
  groups: readonly string[];
  byCode: ReadonlyMap<string, CatalogueEmoji>;
  byGroup: ReadonlyMap<string, readonly CatalogueEmoji[]>;
}

let catalogue: Catalogue | null = null;

function catalogueOf(module: {
  EMOJI: readonly CatalogueEmoji[];
  EMOJI_GROUPS: readonly string[];
}): Catalogue {
  if (catalogue?.all === module.EMOJI) return catalogue;
  cells ??= cellsOf(module.EMOJI);
  const byCode = new Map<string, CatalogueEmoji>();
  const byGroup = new Map<string, CatalogueEmoji[]>();
  for (const e of module.EMOJI) {
    byCode.set(e.code, e);
    e.tones?.forEach((code) => byCode.set(code, e));
    const group = byGroup.get(e.group);
    if (group) group.push(e);
    else byGroup.set(e.group, [e]);
  }
  catalogue = { all: module.EMOJI, groups: module.EMOJI_GROUPS, byCode, byGroup };
  return catalogue;
}

const NO_EMOJI: readonly CatalogueEmoji[] = [];

export function cellsOf(emoji: readonly CatalogueEmoji[]): Map<string, { sheet: string; index: number }> {
  const out = new Map<string, { sheet: string; index: number }>();
  const inGroup = new Map<string, number>();
  let toned = 0;
  for (const e of emoji) {
    const index = inGroup.get(e.group) ?? 0;
    inGroup.set(e.group, index + 1);
    out.set(e.code, { sheet: e.group, index });
    if (e.tones) {
      e.tones.forEach((code, t) => out.set(code, { sheet: `tone-${t + 1}`, index: toned }));
      toned += 1;
    }
  }
  return out;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser without storage keeps the choice for this visit only.
  }
}

/** The emoji's code in `tone` (0 is the default yellow). */
const toned = (emoji: CatalogueEmoji, tone: number) =>
  tone > 0 && emoji.tones ? emoji.tones[tone - 1] : emoji.code;

/** An emoji from its sheet (one image per group, not per emoji), else its own image. A few emoji from many sheets
 * (the hands of the tone row, the group bar) take their own images: a sheet is worth loading for a grid, not for one
 * picture. */
const EmojiImage = memo(function EmojiImage({
  code,
  size = 24,
  sheet = true,
}: {
  code: string;
  size?: number;
  sheet?: boolean;
}) {
  const cell = sheet ? cells?.get(code) : undefined;
  if (!cell)
    return (
      <img src={`${EMOJI_URL}/${code}.webp`} alt="" width={size} height={size} style={{ display: "block" }} />
    );
  const col = cell.index % SHEET_COLUMNS;
  const row = Math.floor(cell.index / SHEET_COLUMNS);
  return (
    <span
      style={{
        display: "block",
        width: size,
        height: size,
        backgroundImage: `url("${EMOJI_URL}/sheets/${cell.sheet}.webp")`,
        backgroundSize: `${SHEET_COLUMNS * size}px auto`,
        backgroundPosition: `-${col * size}px -${row * size}px`,
      }}
    />
  );
});

/** One emoji's tile: drawn again only when its picture (its code in the tone) or its selection changes. */
const EmojiTile = memo(function EmojiTile({
  emoji,
  code,
  selected,
  onPick,
}: {
  emoji: CatalogueEmoji;
  code: string;
  selected: boolean;
  onPick: (emoji: CatalogueEmoji) => void;
}) {
  return (
    <IconTile label={emoji.name} selected={selected} onClick={() => onPick(emoji)}>
      <EmojiImage code={code} />
    </IconTile>
  );
});

/** A list of emoji: the rows from `first` to before `last` drawn, the others as their space. */
const Section = memo(function Section({
  emoji,
  tone,
  value,
  onPick,
  cols,
  first,
  last,
}: {
  emoji: readonly CatalogueEmoji[];
  tone: number;
  value?: string;
  onPick: (emoji: CatalogueEmoji) => void;
  cols: number;
  first: number;
  last: number;
}) {
  return (
    <TileGrid count={emoji.length} cols={cols} first={first}>
      {emoji.slice(first * cols, last * cols).map((e) => (
        <EmojiTile
          key={e.code}
          emoji={e}
          code={toned(e, tone)}
          selected={value === `emoji:${e.code}` || (!!e.tones && e.tones.some((c) => value === `emoji:${c}`))}
          onPick={onPick}
        />
      ))}
    </TileGrid>
  );
});

/** The tone a list of emoji is drawn in: none for a list without toned emoji, so a new tone leaves it as it is. */
const toneOf = (emoji: readonly CatalogueEmoji[], tone: number) => (emoji.some((e) => e.tones) ? tone : 0);

export function EmojiPane({ value, onPick }: { value?: string; onPick: (ref: string) => void }) {
  const { t } = useTranslation("common");
  // At once when the catalogue is loaded (the editor loads it to name an emoji), else once it is.
  const [data, setData] = useState<Catalogue | null>(() => {
    const loaded = loadedEmoji();
    return loaded && catalogueOf(loaded);
  });
  const all = data?.all ?? null;
  const [query, setQuery] = useState("");
  // The list follows the search once typing pauses; the field answers at once.
  const searched = useDeferredValue(query);
  const [tone, setTone] = useState<number>(() => readStored(TONE_KEY, 0));
  // The grid takes a new tone after the tone row has closed and the button shows it.
  const gridTone = useDeferredValue(tone);
  const [tonesOpen, setTonesOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readStored(RECENT_KEY, []));

  useEffect(() => {
    if (data) return;
    let live = true;
    void loadEmoji().then((module) => live && setData(catalogueOf(module)));
    return () => {
      live = false;
    };
  }, [data]);

  const byCode = data?.byCode;
  const byGroup = data?.byGroup;
  const found = useMemo(() => {
    const q = searched.trim().toLowerCase();
    if (!q || !all) return null;
    return all.filter((e) => e.name.includes(q) || e.keywords.some((k) => k.includes(q)));
  }, [all, searched]);
  const recentEmoji = useMemo(
    () =>
      byCode
        ? recent.flatMap((code) => {
            const e = byCode.get(code);
            return e?.code === code ? [e] : [];
          })
        : NO_EMOJI,
    [recent, byCode]
  );
  const shown = useMemo(
    () => [...(recentEmoji.length ? ["recent"] : []), ...(data?.groups ?? [])],
    [recentEmoji, data]
  );
  // The list opens on the selected emoji: its first tile, in the recently used ones or in its group.
  const selected = value?.startsWith("emoji:") ? byCode?.get(value.slice("emoji:".length)) : undefined;
  const reveal = useMemo(() => {
    if (!selected) return null;
    const inRecent = recentEmoji.indexOf(selected);
    if (inRecent >= 0) return { id: "recent", index: inRecent };
    return { id: selected.group, index: byGroup?.get(selected.group)?.indexOf(selected) ?? 0 };
  }, [selected, recentEmoji, byGroup]);
  const pane = usePaneGroups(shown, reveal);

  // One pick function for the whole list, so a group's tiles are not drawn again while nothing in them changed.
  const latest = useRef({ recent, tone, onPick });
  latest.current = { recent, tone, onPick };
  const pick = useCallback((emoji: CatalogueEmoji) => {
    const { recent: before, tone: current, onPick: write } = latest.current;
    const next = [emoji.code, ...before.filter((code) => code !== emoji.code)].slice(0, RECENT_COUNT);
    setRecent(next);
    store(RECENT_KEY, next);
    write(`emoji:${toned(emoji, current)}`);
  }, []);
  const chooseTone = (next: number) => {
    setTone(next);
    store(TONE_KEY, next);
    setTonesOpen(false);
  };
  const sectionOf = (id: string, emoji: readonly CatalogueEmoji[]) => {
    const [first, last] = pane.rows(id);
    return (
      <Section
        emoji={emoji}
        tone={toneOf(emoji, gridTone)}
        value={value}
        onPick={pick}
        cols={pane.cols}
        first={first}
        last={last}
      />
    );
  };
  const groupLabel = (group: string) =>
    t(group === "recent" ? "style_editor.emoji_recent" : `style_editor.emoji_group_${group}`);

  return (
    <>
      <PaneSearch
        label={t("style_editor.emoji_search")}
        value={query}
        onChange={setQuery}
        end={
          <ButtonBase
            aria-label={t("style_editor.emoji_tone")}
            aria-expanded={tonesOpen}
            title={t("style_editor.emoji_tone")}
            onClick={() => setTonesOpen((open) => !open)}
            sx={{ width: 40, height: 40, flex: "none", borderRadius: 1, border: 1, borderColor: "divider" }}>
            <EmojiImage code={tone ? `${HAND}-${TONES[tone]}` : HAND} size={22} sheet={false} />
          </ButtonBase>
        }
      />
      {tonesOpen && (
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, px: 3, pt: 2, ...tileStyles }}>
          {TONES.map((suffix, i) => (
            <IconTile
              key={i}
              label={t(`style_editor.emoji_tone_${i}`)}
              selected={tone === i}
              onClick={() => chooseTone(i)}>
              <EmojiImage code={suffix ? `${HAND}-${suffix}` : HAND} sheet={false} />
            </IconTile>
          ))}
        </Box>
      )}
      {!found && pane.current && (
        <Box sx={{ px: 3 }}>
          <PaneHeading>{groupLabel(pane.current)}</PaneHeading>
        </Box>
      )}
      <Box
        ref={pane.list}
        onScroll={pane.onScroll}
        data-pane-list
        sx={{ ...PANE_LIST, position: "relative", px: 3, pb: 2 }}>
        {!all && <PaneEmpty>{t("loading")}</PaneEmpty>}
        {found &&
          (found.length ? (
            <Box ref={pane.ref("found")} sx={{ pt: 3 }}>
              {sectionOf("found", found)}
            </Box>
          ) : (
            <PaneEmpty>{t("no_results_for", { q: query.trim() })}</PaneEmpty>
          ))}
        {/* The groups stay drawn under a search, so clearing it shows them at once. */}
        <Box hidden={!!found}>
          {shown.map((group, i) => {
            const emoji = group === "recent" ? recentEmoji : (byGroup?.get(group) ?? NO_EMOJI);
            return (
              <Box key={group} ref={pane.ref(group)}>
                {i > 0 && <PaneHeading>{groupLabel(group)}</PaneHeading>}
                {sectionOf(group, emoji)}
              </Box>
            );
          })}
        </Box>
      </Box>
      {!found && all && (
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            px: 2,
            py: 1,
            borderTop: 1,
            borderColor: "divider",
          }}>
          {shown.map((group) => {
            const on = pane.current === group;
            return (
              <Tooltip key={group} title={groupLabel(group)} placement="top">
                <ButtonBase
                  aria-label={groupLabel(group)}
                  aria-current={on ? "true" : undefined}
                  onClick={() => pane.jump(group)}
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: 1,
                    bgcolor: (theme) => (on ? alpha(theme.palette.primary.main, 0.12) : "transparent"),
                    filter: on ? "none" : "grayscale(1)",
                    opacity: on ? 1 : 0.7,
                    "&:hover": { filter: "none", opacity: 1 },
                  }}>
                  {group === "recent" ? (
                    <Icon iconName={ICON_NAME.CLOCK} sx={{ fontSize: 14, color: "text.secondary" }} />
                  ) : (
                    <EmojiImage code={GROUP_EMOJI[group]} size={18} sheet={false} />
                  )}
                </ButtonBase>
              </Tooltip>
            );
          })}
        </Box>
      )}
    </>
  );
}
