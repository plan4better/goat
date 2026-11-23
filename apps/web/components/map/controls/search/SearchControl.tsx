import {
  Box,
  ClickAwayListener,
  Divider,
  Fab,
  IconButton,
  InputBase,
  LinearProgress,
  Paper,
  Tooltip,
  alpha,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { getFeature } from "@/lib/api/layers";
import type { LayerSearchGroup, LayerSearchResultItem } from "@/lib/api/processes";
import { MAPBOX_TOKEN } from "@/lib/constants";
import { setGeocoderResult, setPopupInfo } from "@/lib/store/map/slice";
import {
  popupFieldConfigOf,
  popupFieldInfo,
  selectPopupProperties,
  splitPopupProperties,
} from "@/lib/utils/map/popupProperties";

import type { Feature } from "@/types/map/controllers";

import { type SearchSource, useUnifiedSearch } from "@/hooks/map/useUnifiedSearch";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { layerPopup } from "@/components/map/popover/normalizePopup";
import MobileSearchOverlay from "@/components/map/controls/search/MobileSearchOverlay";
import SearchResultsList, {
  type SearchLayersById,
  type SearchRow,
  buildRows,
  searchOptionId,
} from "@/components/map/controls/search/SearchResultsList";

const CONTROL_WIDTH = 350;
const CONTROL_WIDTH_SM = 270;
const PANEL_MAX_HEIGHT = 420;
const MIN_QUERY_LENGTH = 2;
const PLACE_ZOOM = 15;

const COORDINATE_REGEX_STRING =
  "^[-+]?([1-8]?\\d(\\.\\d+)?|90(\\.0+)?),\\s*[-+]?(180(\\.0+)?|((1[0-7]\\d)|([1-9]?\\d))(\\.\\d+)?)";
const COORDINATE_REGEX = RegExp(COORDINATE_REGEX_STRING);

export const testForCoordinates = (query: string): [true, number, number] | [false, string] => {
  const isValid = COORDINATE_REGEX.test(query.trim());

  if (!isValid) {
    return [isValid, query];
  }

  const tokens = query.trim().split(",");

  return [isValid, Number(tokens[0]), Number(tokens[1])];
};

function buildCoordinateFeature(latitude: number, longitude: number): Feature {
  return {
    id: "",
    type: "Feature",
    place_type: ["coordinate"],
    relevance: 1,
    properties: {
      accuracy: "point",
    },
    text: "",
    place_name: `${latitude}, ${longitude}`,
    center: [longitude, latitude],
    geometry: {
      type: "Point",
      coordinates: [longitude, latitude],
      interpolated: false,
    },
    address: "",
    context: [],
  };
}

/**
 * Tags the camera moves triggered by a result selection with `eventData` on
 * the `movestart`/`moveend` events MapLibre fires for them, so a listener
 * elsewhere (the mobile drawer's occlusion-avoidance nudge) can tell "the
 * search control is flying somewhere" apart from a plain user gesture.
 */
export const SEARCH_CAMERA_EVENT_DATA = { searchSelection: true } as const;

export type SearchControlProps = {
  source: SearchSource;
  layersById: SearchLayersById;
  placeholder?: string;
  bbox?: number[];
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Fires when the results panel opens/closes. The card is translucent and
   * grows downward, so the host hides the other controls in its corner while
   * it is open instead of letting them shine through / get pushed around.
   */
  onPanelOpenChange?: (open: boolean) => void;
};

const SearchControl = ({
  source,
  layersById,
  placeholder,
  bbox,
  onExpandedChange,
  onPanelOpenChange,
}: SearchControlProps) => {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const dispatch = useAppDispatch();
  const { map } = useMap();

  const [collapsed, setCollapsed] = useState(true);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [mobileOverlayOpen, setMobileOverlayOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Invalidates in-flight feature lookups so a popup can never open after the
  // selection was superseded, cleared or escaped.
  const selectSeqRef = useRef(0);
  const listboxId = `search-results-${useId()}`;

  const getMapCenter = useCallback(() => {
    const center = map?.getCenter();
    return center ? { lng: center.lng, lat: center.lat } : undefined;
  }, [map]);

  const { query, setQuery, places, layerGroups, searching, clear } = useUnifiedSearch({
    source,
    accessToken: MAPBOX_TOKEN,
    getMapCenter,
    bbox,
    language: i18n.language,
  });

  useEffect(() => {
    return () => {
      dispatch(setGeocoderResult(null));
      onPanelOpenChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coordinateFeature = useMemo(() => {
    const result = testForCoordinates(query);
    if (!result[0]) return undefined;
    const [, latitude, longitude] = result;
    return buildCoordinateFeature(latitude, longitude);
  }, [query]);

  // A pasted coordinate replaces the result set with the single fly-to row,
  // matching the previous geocoder's behavior.
  const displayedPlaces = useMemo(
    () => (coordinateFeature ? [coordinateFeature] : places),
    [coordinateFeature, places]
  );
  const displayedGroups = useMemo(
    () => (coordinateFeature ? [] : layerGroups),
    [coordinateFeature, layerGroups]
  );
  const rows = useMemo(() => buildRows(displayedPlaces, displayedGroups), [displayedPlaces, displayedGroups]);

  const loading = searching;
  const panelOpen = !collapsed && !dismissed && query.trim().length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    onPanelOpenChange?.(panelOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  const handleExpand = () => {
    setCollapsed(false);
    setFocused(false);
    onExpandedChange?.(true);
  };

  const handleCollapse = () => {
    selectSeqRef.current += 1;
    setCollapsed(true);
    onExpandedChange?.(false);
  };

  const handleMobileOpen = () => {
    setMobileOverlayOpen(true);
    onExpandedChange?.(true);
  };

  const handleMobileClose = () => {
    selectSeqRef.current += 1;
    setMobileOverlayOpen(false);
    onExpandedChange?.(false);
  };

  const handleClear = () => {
    selectSeqRef.current += 1;
    clear();
    setActiveIndex(-1);
    setDismissed(false);
    dispatch(setGeocoderResult(null));
  };

  // The editor route mounts a single, persistent SearchControl across all
  // widths — resizing across the "md" breakpoint doesn't remount it. Without
  // this, a state left open on one side of the flip is stale on the other:
  // the desktop popper/expanded input never collapses (and never notifies
  // onExpandedChange) when the window narrows into mobile, and the overlay
  // that was open on mobile pops back up unprompted (with a dangling
  // "expanded" notification) when the window widens back into desktop.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (isMobile && !collapsed) {
      handleCollapse();
    } else if (!isMobile && mobileOverlayOpen) {
      handleMobileClose();
    }
    // Only react to the breakpoint flip itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  const handleSelectPlace = (feature: Feature) => {
    if (feature.bbox) {
      map?.fitBounds(
        feature.bbox,
        {
          padding: 40,
          maxZoom: PLACE_ZOOM,
          duration: 1000,
        },
        SEARCH_CAMERA_EVENT_DATA
      );
    } else if (feature.center) {
      map?.flyTo({ center: feature.center, zoom: PLACE_ZOOM }, SEARCH_CAMERA_EVENT_DATA);
    }
    dispatch(setGeocoderResult({ feature, label: feature.place_name }));
  };

  const handleSelectFeature = async (group: LayerSearchGroup, item: LayerSearchResultItem) => {
    const seq = selectSeqRef.current;
    const layerInfo = layersById.get(group.layer_id);
    if (item.centroid.length < 2) return;
    const [lng, lat] = item.centroid;
    const bounds = item.bbox;
    const isExtent = !!bounds && (bounds[2] - bounds[0] > 1e-7 || bounds[3] - bounds[1] > 1e-7);
    if (isExtent && bounds) {
      map?.fitBounds(
        [bounds[0], bounds[1], bounds[2], bounds[3]],
        {
          padding: 60,
          maxZoom: 17,
          duration: 1000,
        },
        SEARCH_CAMERA_EVENT_DATA
      );
    } else {
      map?.flyTo({ center: [lng, lat], zoom: 16, duration: 1000 }, SEARCH_CAMERA_EVENT_DATA);
    }
    // Without the owning project layer there is nothing to title or configure
    // the popup with; the camera move above still applies.
    if (!layerInfo) return;
    // Same gate the map-click path applies: a layer whose style shows no popup
    // must never open one, so a search result can't leak fields the popup hides.
    const popup = layerPopup(layerInfo.layer);
    if (!popup || popup.enabled === false) return;
    try {
      const feature = await getFeature(layerInfo.datasetId, String(item.id));
      if (selectSeqRef.current !== seq) return;
      const featureProperties = (feature?.properties ?? {}) as Record<string, unknown>;
      const fieldConfig = popupFieldConfigOf(popup);
      const { properties, jsonProperties } = splitPopupProperties(
        selectPopupProperties(fieldConfig, featureProperties)
      );
      dispatch(
        setPopupInfo({
          lngLat: [lng, lat],
          properties,
          jsonProperties,
          featureProperties,
          triggeredBy: "click",
          title: layerInfo.name,
          layerId: group.layer_id,
          projectLayerId: String(layerInfo.projectLayerId),
          ...popupFieldInfo(fieldConfig),
          onClose: () => dispatch(setPopupInfo(undefined)),
        })
      );
    } catch {
      // The camera already moved; the popup is best-effort.
    }
  };

  const selectRow = (row: SearchRow | undefined) => {
    if (!row) return;
    selectSeqRef.current += 1;
    setDismissed(true);
    setActiveIndex(-1);
    if (row.kind === "place") {
      handleSelectPlace(row.feature);
    } else {
      void handleSelectFeature(row.group, row.item);
    }
  };

  // Mobile selection closes the overlay right after kicking off the camera
  // move / popup fetch, so both land with the overlay already gone. Unlike
  // `handleMobileClose` this must not bump `selectSeqRef` again — `selectRow`
  // already bumped it for this selection.
  const selectMobileRow = (row: SearchRow) => {
    selectRow(row);
    setMobileOverlayOpen(false);
    onExpandedChange?.(false);
  };

  // Arrow/Enter handling shared by the desktop input and the mobile overlay's
  // input; only the "select" target and the Escape semantics differ.
  const handleNavigationKeyDown = (
    event: React.KeyboardEvent,
    select: (row: SearchRow | undefined) => void,
    canSelect: boolean
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rows.length === 0) return;
      setDismissed(false);
      setActiveIndex((index) => (index + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      setDismissed(false);
      setActiveIndex((index) => (index <= 0 ? rows.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!canSelect) return;
      select(rows[activeIndex >= 0 ? activeIndex : 0]);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) {
        handleClear();
      } else {
        handleCollapse();
      }
      return;
    }
    handleNavigationKeyDown(event, selectRow, panelOpen);
  };

  const handleMobileKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      // Two-step Escape, mirroring desktop: clear the query first, close the
      // overlay only once it's empty. The first press must not reach the
      // Dialog, whose own Escape handler would close it (discarding the query).
      if (!query) return;
      event.preventDefault();
      event.stopPropagation();
      handleClear();
      return;
    }
    handleNavigationKeyDown(
      event,
      (row) => {
        if (row) selectMobileRow(row);
      },
      rows.length > 0
    );
  };

  if (!map) return null;

  const fabSx = {
    backgroundColor: theme.palette.background.paper,
    color: theme.palette.action.active,
    "&:hover": {
      backgroundColor: theme.palette.background.default,
    },
    pointerEvents: "all",
  };

  if (isMobile) {
    return (
      <>
        <Tooltip title={t("search")} arrow placement="right">
          <Fab onClick={handleMobileOpen} size="small" sx={fabSx}>
            <Icon iconName={ICON_NAME.SEARCH} htmlColor="inherit" fontSize="small" />
          </Fab>
        </Tooltip>
        <MobileSearchOverlay
          open={mobileOverlayOpen}
          onClose={handleMobileClose}
          query={query}
          setQuery={(value) => {
            setQuery(value);
            setActiveIndex(-1);
            setDismissed(false);
          }}
          onClear={handleClear}
          rows={rows}
          layerGroups={displayedGroups}
          layersById={layersById}
          activeIndex={activeIndex}
          loading={loading}
          listboxId={listboxId}
          placeholder={placeholder || t("search_places_and_data")}
          onKeyDown={handleMobileKeyDown}
          onSelectPlace={(feature) => selectMobileRow({ kind: "place", feature })}
          onSelectFeature={(group, item) => selectMobileRow({ kind: "feature", group, item })}
        />
      </>
    );
  }

  if (collapsed) {
    return (
      <Tooltip title={t("search")} arrow placement="right">
        <Fab onClick={handleExpand} size="small" sx={fabSx}>
          <Icon iconName={ICON_NAME.SEARCH} htmlColor="inherit" fontSize="small" />
        </Fab>
      </Tooltip>
    );
  }

  const iconColor = focused ? theme.palette.primary.main : theme.palette.action.active;

  return (
    <Box
      sx={{
        marginTop: theme.spacing(1),
        marginBottom: theme.spacing(1),
        pointerEvents: "all",
      }}>
      <ClickAwayListener onClickAway={() => setDismissed(true)}>
        <Paper
          elevation={0}
          sx={{
            width: CONTROL_WIDTH,
            overflow: "hidden",
            // Match the FloatingPanel surface used by the map side panels
            // (apps/web/components/common/FloatingPanel.tsx). Input and
            // results share ONE card, Google-Maps style.
            backgroundColor: alpha(theme.palette.background.paper, 0.9),
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            borderRadius: "1rem",
            boxShadow: "rgba(0, 0, 0, 0.2) 0px 0px 10px",
            [theme.breakpoints.down("sm")]: {
              width: CONTROL_WIDTH_SM,
            },
          }}>
          <Box
            sx={{
              padding: theme.spacing(0.5),
              display: "flex",
              alignItems: "center",
            }}>
        <Icon
          iconName={ICON_NAME.SEARCH}
          fontSize="small"
          sx={{ color: iconColor, margin: theme.spacing(2) }}
        />
        <Divider sx={{ height: 28, margin: theme.spacing(0.5) }} orientation="vertical" />
        <InputBase
          inputRef={inputRef}
          autoFocus
          fullWidth
          sx={{ marginLeft: theme.spacing(1), flex: 1, padding: 0 }}
          placeholder={placeholder || t("search_places_and_data")}
          inputProps={{
            role: "combobox",
            "aria-label": t("search"),
            "aria-expanded": panelOpen,
            "aria-controls": listboxId,
            "aria-autocomplete": "list",
            ...(panelOpen && activeIndex >= 0 && activeIndex < rows.length
              ? { "aria-activedescendant": searchOptionId(listboxId, activeIndex) }
              : {}),
          }}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
            setDismissed(false);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setFocused(true);
            setDismissed(false);
          }}
          onBlur={() => setFocused(false)}
        />
        {query ? (
          <IconButton
            type="button"
            aria-label={t("clear")}
            sx={{ padding: theme.spacing(1) }}
            onClick={handleClear}>
            <Icon
              iconName={ICON_NAME.CLOSE}
              fontSize="small"
              sx={{ color: iconColor, margin: theme.spacing(2) }}
            />
          </IconButton>
        ) : (
          <IconButton
            type="button"
            aria-label={t("collapse")}
            sx={{ padding: theme.spacing(1) }}
            onClick={handleCollapse}>
            <Icon
              iconName={ICON_NAME.CHEVRON_LEFT}
              fontSize="small"
              sx={{ color: iconColor, margin: theme.spacing(2) }}
            />
          </IconButton>
        )}
          </Box>
          {panelOpen && (
            <>
              {/* Fixed-height slot; overflow:hidden also stops the themed
                  Divider's vertical margin from collapsing out of the box
                  (which grew the card by 8px whenever the divider showed). */}
              <Box sx={{ height: 2, flex: "none", overflow: "hidden" }}>
                {loading ? <LinearProgress sx={{ height: 2 }} /> : <Divider sx={{ my: 0 }} />}
              </Box>
              <Box sx={{ maxHeight: PANEL_MAX_HEIGHT, overflowY: "auto" }}>
                <SearchResultsList
                  query={query}
                  rows={rows}
                  layerGroups={displayedGroups}
                  layersById={layersById}
                  activeIndex={activeIndex}
                  loading={loading}
                  listboxId={listboxId}
                  onSelectPlace={(feature) => selectRow({ kind: "place", feature })}
                  onSelectFeature={(group, item) => selectRow({ kind: "feature", group, item })}
                />
              </Box>
            </>
          )}
        </Paper>
      </ClickAwayListener>
    </Box>
  );
};

export default SearchControl;
