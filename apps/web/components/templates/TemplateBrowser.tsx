"use client";

import { Box, Button, Dialog, Skeleton, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useTemplate } from "@/lib/api/templates";
import type { TemplateShelf } from "@/lib/utils/templates";
import {
  TEMPLATE_EMPTY_HINT_KEY,
  compareTemplateShelves,
  templateBrowserEmptyCopy,
  templateBrowserTitleKey,
  templateEmptyTitle,
  templateShelfOf,
  templateSourceLabel,
  templateSourceOptions,
} from "@/lib/utils/templates";
import type { TemplateKind, TemplateRead, TemplateSourceFilter } from "@/lib/validations/template";

import { useTemplateBrowserState } from "@/hooks/templates/useTemplateBrowserState";

import { AppDialogFooter } from "@/components/common/AppDialog";
import EmptyState from "@/components/dashboard/common/EmptyState";
import SearchInput from "@/components/dashboard/common/SearchInput";
import StarterCard from "@/components/dashboard/common/StarterCard";
import { ContentDialogHeader, contentDialogPaperSx } from "@/components/modals/content/ContentDialogChrome";
import TemplateFilterChips from "@/components/templates/TemplateFilterChips";
import TemplateFilterPill from "@/components/templates/TemplateFilterPill";
import TemplateKindFilter from "@/components/templates/TemplateKindFilter";
import TemplatePreviewDialog from "@/components/templates/TemplatePreviewDialog";
import TemplatePreviewPanel from "@/components/templates/TemplatePreviewPanel";
import TemplateRow from "@/components/templates/TemplateRow";
import TemplateTag from "@/components/templates/TemplateTag";

interface TemplateBrowserProps {
  mode: "dialog" | "inline";
  /** Dialog mode only. */
  open?: boolean;
  onClose?: () => void;
  /** The Workflows/Layouts panels open the browser filtered to one kind and
   * hide the kind pills — there is nothing else to switch to. */
  lockedKind?: TemplateKind;
  /** Dialog mode only: the shelf the browser opens on, which the caller can
   * then leave. Inline mode is fixed to the GOAT shelf and takes no source
   * of its own. */
  initialSource?: TemplateSourceFilter;
  /** Opens the browser with this template's preview already showing — how
   * Home's "Run your first analysis" step lands the caller on a starter
   * without hiding the rest of the shelf. */
  initialTemplateId?: string;
  /** Hands the picked template off to the caller's `UseTemplateFlow`. */
  onUse: (template: TemplateRead) => void;
}

/** How many rows the list stands in for while the first page loads. */
const SKELETON_ROWS = 3;

/** T7's one template browser, in both places it is mounted: a dialog (every
 * "From template" entry point) and inline (the Catalog Templates tab,
 * §4/Task 8). The dialog is a master-detail chooser — a list on the left
 * carrying search, the filter pill's shelf and categories, and the kind
 * pills, one template's preview always filled on the right; inline is the
 * card grid the Catalog tab browses with, over the GOAT shelf alone,
 * previewing into `TemplatePreviewDialog`. The `useTemplates` calls live in
 * `useTemplateBrowserState`, so this component only renders what that state
 * says. */
