import {
  Box,
  Divider,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { LayerSearchGroup, LayerSearchResultItem } from "@/lib/api/processes";
import { match, parse } from "@/lib/utils/match";
import { popupFieldConfigOf } from "@/lib/utils/map/popupProperties";

import type { Feature } from "@/types/map/controllers";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { layerPopup } from "@/components/map/popover/normalizePopup";

export type SearchLayerInfo = {
  projectLayerId: number;
  datasetId: string;
  name: string;
  /** Layer-style icon node (same as the popup header); header shows nothing when absent. */
  icon?: React.ReactNode;
  /**
   * The owning project layer, so a selected result can honour the same popup
   * configuration (enabled/trigger, field list) the map-click path honours.
   */
  layer: MapLayer;
};

/** Dataset UUID → project layer info, keyed the same way `LayerSearchGroup.layer_id` is. */
export type SearchLayersById = Map<string, SearchLayerInfo>;

export type SearchRow =
  | { kind: "place"; feature: Feature }
  | { kind: "feature"; group: LayerSearchGroup; item: LayerSearchResultItem };

/**
 * Flatten the grouped results into the single roving-index order the keyboard
 * navigation walks: places first, then each layer group's results in order.
 */
export function buildRows(places: Feature[], layerGroups: LayerSearchGroup[]): SearchRow[] {
  return [
    ...places.map((feature) => ({ kind: "place", feature }) as const),
    ...layerGroups.flatMap((group) =>
      group.results.map((item) => ({ kind: "feature", group, item }) as const)
    ),
  ];
}

export function searchOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

const MIN_QUERY_LENGTH = 2;

type HighlightedTextProps = {
  text: string;
  query: string;
  variant?: "body2" | "caption";
  /** Render inline (for nesting inside another text line). */
  inline?: boolean;
};

const HighlightedText = ({ text, query, variant = "body2", inline }: HighlightedTextProps) => {
  // insideWords: the backend matches substrings anywhere (ILIKE %q%), so the
  // highlight must too — "erw" matches inside "Oberwinter".
  const parts = parse(text, match(text, query, { insideWords: true }));
  return (
    <Typography
      noWrap={!inline}
      variant={variant}
      color={variant === "caption" ? "text.secondary" : undefined}
      component={variant === "caption" ? "span" : "p"}
      sx={{
        display: inline ? "inline" : "block",
        ...(!inline && { textOverflow: "ellipsis", overflow: "hidden" }),
        ...(variant === "caption" && { fontSize: 12.5 }),
      }}>
      {parts.map((part, index) => (
        <Typography
          key={index}
          component="span"
          variant="inherit"
          sx={{ fontWeight: part.highlight ? 700 : variant === "caption" ? 400 : 500 }}>
          {part.text}
        </Typography>
      ))}
    </Typography>
  );
};

/**
 * Mapbox v5 anatomy: `text` is the feature's own name, `place_name` is the full
 * hierarchy ("<text>, <address/postcode/place/country…>") and `context[]` holds
 * the structured parents. Title = own name; subtitle = the rest, when there is
 * one (country-level results have none).
 */
function splitPlaceName(feature: Feature): { title: string; subtitle: string } {
  const title = feature.text || feature.place_name;
  let subtitle = "";
  if (feature.place_name?.startsWith(`${title}, `)) {
    subtitle = feature.place_name.slice(title.length + 2);
  } else if (feature.context?.length) {
    subtitle = feature.context.map((c) => c.text).join(", ");
  }
  return { title, subtitle };
}

type GroupHeaderProps = {
  label: string;
  /** Layer-style icon node — same affordance the popup header uses. */
  icon?: React.ReactNode;
};

const GroupHeader = ({ label, icon }: GroupHeaderProps) => {
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      role="presentation"
      sx={{
        px: 2,
        pt: 1.5,
        pb: 0.75,
        color: theme.palette.text.secondary,
      }}>
      {icon !== undefined && (
        <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{icon}</Box>
      )}
      <Typography
        variant="caption"
        sx={{ fontWeight: 700, fontSize: 12.5, letterSpacing: 0.3 }}
        noWrap>
        {label}
      </Typography>
    </Stack>
  );
};

