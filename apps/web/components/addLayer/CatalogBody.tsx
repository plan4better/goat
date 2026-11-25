"use client";

import { Box, Skeleton, Stack, TextField, Typography, useTheme } from "@mui/material";
import { Fragment, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { CatalogFlow } from "@/hooks/addLayer/useCatalogFlow";
import { useCatalogFacetSections } from "@/hooks/catalog/useCatalogFacetSections";

import CatalogPickerCard from "@/components/addLayer/CatalogPickerCard";
import CatalogActiveFilters from "@/components/dashboard/catalog/CatalogActiveFilters";
import CatalogFilterPanel from "@/components/dashboard/catalog/CatalogFilterPanel";
import CatalogSpatialSection from "@/components/dashboard/catalog/CatalogSpatialSection";

/**
 * Browsing the catalog to pick layers: filters down the left, results as the same
 * cards the catalog page shows, each with a checkbox.
 *
 * A picker rather than the page: no sort, no grid/list switch, no navigation. What
 * it keeps is the sidebar and the cards, so a dataset looks and filters the same way
 * in both places.
 */
const CatalogBody = ({ controller }: { controller: CatalogFlow }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { catalog } = controller;
  const { sections, facetLabel, optionLabel } = useCatalogFacetSections({
    aggregations: catalog.aggregations,
    facetQueryParams: catalog.facetQueryParams,
  });

  /**
   * Favourites narrow the page in memory, as on the catalog page: they are not
   * stored server-side yet, so the API cannot filter by them.
   */
  /**
   * More results load when the end of the list comes into view, so the scroller is
   * the observer's root rather than the viewport — the page behind this modal does
   * not scroll.
   */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { hasMore, isLoadingMore, loadMore, queryKey } = catalog;
  useEffect(() => {
    const scroller = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!scroller || !sentinel || !hasMore || isLoadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      // A page ahead of the edge, so the next rows are usually there by the time the
      // last ones are read.
      { root: scroller, rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, loadMore]);

  // A new query is a new list: staying halfway down it reads as a bug.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [queryKey]);

  // Favourites are filtered by the API (`ids` on the search), so what arrives
  // is already the right list.
  const shown = catalog.datasets;
  // The server puts the datasets touching the map view first and counts them, so
  // the "Elsewhere" header goes before the card at that position. One group needs
  // no header.
  const inArea = catalog.inArea ?? 0;
  const grouped = inArea > 0 && inArea < catalog.total;
  // The section label the Connect tab sets over its cards.
  const groupHeading = (label: string) => (
    <Typography
      variant="caption"
      fontWeight={700}
      color="text.secondary"
      sx={{ gridColumn: "1 / -1", letterSpacing: 0.6, textTransform: "uppercase" }}>
      {label}
    </Typography>
  );

  return (
    <Stack
      direction="row"
      sx={{
        height: "min(760px, 74vh)",
        minHeight: 0,
        width: "100%",
      }}>
      <Box
        sx={{
          width: 256,
          flexShrink: 0,
          borderRight: `1px solid ${theme.palette.divider}`,
          /**
           * Flush to the frame, which is why the host leaves this tab unpadded: the
           * rail's row dividers then run edge to edge and read as rules on one page
           * rather than outlining a panel dropped into a gap. No padding on this
           * side either — it would hold every rule short of the border, which is
           * the look being avoided. The indent lives in the panel's own `inset`,
           * so the text moves in while the rules do not. Nor above: the panel's own
           * header brings the space it needs.
           */
          overflowY: "auto",
        }}>
        <CatalogFilterPanel
          flush
          // The rail itself is flush to the frame, so the indent belongs here: rows
          // span the full width while their contents sit 16px in.
          inset={4}
          facets={sections}
          selected={catalog.facetSelections}
          onToggleFacet={catalog.toggleFacet}
          activeFilterCount={catalog.activeFilterCount}
          onClearAll={catalog.clearFilters}
          favouritesOnly={catalog.favouritesOnly}
          onToggleFavourites={catalog.toggleFavourites}
          dateFrom={catalog.dateFrom}
          dateTo={catalog.dateTo}
          onChangeDates={({ from, to }) => catalog.setDates({ from: from ?? null, to: to ?? null })}
          spatialFilter={<CatalogSpatialSection filter={catalog.spatial} onChange={catalog.setSpatial} />}
        />
      </Box>

      {/**
       * The results column carries no horizontal padding of its own: the search row
       * and the grid each pay for their inset, which lets the rule between them run
       * from the rail to the modal's frame, and lets the grid's scrollbar ride that
       * frame instead of floating inside the content.
       */}
      <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, pt: 4 }}>
        <Box sx={{ px: 6, pb: 3, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t("search_datasets")}
            value={catalog.q}
            onChange={(event) => catalog.setQ(event.target.value)}
            InputProps={{
              startAdornment: (
                <Icon
                  iconName={ICON_NAME.SEARCH}
                  style={{ fontSize: 15, marginRight: 8 }}
                  htmlColor={theme.palette.text.secondary}
                />
              ),
            }}
            sx={{ mb: 3 }}
          />

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="caption" color="text.secondary">
              {catalog.favouritesOnly
                ? t("catalog_n_favourites", { count: catalog.total })
                : t("n_datasets", { count: catalog.total })}
              {catalog.selection.ids.length > 0 &&
                ` · ${t("catalog_n_selected", { count: catalog.selection.ids.length })}`}
            </Typography>
            {catalog.selection.ids.length > 0 && (
              <Typography
                component="button"
                variant="caption"
                onClick={catalog.selection.clear}
                sx={{
                  background: "transparent",
                  border: "none",
                  p: 0,
                  cursor: "pointer",
                  fontWeight: 600,
                  color: theme.palette.primary.main,
                }}>
                {t("catalog_clear_selection")}
              </Typography>
            )}
          </Stack>

          {/* The catalog page's row of removable filters, in the same place relative
              to the count. */}
          <Box sx={{ "&:not(:empty)": { mt: 2.5 } }}>
            <CatalogActiveFilters
              selections={catalog.facetSelections}
              facetLabel={facetLabel}
              optionLabel={optionLabel}
              onRemove={catalog.toggleFacet}
            />
          </Box>
        </Box>

        {/* The catalog page's grid, tracks and gap included, so a dataset is met as
            the same tile whether it is being browsed or picked. Tiles rather than
            rows because at this width a row spends most of itself on whitespace,
            and a picker is judged by how many candidates it shows at once. */}
        <Box
          ref={scrollerRef}
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              sm: "repeat(2, minmax(0, 1fr))",
              lg: "repeat(3, minmax(0, 1fr))",
            },
            alignContent: "start",
            // Every row as tall as the tallest card in it. `auto` is not the same
            // thing here: this grid has a height of its own, so `auto` rows are sized
            // to fit it — which squeezed all four rows to 117px and clipped every
            // card — and a `minmax()` floor freezes them at the floor.
            gridAutoRows: "max-content",
            gap: 4,
            // The inset the cards sit at, matching the search row above them, and wide
            // enough for a card's hover lift and its shadow — this box clips, so
            // without room the raised edge of the top row would slide out of sight
            // under the rule. The scrollbar rides the box's own edge, outside it.
            px: 6,
            pt: 3,
            // Only the lift's worth at the bottom: the list runs up to the footer's
            // rule, so it reads as continuing behind it rather than stopping short.
            pb: 1,
          }}>
          {catalog.isLoading && !catalog.datasets.length
            ? [0, 1, 2, 3].map((key) => <Skeleton key={key} variant="rectangular" height={320} />)
            : shown.map((dataset, index) => (
                <Fragment key={dataset.id}>
                  {grouped && index === 0 && groupHeading(t("catalog_in_this_area", { count: inArea }))}
                  {grouped &&
                    index === inArea &&
                    groupHeading(t("catalog_elsewhere", { count: catalog.elsewhere ?? 0 }))}
                  <CatalogPickerCard
                    collection={dataset}
                    selection={catalog.selection}
                    starred={!!catalog.starred[dataset.id]}
                    onToggleStar={catalog.toggleStar}
                  />
                </Fragment>
              ))}
          {/* Rows on their way, in place, so the list grows rather than flickering. */}
          {catalog.isLoadingMore &&
            [0, 1, 2].map((key) => <Skeleton key={`more-${key}`} variant="rectangular" height={320} />)}
          {/* What the observer watches: it sits after the results, inside the same
              scroller, and spans the grid so it cannot be missed between columns. */}
          <Box ref={sentinelRef} sx={{ gridColumn: "1 / -1", height: 1 }} />
          {!catalog.isLoading && shown.length === 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              // Spans the grid, so "nothing found" is centred on the results area
              // rather than sitting in the first cell.
              sx={{ gridColumn: "1 / -1", textAlign: "center", py: 12 }}>
              {catalog.favouritesOnly ? t("catalog_no_favourites") : t("no_results")}
            </Typography>
          )}
        </Box>
      </Stack>
    </Stack>
  );
};

export default CatalogBody;