const TemplateBrowser = ({
  mode,
  open,
  onClose,
  lockedKind,
  initialSource,
  initialTemplateId,
  onUse,
}: TemplateBrowserProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // Below `md` the card grid narrows and the dialog goes full screen, where
  // its two columns stack.
  const mobile = useMediaQuery(theme.breakpoints.down("md"));
  // The Catalog Templates tab is the GOAT shelf: inline mode fixes the
  // source there, and renders none of the controls that would change it.
  const lockedSource: TemplateSourceFilter | undefined = mode === "inline" ? "goat" : undefined;
  const state = useTemplateBrowserState({ lockedKind, lockedSource, initialSource });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Phone layout: the two columns are stacked, so the list hands over to the
  // preview until the caller comes back.
  const [previewOnly, setPreviewOnly] = useState(false);

  // A preselected template's own read, so its preview shows whether or not
  // it is on the first page of the current shelf. Opening it once leaves the
  // panel under the caller's control from then on.
  const { template: initialTemplate } = useTemplate(initialTemplateId ?? null);
  const [initialShown, setInitialShown] = useState(false);
  useEffect(() => {
    if (initialShown || !initialTemplate) return;
    setSelectedId(initialTemplate.id);
    setInitialShown(true);
  }, [initialShown, initialTemplate]);

  const picked =
    (selectedId ? state.templates.find((template) => template.id === selectedId) : undefined) ??
    (selectedId && initialTemplate?.id === selectedId ? initialTemplate : null);
  const shelfOf = useMemo(() => {
    const shelves = new Map<string, TemplateShelf>();
    for (const template of state.templates) {
      shelves.set(template.id, templateShelfOf(template, state.spaces));
    }
    return shelves;
  }, [state.templates, state.spaces]);
  // A template reached by `initialTemplateId` is not necessarily on the
  // current page, so it has no entry in the map and is resolved on the spot.
  const shelfFor = (template: TemplateRead) =>
    shelfOf.get(template.id) ?? templateShelfOf(template, state.spaces);

  // Under "Everyone" the rows are grouped by the shelf they came from — one
  // group per team or organization space, so a caller in two teams gets one
  // group per team rather than a pile labelled after whichever sorts first.
  // A single shelf is a flat list whose rows carry the shelf as a tag.
  const groups = useMemo(() => {
    if (state.source !== "all") {
      return [{ key: state.source, shelf: null as TemplateShelf | null, items: state.templates }];
    }
    const byShelf = new Map<string, { key: string; shelf: TemplateShelf | null; items: TemplateRead[] }>();
    for (const template of state.templates) {
      const shelf = shelfOf.get(template.id) ?? templateShelfOf(template, state.spaces);
      const group = byShelf.get(shelf.key) ?? { key: shelf.key, shelf, items: [] };
      group.items.push(template);
      byShelf.set(shelf.key, group);
    }
    return [...byShelf.values()].sort((a, b) =>
      a.shelf && b.shelf ? compareTemplateShelves(a.shelf, b.shelf) : 0
    );
  }, [state.source, state.templates, state.spaces, shelfOf]);

  // The dialog is a chooser, so its preview column is never empty while the
  // list has rows — and the row it opens on is the first one rendered, which
  // is the first row of the first group rather than the first row the API
  // happened to return. Inline previews only what was actually clicked,
  // since there the preview is a dialog that would otherwise open by itself.
  const selected = mode === "dialog" ? (picked ?? groups[0]?.items[0] ?? null) : picked;

  // Every filter change re-selects the first row of the new list rather than
  // holding a preview of something that is no longer on screen. Inline keeps
  // its preview on whatever was clicked: there a filter change does not put a
  // different template on screen, it only re-lists the cards behind it.
  const clearSelection = () => {
    if (mode === "inline") return;
    setSelectedId(null);
    setPreviewOnly(false);
  };
  const changeSearch = (value: string) => {
    state.setSearch(value);
    clearSelection();
  };
  const changeKind = (kind: TemplateKind | "all") => {
    state.setKind(kind);
    clearSelection();
  };
  const changeSource = (source: TemplateSourceFilter) => {
    state.setSource(source);
    clearSelection();
  };
  const changeTag = (tag: string) => {
    state.toggleTag(tag);
    clearSelection();
  };
  const clearFilters = () => {
    state.clearFilters();
    clearSelection();
  };
  const clearTags = () => {
    state.setTags([]);
    clearSelection();
  };
  const pick = (template: TemplateRead) => {
    setSelectedId(template.id);
    setPreviewOnly(true);
  };

  const showEmptyState = !state.isLoading && state.templates.length === 0;
  // Nothing on the shelf itself, rather than nothing left after a filter:
  // the whole dialog body says so once, instead of an empty list beside a
  // preview column with nothing to preview.
  // A search or a category filter is a narrower question than the shelf
  // itself; the source is the shelf the caller asked for.
  const filtered = state.search.trim() !== "" || state.tags.length > 0;
  const narrowed = filtered || state.source !== "all";
  const shelfEmpty = showEmptyState && !narrowed;

  const sourceOptionLabel = (value: string) =>
    t(templateSourceOptions(state.spaces).find((option) => option.value === value)?.labelKey ?? value);

  // One chip per facet. The categories chip names the first two tags — each
  // in its own colour, the one it carries everywhere else — and counts the
  // rest, so a long selection stays one line, and removing it clears the
  // facet rather than one tag.
  const filterChips = [
    ...(lockedSource || state.source === "all"
      ? []
      : [
          {
            key: "source",
            label: `${t("source")}: ${sourceOptionLabel(state.source)}`,
            onRemove: () => changeSource("all"),
          },
        ]),
    ...(state.tags.length === 0
      ? []
      : [
          {
            key: "categories",
            label: (
              <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                {`${t("categories")}:`}
                {state.tags.slice(0, 2).map((tag) => (
                  <TemplateTag key={tag} label={tag} tone="category" />
                ))}
                {state.tags.length > 2 && <span>{`+${state.tags.length - 2}`}</span>}
              </Box>
            ),
            onRemove: clearTags,
          },
        ]),
  ];

  // The Catalog tab browses the GOAT shelf and nothing else, so its empty
  // state has no other source to send the caller to: a search that matched
  // nothing says so — its field is the row above the grid — and an empty
  // shelf says the shelf is empty.
  const inlineEmptyState = (
    <EmptyState
      icon={ICON_NAME.CLONE}
      title={filtered ? t("templates_empty_filter_title") : templateEmptyTitle(t, state.source)}
      hint={filtered ? t("templates_empty_filter_hint") : t(TEMPLATE_EMPTY_HINT_KEY[state.source])}
    />
  );

  // The dialog says what came back empty in one line, with nothing to press:
  // the filters it names sit in the row right above the list.
  const emptyCopy = templateBrowserEmptyCopy(filtered, state.source, sourceOptionLabel(state.source));
  const dialogEmptyState = (
    <EmptyState
      compact
      icon={ICON_NAME.CLONE}
      title={t(emptyCopy.titleKey, emptyCopy.titleVars)}
      hint={t(emptyCopy.hintKey)}
    />
  );

  const inlineList = (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "16px 22px",
        overflowY: "auto",
      }}>
      <SearchInput value={state.search} onChange={changeSearch} placeholder={t("search")} fullWidth />
      {!lockedKind && <TemplateKindFilter kind={state.kind} onChange={changeKind} />}

      {showEmptyState ? (
        inlineEmptyState
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: mobile
              ? "repeat(auto-fill, minmax(min(100%, 168px), 1fr))"
              : "repeat(auto-fill, minmax(210px, 1fr))",
            gap: mobile ? "10px" : "16px",
          }}>
          {state.templates.map((template) => (
            <StarterCard
              key={template.id}
              template={template}
              pinned={!!state.starred[template.id]}
              onTogglePin={() => state.toggleStar(template.id)}
              onOpen={() => setSelectedId(template.id)}
              mobile={mobile}
            />
          ))}
        </Box>
      )}

      <Typography
        component="div"
        sx={{ fontSize: 12, color: theme.palette.text.secondary, textAlign: "right" }}>
        {t("showing_n_of_m_templates", { n: state.templates.length, m: state.total })}
      </Typography>
    </Box>
  );

  if (mode === "inline") {
    return (
      <>
        <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>{inlineList}</Box>
        <TemplatePreviewDialog
          open={!!selected}
          template={selected ?? undefined}
          sourceLabel={selected ? templateSourceLabel(shelfFor(selected), t) : undefined}
          onClose={() => setSelectedId(null)}
          onUse={() => {
            if (!selected) return;
            setSelectedId(null);
            onUse(selected);
          }}
        />
      </>
    );
  }

  const renderRow = (template: TemplateRead, tagged: boolean) => (
    <TemplateRow
      key={template.id}
      template={template}
      selected={selected?.id === template.id}
      onSelect={() => pick(template)}
      sourceLabel={tagged ? templateSourceLabel(shelfFor(template), t) : undefined}
    />
  );

  const listColumn = (
    <Box
      sx={{
        width: mobile ? "100%" : 400,
        flexShrink: 0,
        // Stacked below `md` the list takes the height its footer leaves it;
        // beside the preview it keeps its own width.
        flexGrow: mobile ? 1 : 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderRight: mobile ? undefined : `1px solid ${theme.palette.divider}`,
      }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "14px 14px 10px",
          flexShrink: 0,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* The field grows along the row; the pill keeps its own width. */}
          <Box sx={{ display: "flex", flex: 1, minWidth: 0 }}>
            <SearchInput
              value={state.search}
              onChange={changeSearch}
              placeholder={t("search_templates")}
              fullWidth
            />
          </Box>
          <TemplateFilterPill
            source={state.source}
            onSource={changeSource}
            hideSource={!!lockedSource}
            spaces={state.spaces}
            tags={state.tags}
            availableTags={state.availableTags}
            onToggleTag={changeTag}
            tagsLoading={state.tagsLoading}
            activeFilterCount={state.activeFilterCount}
            onClear={clearFilters}
          />
        </Box>
        <TemplateFilterChips items={filterChips} />
        {!lockedKind && <TemplateKindFilter kind={state.kind} onChange={changeKind} />}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 8px 12px" }}>
        {state.isLoading ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: "8px", padding: "4px" }}>
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} variant="rounded" height={58} />
            ))}
          </Box>
        ) : showEmptyState ? (
          <Box sx={{ padding: "12px" }}>{dialogEmptyState}</Box>
        ) : (
          <Box role="listbox" aria-label={t("templates")}>
            {groups.map((group) =>
              group.shelf ? (
                <Box
                  key={group.key}
                  role="group"
                  aria-label={templateSourceLabel(group.shelf, t)}
                  sx={{ mb: "6px" }}>
                  <Typography
                    component="div"
                    sx={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.6px",
                      textTransform: "uppercase",
                      color: theme.palette.text.disabled,
                      padding: "10px 12px 4px",
                    }}>
                    {`${templateSourceLabel(group.shelf, t)} · ${group.items.length}`}
                  </Typography>
                  {group.items.map((template) => renderRow(template, false))}
                </Box>
              ) : (
                <Box key={group.key}>{group.items.map((template) => renderRow(template, true))}</Box>
              )
            )}
          </Box>
        )}
      </Box>
    </Box>
  );

  const footer = (
    <AppDialogFooter
      onCancel={() => onClose?.()}
      primaryLabel={t("use_template")}
      onPrimary={() => selected && onUse(selected)}
      primaryDisabled={!selected}
    />
  );

  // Nothing on this shelf at all: one empty state across the body, with the
  // dialog's own actions still under it.
  const emptyBody = (
    <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "22px",
        }}>
        <Box sx={{ width: "100%", maxWidth: 460 }}>{dialogEmptyState}</Box>
      </Box>
      {footer}
    </Box>
  );

  const previewColumn = (
    <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {mobile && (
        <Box sx={{ padding: "10px 14px", borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0 }}>
          <Button variant="outlined" size="small" onClick={() => setPreviewOnly(false)}>
            {t("back")}
          </Button>
        </Box>
      )}
      {state.isLoading ? (
        <Box sx={{ flex: 1, minHeight: 0, padding: "22px" }}>
          <Skeleton variant="rounded" height={280} />
        </Box>
      ) : selected ? (
        <TemplatePreviewPanel template={selected} sourceLabel={templateSourceLabel(shelfFor(selected), t)} />
      ) : (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "22px",
            textAlign: "center",
            fontSize: 13,
            color: theme.palette.text.secondary,
          }}>
          {t("select_template_to_preview")}
        </Box>
      )}
      {footer}
    </Box>
  );

  return (
    <Dialog
      open={!!open}
      onClose={() => onClose?.()}
      fullScreen={mobile}
      maxWidth={false}
      PaperProps={{ sx: contentDialogPaperSx(1200, mobile) }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          // MUI caps the paper at `calc(100% - 64px)`, so a taller inner box
          // would scroll the paper itself and unpin the footer.
          height: mobile ? "100%" : "min(800px, calc(100vh - 64px))",
        }}>
        <ContentDialogHeader
          icon={ICON_NAME.CLONE}
          title={t(templateBrowserTitleKey(lockedKind))}
          subline={
            <Typography component="div" variant="body2" sx={{ color: theme.palette.text.secondary }}>
              {t(lockedKind ? "template_browser_locked_hint" : "template_browser_hint")}
            </Typography>
          }
          onClose={() => onClose?.()}
          closeLabel={t("close")}
          divider
        />
        <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
          {shelfEmpty ? (
            emptyBody
          ) : mobile ? (
            selected && previewOnly ? (
              previewColumn
            ) : (
              // Stacked, the list is the whole dialog body, so it carries the
              // actions itself — otherwise there is no way out but the
              // header's X until a template is picked.
              <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
                {listColumn}
                {footer}
              </Box>
            )
          ) : (
            <>
              {listColumn}
              {previewColumn}
            </>
          )}
        </Box>
      </Box>
    </Dialog>
  );
};

export default TemplateBrowser;