/** Pin badge anchoring place rows (tinted rounded square, mock-style). */
const PlaceBadge = () => {
  const theme = useTheme();
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        flex: "none",
        borderRadius: 1.5,
        backgroundColor: theme.palette.action.hover,
      }}>
      <Icon
        iconName={ICON_NAME.LOCATION_MARKER}
        htmlColor={theme.palette.primary.main}
        sx={{ fontSize: 14 }}
      />
    </Box>
  );
};

export type SearchResultsListProps = {
  query: string;
  /** Flat roving-index order, built once by the owning control. */
  rows: SearchRow[];
  /**
   * All layer groups for the current query, including ones with zero results
   * (which `rows` never carries, since it only flattens actual result items).
   * Needed to surface a timed-out layer's header even when it found nothing.
   */
  layerGroups: LayerSearchGroup[];
  layersById: SearchLayersById;
  activeIndex: number;
  loading?: boolean;
  listboxId: string;
  onSelectPlace: (feature: Feature) => void;
  onSelectFeature: (group: LayerSearchGroup, item: LayerSearchResultItem) => void;
};

const SearchResultsList = ({
  query,
  rows,
  layerGroups,
  layersById,
  activeIndex,
  loading,
  listboxId,
  onSelectPlace,
  onSelectFeature,
}: SearchResultsListProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  // Field labels from each layer's popup config, so a matched value is prefixed
  // with the same vocabulary the popup shows. Raw column names are upload-time
  // internals the viewer has never seen, and a custom-HTML popup has no field
  // list at all — without a label the matched value stands alone.
  const fieldLabelsByLayer = useMemo(() => {
    const labels = new Map<string, Record<string, string>>();
    layersById.forEach((info, layerId) => {
      if (info.layer) labels.set(layerId, popupFieldConfigOf(layerPopup(info.layer)).fieldLabels);
    });
    return labels;
  }, [layersById]);

  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, rows]);

  // A group that timed out (or errored) before finding anything never
  // contributes a row — `rows` is built purely from `group.results` — so it
  // needs its own, non-selectable header+caption pair rendered outside the row
  // loop below.
  const unavailableEmptyGroups = layerGroups.filter(
    (group) => (group.timed_out || !!group.error) && group.results.length === 0
  );

  // Only claim "no results" once the search has actually finished — while
  // debouncing/fetching the panel shows just the progress bar.
  const showNoResults =
    rows.length === 0 &&
    unavailableEmptyGroups.length === 0 &&
    !loading &&
    query.trim().length >= MIN_QUERY_LENGTH;

  // Screen-reader announcement for the result set. Only the row count, the
  // no-results state and the unavailable-layer state are worth announcing.
  const announcement =
    rows.length > 0
      ? t("search_results_count", { count: rows.length })
      : showNoResults
        ? t("no_results")
        : unavailableEmptyGroups.length > 0
          ? unavailableEmptyGroups.some((group) => group.timed_out)
            ? t("search_layer_unavailable")
            : t("search_layer_error")
          : "";

  const liveRegion = (
    <Box component="span" aria-live="polite" aria-atomic="true" sx={visuallyHidden}>
      {announcement}
    </Box>
  );

  if (rows.length === 0 && unavailableEmptyGroups.length === 0) {
    return (
      <>
        {liveRegion}
        <Box role="listbox" id={listboxId}>
          {showNoResults && (
            <Stack
              role="presentation"
              alignItems="center"
              spacing={1}
              sx={{ px: 2, py: 4, color: theme.palette.text.secondary }}>
              <Icon iconName={ICON_NAME.SEARCH} htmlColor="inherit" sx={{ fontSize: 20, opacity: 0.5 }} />
              <Typography variant="body1">{t("no_results")}</Typography>
            </Stack>
          )}
        </Box>
      </>
    );
  }

  const renderRow = (
    index: number,
    badge: React.ReactNode,
    primary: React.ReactNode,
    secondary: React.ReactNode,
    onClick: () => void
  ) => (
    <ListItemButton
      key={searchOptionId(listboxId, index)}
      id={searchOptionId(listboxId, index)}
      role="option"
      // Keyboard navigation is driven by the combobox input's roving
      // aria-activedescendant, so the rows themselves stay out of the Tab order.
      tabIndex={-1}
      aria-selected={index === activeIndex}
      ref={(node: HTMLDivElement | null) => {
        if (node) {
          rowRefs.current.set(index, node);
        } else {
          rowRefs.current.delete(index);
        }
      }}
      selected={index === activeIndex}
      onClick={onClick}
      sx={{
        px: 2,
        py: 1,
        gap: 1.5,
        minHeight: 48,
        transition: "background-color 100ms",
        // Same hover/selected treatment as the layer panel rows
        // (DraggableTreeView.tsx): action.hover / primary tint.
        "&:hover": {
          backgroundColor: theme.palette.action.hover,
        },
        "&.Mui-selected, &.Mui-selected:hover": {
          backgroundColor: alpha(theme.palette.primary.main, 0.08),
        },
      }}>
      {badge}
      <ListItemText primary={primary} secondary={secondary} sx={{ my: 0, overflow: "hidden" }} />
    </ListItemButton>
  );

  const elements: React.ReactNode[] = [];
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    const next = rows[index + 1];

    if (row.kind === "place") {
      if (!previous) {
        elements.push(<GroupHeader key="places-header" label={t("places")} />);
      }
      const { title, subtitle } = splitPlaceName(row.feature);
      elements.push(
        renderRow(
          index,
          <PlaceBadge />,
          <HighlightedText text={title} query={query} />,
          subtitle ? <HighlightedText text={subtitle} query={query} variant="caption" /> : null,
          () => onSelectPlace(row.feature)
        )
      );
      return;
    }

    const layerInfo = layersById.get(row.group.layer_id);
    const layerName = layerInfo?.name ?? t("layer");
    const startsGroup =
      !previous || previous.kind !== "feature" || previous.group.layer_id !== row.group.layer_id;
    if (startsGroup) {
      if (previous) elements.push(<Divider key={`divider-${index}`} />);
      elements.push(
        <GroupHeader key={`header-${row.group.layer_id}`} label={layerName} icon={layerInfo?.icon} />
      );
    }

    const label = row.item.label || row.item.matched_value;
    const matchedElsewhere = !!row.item.label && row.item.label !== row.item.matched_value;
    const matchedFieldLabel = fieldLabelsByLayer.get(row.group.layer_id)?.[row.item.matched_column];
    // When the title itself matched, fall back to the other searched columns'
    // values as context (mock behavior: rows always carry a secondary line
    // when there is anything meaningful to show).
    const contextValues = matchedElsewhere
      ? undefined
      : Object.values(row.item.values ?? {})
          .filter((value): value is string => !!value && value !== label)
          .slice(0, 2)
          .join(" · ");
    elements.push(
      renderRow(
        index,
        null,
        <HighlightedText text={label} query={query} />,
        matchedElsewhere ? (
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            component="span"
            sx={{ fontSize: 12.5 }}>
            {matchedFieldLabel ? `${matchedFieldLabel}: ` : ""}
            <HighlightedText text={row.item.matched_value} query={query} variant="caption" inline />
          </Typography>
        ) : contextValues ? (
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            component="span"
            sx={{ fontSize: 12.5 }}>
            {contextValues}
          </Typography>
        ) : null,
        () => onSelectFeature(row.group, row.item)
      )
    );

    const endsGroup = !next || next.kind !== "feature" || next.group.layer_id !== row.group.layer_id;
    if (endsGroup && row.group.timed_out) {
      elements.push(
        <Typography
          key={`timed-out-${row.group.layer_id}`}
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", px: 2, pb: 1 }}>
          {t("search_layer_unavailable")}
        </Typography>
      );
    }
  });

  unavailableEmptyGroups.forEach((group) => {
    const layerInfo = layersById.get(group.layer_id);
    if (elements.length > 0) elements.push(<Divider key={`divider-empty-${group.layer_id}`} />);
    elements.push(
      <GroupHeader
        key={`header-empty-${group.layer_id}`}
        label={layerInfo?.name ?? t("layer")}
        icon={layerInfo?.icon}
      />
    );
    elements.push(
      <Typography
        key={`unavailable-empty-${group.layer_id}`}
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", px: 2, pb: 1 }}>
        {group.timed_out ? t("search_layer_unavailable") : t("search_layer_error")}
      </Typography>
    );
  });

  return (
    <>
      {liveRegion}
      <Box role="listbox" id={listboxId}>
        {elements}
      </Box>
    </>
  );
};

export default SearchResultsList;
