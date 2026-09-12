"use client";

import {
  Box,
  Button,
  Container,
  Drawer,
  Grid,
  IconButton,
  Pagination,
  Skeleton,
  Stack,
  Typography,
  debounce,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useCatalogAggregations, useCatalogDatasets } from "@/lib/api/catalog";
import { useFavoriteStars } from "@/lib/api/favorites";
import { datasetCard } from "@/lib/catalog/card";
import { DEFAULT_SORT } from "@/lib/catalog/searchQuery";
import type { CatalogCollection } from "@/lib/validations/catalog";
import type { TemplateRead, TemplateUseResult } from "@/lib/validations/template";

import { FACET_HIDDEN, useCatalogFacetSections } from "@/hooks/catalog/useCatalogFacetSections";
import { CATALOG_PAGE_SIZE, useCatalogSearchState } from "@/hooks/catalog/useCatalogSearchState";
import { templateResultHref } from "@/hooks/templates/useUseTemplate";

import CatalogActiveFilters from "@/components/dashboard/catalog/CatalogActiveFilters";
import CatalogCard from "@/components/dashboard/catalog/CatalogCard";
import CatalogFilterPanel from "@/components/dashboard/catalog/CatalogFilterPanel";
import CatalogSpatialSection from "@/components/dashboard/catalog/CatalogSpatialSection";
import CatalogTabs from "@/components/dashboard/catalog/CatalogTabs";
import CatalogToolbar from "@/components/dashboard/catalog/CatalogToolbar";
import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import TemplateBrowser from "@/components/templates/TemplateBrowser";
import UseTemplateFlow from "@/components/templates/UseTemplateFlow";

/**
 * The catalog: search, filter and browse the datasets served by the STAC API
 * (apps/catalog). Replaces the previous page, which read `customer.layer` rows
 * flagged `in_catalog`.
 *
 * Two properties are deliberate:
 *
 * **The URL is the only state.** Filters, search, sort, page and view all live
 * in the query string (`useCatalogSearchState`), so a pasted link reproduces a
 * view exactly. The old page kept the same state twice — in `nuqs` and in a
 * React object every toggle had to update by hand.
 *
 * **The facet list is not written down anywhere in the client.** It comes from
 * `/stac/aggregations`, which reports each facet's name *and* the parameter
 * that narrows it (`goat:filter_param`). A facet added server-side appears
 * here; one whose column the harvester dropped stops being offered. That
 * matters: the name is not the parameter — `category_count` is narrowed with
 * `?themes=`.
 */

/** Icons per facet parameter. Falls back to a neutral filter glyph. */
/** Sort choices, page-only: the Add Layer picker takes results as they come. */
const SORT_OPTIONS: { value: string; labelKey: string; icon: ICON_NAME }[] = [
  { value: DEFAULT_SORT, labelKey: "sort_relevance", icon: ICON_NAME.BULLSEYE },
  { value: "-updated", labelKey: "sort_last_updated", icon: ICON_NAME.REFRESH },
  { value: "title", labelKey: "sort_title_asc", icon: ICON_NAME.SORT_ALPHA_ASC },
  { value: "-title", labelKey: "sort_title_desc", icon: ICON_NAME.SORT_ALPHA_DESC },
];

/**
 * A dataset row. The adapter lives here rather than inline at both call sites so
 * the grid and the list cannot drift.
 */
const DatasetCard = ({
  dataset,
  view,
  compact,
  starred,
  onToggleStar,
  onOpen,
}: {
  dataset: CatalogCollection;
  view?: "list" | "grid";
  compact?: boolean;
  starred: boolean;
  onToggleStar: (id: string) => void;
  onOpen: (href: string) => void;
}) => {
  const card = datasetCard(dataset);
  return (
    <CatalogCard
      card={card}
      view={view}
      compact={compact}
      starred={starred}
      onToggleStar={() => onToggleStar(dataset.id)}
      onClick={() => onOpen(card.href)}
      onOpenMember={(memberId) => onOpen(`/catalog/${encodeURIComponent(memberId)}`)}
    />
  );
};

const CatalogPage = () => {
  const { t, i18n } = useTranslation("common");
  const router = useRouter();
  const theme = useTheme();
  /** Below `md` the sidebar becomes a drawer — see the Grid below. */
  const isCompact = useMediaQuery(theme.breakpoints.down("md"));
  /** Below `sm` the toolbar and the cards switch to their phone layouts. */
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { aggregations: served, isLoading: discoveryLoading } = useCatalogAggregations();
  const aggregations = useMemo(
    () => served.filter((a) => !FACET_HIDDEN.has(a["goat:filter_param"] ?? "")),
    [served]
  );
  const {
    view,
    page,
    tab,
    spatial,
    facetSelections,
    activeFilterCount,
    searchParams,
    facetQueryParams,
    setQ,
    setSort,
    setPage,
    setView,
    setSpatial,
    setDateRange,
    setTab,
    toggleFacet,
    clearAll,
    state,
  } = useCatalogSearchState({ aggregations });
  const [templateInUse, setTemplateInUse] = useState<TemplateRead | null>(null);

  /**
   * The sidebar's sections, their labels and their bucket counts — shared with the
   * Add Layer picker, which shows the same filters over the same catalog.
   */
  const {
    sections: facetSections,
    facetLabel,
    optionLabel: facetOptionLabel,
  } = useCatalogFacetSections({ aggregations, facetQueryParams });

  /**
   * Selected NUTS regions. Held in the URL as one comma-separated value so a
   * filtered catalog is shareable, and split here for the chips.
   */
  // Persistent, user-scoped, shared with the add-layer picker's stars.
  const { starred, toggleStar } = useFavoriteStars("catalog_item");
  const [favouritesOnly, setFavouritesOnly] = useState(false);

  /**
   * Favourites filter server-side: the saved ids go into the search as `ids`,
   * so the result count and pagination describe the favourites, not whichever
   * page happened to be loaded. With nothing starred there is nothing to ask
   * for — the request is skipped and the list is simply empty.
   */
  const starredIds = useMemo(() => Object.keys(starred), [starred]);
  const effectiveParams = useMemo(
    () => (favouritesOnly ? { ...searchParams, ids: starredIds } : searchParams),
    [favouritesOnly, searchParams, starredIds]
  );
  const {
    datasets: fetchedDatasets,
    total,
    isLoading,
    isValidating,
  } = useCatalogDatasets(effectiveParams, !(favouritesOnly && starredIds.length === 0));

  const items = favouritesOnly && starredIds.length === 0 ? [] : fetchedDatasets;
  const debouncedSetQ = useMemo(() => debounce((value: string) => setQ(value), 500), [setQ]);

  const effectiveTotal = favouritesOnly && starredIds.length === 0 ? 0 : total;
  const pageCount = effectiveTotal ? Math.ceil(effectiveTotal / CATALOG_PAGE_SIZE) : 0;
  const showSkeletons = isLoading && !items.length;
  const totalActiveFilters = activeFilterCount + (favouritesOnly ? 1 : 0);

  const filterPanel = discoveryLoading ? (
    <Skeleton variant="rectangular" height={420} />
  ) : (
    <CatalogFilterPanel
      facets={facetSections}
      selected={facetSelections}
      onToggleFacet={toggleFacet}
      activeFilterCount={totalActiveFilters}
      onClearAll={() => {
        setFavouritesOnly(false);
        clearAll();
      }}
      favouritesOnly={favouritesOnly}
      onToggleFavourites={() => {
        // Reset to page 1: the favourites are usually far fewer than the
        // current page's offset, which would otherwise request past the end
        // and render a false "no favourites" empty state.
        setPage(1);
        setFavouritesOnly((on) => !on);
      }}
      dateFrom={state.from}
      dateTo={state.to}
      onChangeDates={({ from, to }) => setDateRange(from ?? null, to ?? null)}
      spatialFilter={<CatalogSpatialSection filter={spatial} onChange={setSpatial} />}
      flush={isCompact}
      headerAction={
        isCompact ? (
          <IconButton size="small" aria-label={t("close")} onClick={() => setFiltersOpen(false)}>
            <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 13 }} />
          </IconButton>
        ) : undefined
      }
    />
  );

  return (
    <Container sx={{ py: 10, px: { xs: 4, sm: 10 } }} maxWidth="xl">
      <Box sx={{ mb: 8 }}>
        <PageHeader title={t("catalog")} subtitle={t("catalog_subtitle")} />
      </Box>

      <CatalogTabs active={tab} onChange={setTab} datasetCount={total} />

      {tab === "templates" ? (
        <>
          {/* The tab browses the GOAT shelf alone: inline mode fixes the
            source, so there is none to pass and none to switch to. */}
          <TemplateBrowser mode="inline" onUse={(template) => setTemplateInUse(template)} />
          {templateInUse && (
            <UseTemplateFlow
              template={templateInUse}
              context={{ kind: "new_project" }}
              onClose={() => setTemplateInUse(null)}
              onDone={(result: TemplateUseResult) => {
                setTemplateInUse(null);
                router.push(templateResultHref(templateInUse, result));
              }}
            />
          )}
        </>
      ) : (
        <Grid container justifyContent="space-between" spacing={4}>
          {/* On a phone the sidebar moves into a drawer. Stacked above the results
            it would push every dataset below the fold behind eight collapsed
            filter sections — the results are what the page is for. */}
          {!isCompact && (
            <Grid item xs={12} md={3}>
              {filterPanel}
            </Grid>
          )}

          <Grid item xs={12} md={9}>
            <Stack spacing={2}>
              <CatalogToolbar
                q={state.q ?? ""}
                onChangeQ={debouncedSetQ}
                view={view}
                onChangeView={setView}
                sort={state.sortby}
                sortOptions={SORT_OPTIONS.map((option) => ({ ...option, label: t(option.labelKey) }))}
                onChangeSort={setSort}
                onOpenFilters={isCompact ? () => setFiltersOpen(true) : undefined}
                activeFilterCount={totalActiveFilters}
                compact={isPhone}
              />

              {/* Count and active filters share ONE row. As its own row above the
                count, the chip strip appeared the moment a first filter was
                selected and pushed everything below it down 32px — a measurable
                jump on every tick. The row exists either way now. */}
              <Stack
                direction="row"
                alignItems="center"
                useFlexGap
                flexWrap="wrap"
                gap={2}
                sx={{ minHeight: 32 }}>
                <Typography variant="body2" fontWeight="bold">
                  {favouritesOnly
                    ? t("catalog_n_favourites", { count: effectiveTotal ?? 0 })
                    : total === undefined
                      ? " "
                      : total === 0
                        ? t("n_datasets", { count: 0 })
                        : t("catalog_result_range", {
                            from: ((page - 1) * CATALOG_PAGE_SIZE + 1).toLocaleString(i18n.language),
                            to: Math.min(page * CATALOG_PAGE_SIZE, total).toLocaleString(i18n.language),
                            total: total.toLocaleString(i18n.language),
                          })}
                </Typography>
                {isValidating && !showSkeletons && (
                  <Typography variant="caption" color="text.secondary">
                    {t("loading")}
                  </Typography>
                )}
                <CatalogActiveFilters
                  selections={facetSelections}
                  facetLabel={facetLabel}
                  optionLabel={facetOptionLabel}
                  onRemove={toggleFacet}
                />
              </Stack>

              {showSkeletons && (
                <Stack spacing={4}>
                  {Array.from({ length: CATALOG_PAGE_SIZE }).map((_, index) => (
                    <Skeleton key={index} variant="rectangular" height={120} />
                  ))}
                </Stack>
              )}

              {/* "Nothing starred" is a different emptiness from "nothing
                matched" — it gets its own message and skips the request. */}
              {!showSkeletons && favouritesOnly && items.length === 0 && (
                <EmptyState
                  icon={ICON_NAME.STAR}
                  title={t("catalog_no_favourites")}
                  hint={t("catalog_no_favourites_hint")}
                />
              )}

              {!showSkeletons && !favouritesOnly && total === 0 && (
                <EmptyState
                  icon={ICON_NAME.DATABASE}
                  title={t("no_catalog_dataset_found")}
                  hint={t("try_different_filters")}
                />
              )}

              {!showSkeletons && items.length > 0 && (
                <>
                  {view === "grid" ? (
                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: {
                          xs: "1fr",
                          sm: "repeat(2, minmax(0, 1fr))",
                          lg: "repeat(3, minmax(0, 1fr))",
                        },
                        // Every row as tall as the tallest card in it. `auto` is not
                        // the same thing here: where the grid has a height of its own,
                        // as it does in the Add Layer picker, `auto` rows are sized to
                        // fit that height and the cards are clipped instead.
                        gridAutoRows: "max-content",
                        gap: 4,
                      }}>
                      {items.map((dataset) => (
                        <DatasetCard
                          key={dataset.id}
                          dataset={dataset}
                          view="grid"
                          compact={isPhone}
                          starred={!!starred[dataset.id]}
                          onToggleStar={toggleStar}
                          onOpen={router.push}
                        />
                      ))}
                    </Box>
                  ) : (
                    <Stack spacing={4}>
                      {items.map((dataset) => (
                        <DatasetCard
                          key={dataset.id}
                          dataset={dataset}
                          compact={isPhone}
                          starred={!!starred[dataset.id]}
                          onToggleStar={toggleStar}
                          onOpen={router.push}
                        />
                      ))}
                    </Stack>
                  )}

                  {pageCount > 1 && (
                    <Stack direction="row" justifyContent="center" sx={{ p: 4 }}>
                      <Pagination
                        count={pageCount}
                        page={page}
                        size="large"
                        onChange={(_event, next) => setPage(next)}
                      />
                    </Stack>
                  )}
                </>
              )}
            </Stack>
          </Grid>
        </Grid>
      )}

      <Drawer
        anchor="bottom"
        open={isCompact && filtersOpen}
        onClose={() => setFiltersOpen(false)}
        // Not full height: leaving the results visible behind the sheet keeps the
        // effect of each tick in view, which is the point of filtering.
        PaperProps={{ sx: { maxHeight: "85vh", borderRadius: "16px 16px 0 0" } }}>
        <Box sx={{ pt: 2, pb: 2, overflowY: "auto" }}>{filterPanel}</Box>
        <Box
          sx={{
            position: "sticky",
            bottom: 0,
            p: 3,
            borderTop: `1px solid ${theme.palette.divider}`,
            backgroundColor: theme.palette.background.paper,
          }}>
          <Button fullWidth variant="contained" onClick={() => setFiltersOpen(false)}>
            {t("catalog_show_n_results", { count: total ?? 0 })}
          </Button>
        </Box>
      </Drawer>
    </Container>
  );
};

export default CatalogPage;
