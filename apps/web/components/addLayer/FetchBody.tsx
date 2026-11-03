"use client";

import ErrorOutlineOutlined from "@mui/icons-material/ErrorOutlineOutlined";
import {
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  ClickAwayListener,
  Divider,
  IconButton,
  Link,
  Paper,
  Popper,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  TextField,
  type Theme,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  alpha,
  darken,
  getContrastRatio,
  useTheme,
} from "@mui/material";
import turfArea from "@turf/area";
import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type MirrorValue, getMirrorColumns, getMirrorSample, getMirrorValues } from "@/lib/api/processes";
import { BUFFER_STEP_KM, MAX_BUFFER_KM, MIN_BUFFER_KM } from "@/lib/catalog/spatial";

import type { SelectorItem } from "@/types/map/common";

import {
  type AreaMode,
  type FetchFlow,
  type Geometry,
  MAX_FEATURES,
  MAX_FILTERED_READ_FEATURES,
  MAX_READ_FEATURES,
  OSM_TYPES,
  OVERTURE_THEMES,
  type TagFilter,
  isNetworkSource,
  operatorOf,
  roundBox,
  sqlColumn,
} from "@/hooks/addLayer/useFetchFlow";

import UploadDestinationPill from "@/components/addLayer/UploadDestinationPill";
import {
  type SpatialPicker,
  SpatialPickerMap,
  SpatialRegionChips,
  SpatialRegionSearch,
  useSpatialPicker,
} from "@/components/dashboard/catalog/CatalogSpatialPicker";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import SegmentedControl from "@/components/map/panels/common/SegmentedControl";
import Selector from "@/components/map/panels/common/Selector";
import SliderInput from "@/components/map/panels/common/SliderInput";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
/**
 * How far in from the preview's edges the map-view box is drawn, in pixels. Deeper at the
 * bottom, where the estimate sits: the chip must never cover the box or its area.
 */
const VIEW_INSET = { top: 20, side: 20, bottom: 62 };

/**
 * The too-large colour: the theme's warning colour, darkened in light mode until it reads on
 * the paper at 4.5:1 (the plain one is too pale on white). Dark mode keeps it as it is.
 */
const sizeWarningColor = (theme: Theme) => {
  const paper = theme.palette.background.paper;
  let color = theme.palette.warning.main;
  if (theme.palette.mode === "dark") return color;
  for (let step = 0; step < 12 && getContrastRatio(color, paper) < 4.5; step += 1)
    color = darken(color, 0.08);
  return color;
};

/**
 * A section of the settings column, drawn as a tool's section is: so the column can move into
 * the toolbox as it is.
 */
const Section = ({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ICON_NAME;
  children: React.ReactNode;
}) => (
  <Box>
    <SectionHeader label={label} icon={icon} active alwaysActive disableAdvanceOptions />
    <SectionOptions active baseOptions={<Stack spacing={3}>{children}</Stack>} />
  </Box>
);

/** A small grey label over a control, as the tool panels label theirs. */
const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
    {children}
  </Typography>
);

/**
 * One question to the mirror, remembered for the area it was asked about.
 *
 * With `prefetch` it is asked as soon as the area stops changing, and an OSM key list
 * comes in two steps: a quick sample to pick from at once, then the full read with counts.
 */
const useTagOptions = (flow: FetchFlow["fetch"], key?: string, prefetch = false) => {
  const [options, setOptions] = useState<MirrorValue[]>([]);
  const [loading, setLoading] = useState(false);
  const [counting, setCounting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sampled, setSampled] = useState(false);
  const askedFor = useRef<string | null>(null);
  const question = flow.area ? JSON.stringify([flow.area, flow.source, flow.featureType, key ?? null]) : null;
  // What the list is a list of. Only a change here empties it: a new area keeps showing
  // the last answer until its own arrives, since a pan rarely changes the values much.
  const subject = JSON.stringify([flow.source, flow.featureType, key ?? null]);
  const shownFor = useRef(subject);

  const load = useCallback(() => {
    if (!question || !flow.area || askedFor.current === question) return;
    askedFor.current = question;
    const current = question;
    const area = flow.area;
    setLoading(true);
    setFailed(false);
    const ask = (quick: boolean) => getMirrorValues(area, flow.featureType, key, 200, flow.source, quick);
    const full = () =>
      ask(false)
        .then((result) => {
          if (askedFor.current !== current) return;
          setOptions(result.values ?? []);
          setSampled(!!result.sampled);
        })
        .catch((error) => {
          console.error("mirror-values failed", error);
          if (askedFor.current === current) setFailed(true);
        })
        .finally(() => {
          if (askedFor.current !== current) return;
          setLoading(false);
          setCounting(false);
        });
    // One after the other, and the full read only if the area is still the
    // one asked about: a pan would otherwise leave two requests per view
    // running on a server that answers four at a time.
    setCounting(true);
    ask(true)
      .then((result) => {
        if (askedFor.current !== current) return;
        setOptions(result.values ?? []);
        setLoading(false);
        // The lists read capped samples, so their numbers are no estimate of the area: only the
        // size check sets that. Final: the quick read saw the whole area, or a big view's list came
        // from the mirror's own counts (shown without numbers).
        if (result.complete) {
          setSampled(false);
          setCounting(false);
          return;
        }
        void full();
      })
      .catch(() => {
        if (askedFor.current === current) void full();
      });
  }, [question, flow, key]);
  const latestLoad = useRef(load);
  latestLoad.current = load;

  // Keyed on the question's text alone: the area arrives as a new object on every
  // render, and reacting to that restarted the wait on each re-render and could
  // send the same question twice.
  const askedQuestion = useRef(question);
  useEffect(() => {
    // A new question forgets the last ask; the list starting to be watched (the picker opening)
    // keeps it, so a list asked for on the click is not asked for again.
    if (askedQuestion.current !== question) {
      askedQuestion.current = question;
      askedFor.current = null;
      setCounting(false);
      setLoading(false);
    }
    if (shownFor.current !== subject) {
      shownFor.current = subject;
      setOptions([]);
      setSampled(false);
    }
    if (!prefetch || !question || askedFor.current === question) return;
    // The map view changes on every pan; wait until it rests before asking.
    const timer = setTimeout(() => latestLoad.current(), 800);
    return () => clearTimeout(timer);
  }, [question, prefetch, subject]);

  return { options, loading, counting, failed, sampled, load };
};

const AREA_MODES: AreaMode[] = ["view", "region", "point", "polygon"];

/** A small action beside a control, as the tool panels draw theirs: an icon with its name on hover. */
const AreaAction = ({
  label,
  icon,
  danger,
  onClick,
  href,
}: {
  label: string;
  icon: ICON_NAME;
  danger?: boolean;
  onClick?: () => void;
  /** Opens a page in a new tab instead of acting here. */
  href?: string;
}) => {
  const theme = useTheme();
  return (
    <Tooltip title={label} placement="top">
      <IconButton
        size="small"
        aria-label={label}
        onClick={onClick}
        {...(href ? { component: "a", href, target: "_blank", rel: "noopener noreferrer" } : {})}
        sx={{ p: 0.5, "&:hover": { color: danger ? theme.palette.error.main : theme.palette.primary.main } }}>
        <Icon iconName={icon} style={{ fontSize: ICON_SIZE.medium }} htmlColor="inherit" />
      </IconButton>
    </Tooltip>
  );
};

/** How the area is chosen, and what that way needs: the map beside it is where it is picked. */
const AreaSettings = ({ flow, picker }: { flow: FetchFlow["fetch"]; picker: SpatialPicker }) => {
  const { t, i18n } = useTranslation("common");
  const items: SelectorItem[] = AREA_MODES.map((mode) => ({
    value: mode,
    label: t(`fetch_features_area_mode_${mode}`),
  }));
  const point = picker.value?.kind === "point" ? picker.value : null;
  const coordinate = (value: number) =>
    value.toLocaleString(i18n.language, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return (
    <>
      <Selector
        label={t("fetch_features_area_by")}
        items={items}
        selectedItems={items.find((item) => item.value === flow.areaMode)}
        setSelectedItems={(item) => {
          const next = !Array.isArray(item) && item ? (item.value as AreaMode) : undefined;
          if (next) flow.setAreaMode(next);
        }}
      />
      {flow.areaMode === "view" && (
        <Typography variant="caption" color="text.secondary">
          {t("fetch_features_area_view_hint")}
        </Typography>
      )}
      {flow.areaMode === "region" && (
        <Box>
          <FieldLabel>{t("fetch_features_area_region")}</FieldLabel>
          <SpatialRegionSearch picker={picker} label={t("fetch_features_area_region")} />
          <Box sx={{ mt: picker.regionIds.length ? 2 : 0 }}>
            <SpatialRegionChips picker={picker} />
          </Box>
        </Box>
      )}
      {flow.areaMode === "point" && (
        <>
          <Box>
            <FieldLabel>{t("fetch_features_area_centre")}</FieldLabel>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ minHeight: 30 }}>
              <Typography variant="body2" color={point ? "text.primary" : "text.secondary"} sx={{ flex: 1 }}>
                {point
                  ? `${coordinate(point.lat)}, ${coordinate(point.lng)}`
                  : t("fetch_features_area_pick_on_map")}
              </Typography>
              {point && (
                <AreaAction
                  label={t("clear_all")}
                  icon={ICON_NAME.TRASH}
                  danger
                  onClick={() => picker.onChange(null)}
                />
              )}
            </Stack>
          </Box>
          <Box>
            <FieldLabel>{t("fetch_features_area_radius")}</FieldLabel>
            <SliderInput
              value={picker.buffer}
              isRange={false}
              min={MIN_BUFFER_KM}
              max={MAX_BUFFER_KM}
              step={BUFFER_STEP_KM}
              onChange={(next) => picker.changeBuffer(next as number)}
              rootSx={{ pl: 1 }}
            />
          </Box>
        </>
      )}
      {flow.areaMode === "polygon" && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ minHeight: 30 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            {picker.hint}
          </Typography>
          {picker.polygonVertices > 0 && (
            <>
              <AreaAction label={t("undo")} icon={ICON_NAME.UNDO} onClick={picker.undoVertex} />
              <AreaAction
                label={t("clear_all")}
                icon={ICON_NAME.TRASH}
                danger
                onClick={() => picker.onChange(null)}
              />
            </>
          )}
        </Stack>
      )}
    </>
  );
};

/** The area on a map that fills its side: the map view is the area, other ways pick it on the map. */
const AreaMap = ({ flow, picker }: { flow: FetchFlow["fetch"]; picker: SpatialPicker }) => {
  const theme = useTheme();
  // The area follows the one size state, as the estimate and the button do: grey until the first
  // answer, then green, or orange while the area holds more than a fetch takes.
  const shapeColor =
    flow.sizeState === "too_big"
      ? sizeWarningColor(theme)
      : flow.sizeState === "ok"
        ? theme.palette.primary.main
        : theme.palette.text.secondary;
  const isView = flow.areaMode === "view";
  // Another way opens framed on its own area; only the map view needs the box.
  const [initialViewState] = useState(() =>
    isView && flow.viewBox
      ? {
          bounds: flow.viewBox,
          fitBoundsOptions: {
            padding: {
              top: VIEW_INSET.top,
              bottom: VIEW_INSET.bottom,
              left: VIEW_INSET.side,
              right: VIEW_INSET.side,
            },
          },
        }
      : undefined
  );

  // The box drawn over the map, not the map's own edges: what is fetched is what the box shows.
  const measure = (event: { target: MaplibreMap; originalEvent?: unknown }) => {
    const map = event.target;
    const { clientWidth, clientHeight } = map.getContainer();
    const sw = map.unproject([VIEW_INSET.side, clientHeight - VIEW_INSET.bottom]);
    const ne = map.unproject([clientWidth - VIEW_INSET.side, VIEW_INSET.top]);
    const next = roundBox([sw.lng, sw.lat, ne.lng, ne.lat]);
    // Only a person moving the map chooses the view; a fit to another area does not.
    if (next.join() !== flow.viewBox?.join() || event.originalEvent)
      flow.setViewBox(next, !!event.originalEvent);
  };

  return (
    <SpatialPickerMap
      picker={picker}
      mapId="fetch-features-preview"
      initialViewState={initialViewState}
      geometry={isView || picker.value ? undefined : flow.area}
      shapeColor={shapeColor}
      onMoveEnd={measure}
      onLoad={measure}
      frameEdits
      sx={{ flex: 1, minHeight: 280 }}
      overlay={
        <>
          {isView && (
            <Box
              data-size-state={flow.sizeState}
              data-testid="view-box"
              sx={{
                position: "absolute",
                top: VIEW_INSET.top,
                left: VIEW_INSET.side,
                right: VIEW_INSET.side,
                bottom: VIEW_INSET.bottom,
                pointerEvents: "none",
                border: `2px dashed ${shapeColor}`,
                borderRadius: 1,
                // Only a hint of fill: on a light basemap more reads as a tinted veil.
                backgroundColor: alpha(shapeColor, theme.palette.mode === "light" ? 0.04 : 0.06),
              }}
            />
          )}
          <EstimateChip flow={flow} />
        </>
      }
    />
  );
};

/**
 * How much the area holds against what a fetch takes: a small chip over the map. While a new
 * count is on its way the last one stays, dimmed, so panning does not flash anything.
 */
const EstimateChip = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const number = (value: number) => value.toLocaleString(i18n.language);
  const isNetwork = isNetworkSource(flow.source);
  const km2 = useMemo(
    () =>
      flow.area ? Math.round(turfArea({ type: "Feature", geometry: flow.area, properties: {} }) / 1e6) : 0,
    [flow.area]
  );
  const pending = flow.sizePending;
  // What the chip says is taken from an answer and kept until the next one: while a new size is
  // on its way the last text and its state stay, dimmed, so a move between two large areas
  // changes nothing and nothing flashes.
  const fresh = (() => {
    const tooMany = !isNetwork && flow.estimate != null && flow.estimate > MAX_FEATURES;
    const count = isNetwork
      ? t("fetch_features_network_size", { km2: number(km2) })
      : flow.matchPending
        ? t("fetch_features_matches_counting")
        : flow.matches != null && flow.matches > MAX_FEATURES
          ? t("fetch_features_matches_over", { limit: number(MAX_FEATURES) })
          : flow.matches != null
            ? flow.matchesBound
              ? // A bound from whole countries, far above the area's own count: only that it fits.
                t("fetch_features_matches_fit")
              : t("fetch_features_matches", { count: flow.matches, formatted: number(flow.matches) })
            : flow.estimate == null
              ? t("fetch_features_estimate_counting")
              : tooMany
                ? // Past the limit an exact count says nothing a fetch could use.
                  t("fetch_features_estimate_over", {
                    limit: number(
                      flow.beyondFilters
                        ? MAX_FILTERED_READ_FEATURES
                        : flow.tooLarge
                          ? MAX_READ_FEATURES
                          : MAX_FEATURES
                    ),
                  })
                : t("fetch_features_estimate", { count: flow.estimate, formatted: number(flow.estimate) });
    const warning = flow.sizeState === "too_big";
    const after = warning
      ? t(
          isNetwork
            ? "fetch_features_network_limit"
            : flow.beyondFilters
              ? "fetch_features_too_large_hint"
              : flow.tooLarge
                ? "fetch_features_too_large_filters_hint"
                : "fetch_features_too_many_hint"
        )
      : isNetwork
        ? t("fetch_features_network_limit")
        : flow.estimate == null
          ? ""
          : t("fetch_features_limit", { limit: number(MAX_FEATURES) });
    return { count, after, warning };
  })();
  // Measured, not guessed: the attribution's height changes with the map's width and text.
  const chip = useRef<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState(28);
  useEffect(() => {
    const credit = chip.current?.parentElement?.querySelector<HTMLElement>("[data-catalog-attribution]");
    if (!credit) return;
    const measure = () => setBottom(credit.offsetHeight + 10);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(credit);
    return () => observer.disconnect();
  }, [flow.area]);
  const warningColor = sizeWarningColor(theme);
  const shownRef = useRef<typeof fresh | null>(null);
  if (!pending || !shownRef.current) shownRef.current = fresh;
  const shown = pending ? shownRef.current : fresh;
  if (!flow.area) return null;
  return (
    <Box
      ref={chip}
      role="status"
      data-size-state={flow.sizeState}
      sx={{
        position: "absolute",
        left: VIEW_INSET.side,
        bottom,
        zIndex: 2,
        maxWidth: `calc(100% - ${2 * VIEW_INSET.side}px)`,
        px: 2,
        py: 1,
        borderRadius: 1.5,
        backgroundColor: theme.palette.background.paper,
        // GOAT's soft card shadow (theme.shadows[6], as on Card), not MUI's stock elevation.
        boxShadow: theme.shadows[6],
        pointerEvents: "none",
      }}>
      <Typography
        variant="caption"
        fontWeight="fontWeightMedium"
        color={shown.warning ? warningColor : "text.primary"}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          fontVariantNumeric: "tabular-nums",
          // Only the text fades while a new size is on its way; the chip stays as it is.
          opacity: pending ? 0.55 : 1,
          transition: "opacity 150ms",
        }}>
        {shown.warning && <ErrorOutlineOutlined sx={{ fontSize: ICON_SIZE.medium }} />}
        <span>
          {shown.count}
          {shown.after && (
            <Box
              component="span"
              sx={{
                color: shown.warning ? warningColor : "text.secondary",
                fontWeight: shown.warning ? 600 : 400,
              }}>
              {` · ${shown.after}`}
            </Box>
          )}
        </span>
      </Typography>
    </Box>
  );
};

const GEOMETRY_ICONS: Record<Geometry, ICON_NAME> = {
  point: ICON_NAME.POINT_FEATURE,
  line: ICON_NAME.LINE_FEATURE,
  polygon: ICON_NAME.POLYGON_FEATURE,
};

const GEOMETRIES: Geometry[] = ["point", "line", "polygon"];

const OSM_GEOMETRY: Record<(typeof OSM_TYPES)[number], Geometry> = {
  points: "point",
  lines: "line",
  multipolygons: "polygon",
};

/** Ready-made filters for the commonest asks, on the keys each source files them under. */
const QUICK_PICKS: Record<"osm" | "overture", { id: string; key: string; values: string[] }[]> = {
  osm: [
    { id: "schools", key: "amenity", values: ["school"] },
    { id: "kindergartens", key: "amenity", values: ["kindergarten"] },
    { id: "stops", key: "public_transport", values: ["platform"] },
    { id: "supermarkets", key: "shop", values: ["supermarket"] },
    { id: "doctors", key: "amenity", values: ["doctors", "clinic"] },
    { id: "parks", key: "leisure", values: ["park"] },
  ],
  overture: [
    { id: "food", key: "category", values: ["restaurant", "cafe", "bar", "fast_food_restaurant", "bakery"] },
    { id: "health", key: "category", values: ["hospital", "doctor", "pharmacy", "dentist"] },
    { id: "education", key: "category", values: ["school", "college_university", "preschool"] },
    { id: "shopping", key: "category", values: ["supermarket", "grocery_store", "shopping_center"] },
    { id: "transit", key: "category", values: ["bus_station", "train_station", "metro_station"] },
  ],
};

/** Which layer of the source: a geometry for OSM, a theme and its geometry for Overture. */
const FeatureChoice = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const geometryItems = (options: Geometry[]): SelectorItem[] =>
    options.map((geometry) => ({
      value: geometry,
      label: t(`fetch_features_geometry_${geometry}`),
      icon: GEOMETRY_ICONS[geometry],
    }));
  if (flow.source === "osm") {
    const byGeometry = Object.fromEntries(OSM_TYPES.map((type) => [OSM_GEOMETRY[type], type]));
    return (
      <SegmentedControl
        label={t("geometry_type")}
        items={geometryItems(GEOMETRIES)}
        value={OSM_GEOMETRY[flow.osmType as (typeof OSM_TYPES)[number]]}
        onChange={(geometry) => flow.setOsmType(byGeometry[geometry as Geometry])}
      />
    );
  }
  const current = OVERTURE_THEMES.find((entry) => Object.values(entry.types).includes(flow.overtureType));
  const geometries = current ? GEOMETRIES.filter((g) => current.types[g]) : [];
  const themeItems: SelectorItem[] = OVERTURE_THEMES.map((entry) => ({
    value: entry.id,
    label: t(`fetch_features_theme_${entry.id}`),
  }));
  return (
    <>
      <Selector
        label={t("fetch_features_theme")}
        items={themeItems}
        selectedItems={themeItems.find((item) => item.value === current?.id)}
        setSelectedItems={(item) => {
          const entry =
            !Array.isArray(item) && item
              ? OVERTURE_THEMES.find((theme) => theme.id === item.value)
              : undefined;
          // A mixed theme opens on its areas, the geometry most of its features have.
          if (entry) flow.setOvertureType(entry.types.polygon ?? Object.values(entry.types)[0] ?? "");
        }}
      />
      {/* Overture's mixed themes hold points, lines and areas together; a layer takes one. */}
      {current && geometries.length > 1 && (
        <SegmentedControl
          label={t("geometry_type")}
          items={geometryItems(geometries)}
          value={geometries.find((g) => current.types[g] === flow.overtureType)}
          onChange={(geometry) => {
            const type = current.types[geometry as Geometry];
            if (type) flow.setOvertureType(type);
          }}
        />
      )}
    </>
  );
};

/** One click for the commonest filters; they land in the filters below, to edit like any other. */
const QuickPicks = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // Overture files these asks under a place's category, so only its places take them.
  const picks =
    flow.source === "osm" ? QUICK_PICKS.osm : flow.overtureType === "places" ? QUICK_PICKS.overture : [];
  if (!picks.length || flow.filterMode === "sql") return null;
  return (
    <Box>
      <FieldLabel>{t("fetch_features_quick_picks")}</FieldLabel>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
        {picks.map((pick) => {
          const on = flow.isQuickPickOn(pick.key, pick.values);
          return (
            <Chip
              key={pick.id}
              size="small"
              label={t(`fetch_features_pick_${pick.id}`)}
              color={on ? "primary" : "default"}
              variant="outlined"
              aria-pressed={on}
              // Selected like a selected toggle button: primary text on a soft primary ground.
              sx={on ? { backgroundColor: alpha(theme.palette.primary.main, 0.12) } : undefined}
              disabled={flow.beyondFilters}
              onClick={() => flow.toggleQuickPick(pick.key, pick.values)}
            />
          );
        })}
      </Stack>
    </Box>
  );
};

/** GOAT's themes that Overture keeps together in its base theme, with one guide. */
const OVERTURE_BASE = ["land_use", "land", "water", "infrastructure"];

/** The Overture guide of a layer option, e.g. land_use_lines → base. */
const overtureGuide = (type: string) => {
  const theme = OVERTURE_THEMES.find((entry) => Object.values(entry.types).includes(type))?.id ?? "base";
  return OVERTURE_BASE.includes(theme) ? "base" : theme;
};

/** A compact toggle, sized like the panel's segmented control. */
const SmallToggle = <T extends string>({
  value,
  items,
  onChange,
  label,
  disabled,
}: {
  value: T;
  items: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) => (
  <ToggleButtonGroup
    exclusive
    size="small"
    color="primary"
    value={value}
    disabled={disabled}
    aria-label={label}
    onChange={(_, next: T | null) => next && onChange(next)}>
    {items.map((item) => (
      <ToggleButton
        key={item.value}
        value={item.value}
        sx={{ typography: "caption", py: 0.25, px: 1.5, textTransform: "none" }}>
        {item.label}
      </ToggleButton>
    ))}
  </ToggleButtonGroup>
);

/** A list's own shape while it loads, so a dropdown looks finished from the first frame. */
const PickerSkeleton = () => {
  const { t } = useTranslation("common");
  return (
    <Stack
      spacing={1.5}
      sx={{ px: 3, py: 1.5 }}
      aria-label={t("fetch_features_loading_values")}
      role="status">
      {[72, 55, 64, 48, 60, 40].map((width, index) => (
        <Stack key={index} direction="row" justifyContent="space-between">
          <Skeleton variant="text" width={`${width}%`} />
          <Skeleton variant="text" width={32} />
        </Stack>
      ))}
    </Stack>
  );
};

/** A row in a dropdown's list: a name and how often it occurs here, optionally ticked. */
/** The icon sizes this body uses, by role: no other icon size appears in it. */
const ICON_SIZE = { tiny: "8px", small: "11px", medium: "14px", large: "18px" } as const;

const PickerRow = ({
  label,
  count,
  checked,
  muted,
  onClick,
}: {
  label: React.ReactNode;
  count?: string;
  checked?: boolean;
  muted?: boolean;
  onClick: () => void;
}) => (
  <ButtonBase
    onClick={onClick}
    role={checked == null ? "option" : "checkbox"}
    aria-checked={checked}
    sx={{
      width: "100%",
      justifyContent: "flex-start",
      gap: 1.5,
      px: 3,
      py: 0.75,
      typography: "body2",
      color: muted ? "text.secondary" : "text.primary",
      textAlign: "left",
      "&:hover": { backgroundColor: "action.hover" },
    }}>
    {checked != null && <Checkbox size="small" checked={checked} tabIndex={-1} disableRipple sx={{ p: 0 }} />}
    <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
      {label}
    </Box>
    {count && (
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {count}
      </Typography>
    )}
  </ButtonBase>
);

/** A point fixed on screen when a dropdown opens: layout that shifts later cannot move it. */
type DropdownAnchor = { getBoundingClientRect: () => DOMRect };
type DropdownPlace = {
  anchor: DropdownAnchor;
  placement: "bottom-start" | "top-start" | "bottom-end" | "top-end";
  height: number;
};

/** The two dropdowns' fixed boxes: the size is set from the first frame, so nothing moves. */
const KEY_DROPDOWN = { width: 260, height: 290 };
const VALUES_DROPDOWN = { width: 270, height: 320 };
/** The least a box shrinks to, when neither below nor above has the room. */
const DROPDOWN_MIN_HEIGHT = 180;

/**
 * Right below the field when it fits, above when only that fits, and otherwise below with a
 * shorter box; never to the side. Decided before opening, from the field as it is then.
 */
const placeDropdown = (field: HTMLElement, height: number, align: "start" | "end"): DropdownPlace => {
  const rect = field.getBoundingClientRect();
  const anchor = { getBoundingClientRect: () => rect };
  const margin = 16;
  const below = window.innerHeight - rect.bottom - margin;
  const above = rect.top - margin;
  if (below >= height) return { anchor, placement: `bottom-${align}`, height };
  if (above >= height) return { anchor, placement: `top-${align}`, height };
  return { anchor, placement: `bottom-${align}`, height: Math.max(DROPDOWN_MIN_HEIGHT, below) };
};

/** A dropdown below a field: a fixed box above the dialog, closed by Esc or a click elsewhere. */
const FieldDropdown = ({
  place,
  width,
  label,
  onClose,
  children,
}: {
  place: DropdownPlace;
  width: number;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  const theme = useTheme();
  // Esc closes the dropdown wherever focus is, and only the dropdown: caught before the dialog.
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      latestClose.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <Popper
      open
      anchorEl={place.anchor}
      placement={place.placement}
      modifiers={[
        { name: "offset", options: { offset: [0, 4] } },
        { name: "flip", enabled: false },
        { name: "preventOverflow", options: { altAxis: false, padding: 8 } },
      ]}
      sx={{ zIndex: theme.zIndex.modal + 1 }}>
      <ClickAwayListener onClickAway={onClose}>
        <Paper
          role="dialog"
          aria-label={label}
          elevation={8}
          sx={{ width, height: place.height, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {children}
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
};

/** Which tag or attribute a row filters on: the area's own, with how often each occurs. */
const KeyDropdown = ({
  flow,
  keys,
  filter,
  place,
  onPicked,
  onClose,
}: {
  flow: FetchFlow["fetch"];
  keys: ReturnType<typeof useTagOptions>;
  filter: TagFilter;
  place: DropdownPlace;
  onPicked: () => void;
  onClose: () => void;
}) => {
  const { t, i18n } = useTranslation("common");
  const [query, setQuery] = useState("");
  const isOsm = flow.source === "osm";
  const q = query.trim().toLowerCase();
  const used = new Set(flow.filters.filter((f) => f.id !== filter.id).map((f) => f.key.trim()));
  const rows = keys.options.filter(
    (option) => !used.has(option.value) && (!q || option.value.toLowerCase().includes(q))
  );
  const typedIsNew = !!q && !keys.options.some((option) => option.value.toLowerCase() === q);
  const note = keys.failed
    ? t("osm_tag_failed")
    : keys.sampled && !keys.counting
      ? t("fetch_features_reduce_area")
      : undefined;
  const pick = (key: string) => {
    if (key !== filter.key) flow.updateFilter(filter.id, { key, values: [], operator: "is" });
    onPicked();
  };
  const searchLabel = t(isOsm ? "fetch_features_search_tags" : "fetch_features_search_attributes");
  return (
    <FieldDropdown place={place} width={KEY_DROPDOWN.width} label={searchLabel} onClose={onClose}>
      <Box sx={{ p: 2 }}>
        <TextField
          size="small"
          fullWidth
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchLabel}
          inputProps={{ "aria-label": searchLabel }}
        />
      </Box>
      <Box role="listbox" sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 1 }}>
        {keys.loading && !keys.options.length && <PickerSkeleton />}
        {rows.map((option) => (
          <PickerRow
            key={option.value}
            label={option.value}
            count={
              keys.counting
                ? "…"
                : !keys.sampled && option.count
                  ? option.count.toLocaleString(i18n.language)
                  : undefined
            }
            onClick={() => pick(option.value)}
          />
        ))}
        {typedIsNew && (
          <PickerRow
            label={t("fetch_features_use_typed", { value: query.trim() })}
            onClick={() => pick(query.trim())}
          />
        )}
      </Box>
      {note && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 3, pb: 1.5 }}>
          {note}
        </Typography>
      )}
    </FieldDropdown>
  );
};

/** Which values a row keeps, ticked from the area's own list with counts; or any, or none. */
const ValuesDropdown = ({
  flow,
  filter,
  place,
  onClose,
}: {
  flow: FetchFlow["fetch"];
  filter: TagFilter;
  place: DropdownPlace;
  onClose: () => void;
}) => {
  const { t, i18n } = useTranslation("common");
  const [query, setQuery] = useState("");
  const key = filter.key.trim();
  // Read when the dropdown opens, never ahead for every row.
  const values = useTagOptions(flow, key || undefined, !!key);
  const operator = operatorOf(filter);
  const negated = filter.operator === "is_not" || filter.operator === "is_not_set";
  const q = query.trim().toLowerCase();
  // What is ticked comes first, listed or not: a ticked value far down the counts is still in sight.
  const ticked = operator === "is" || operator === "is_not" ? filter.values : [];
  const rows = [
    ...ticked.map((value) => values.options.find((option) => option.value === value) ?? { value, count: 0 }),
    ...values.options.filter((option) => !ticked.includes(option.value)),
  ].filter((option) => !q || option.value.toLowerCase().includes(q));
  const typedIsNew = !!q && !values.options.some((option) => option.value.toLowerCase() === q);
  const note = values.failed
    ? t("osm_tag_failed")
    : values.sampled && !values.counting
      ? t("fetch_features_reduce_area")
      : undefined;
  const info =
    flow.source === "osm"
      ? `https://wiki.openstreetmap.org/wiki/Key:${encodeURIComponent(key)}`
      : `https://docs.overturemaps.org/guides/${overtureGuide(flow.overtureType)}/`;
  const toggle = (value: string) => {
    const on = ticked.includes(value);
    flow.updateFilter(filter.id, {
      values: on ? ticked.filter((v) => v !== value) : [...ticked, value],
      // Ticking a value keeps the row's is or is not; one set to "no value" asks again.
      operator: negated && operator !== "is_not_set" ? "is_not" : "is",
    });
  };
  return (
    <FieldDropdown
      place={place}
      width={VALUES_DROPDOWN.width}
      label={t("fetch_features_choose_values")}
      onClose={onClose}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 3, pt: 1.5, pb: 0.5 }}>
        <Typography variant="body2" fontWeight="fontWeightBold" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {key}
        </Typography>
        <Link href={info} target="_blank" rel="noopener noreferrer" variant="caption">
          {t("fetch_features_what_is_this")}
        </Link>
      </Stack>
      <Box sx={{ px: 2, pt: 0.5, pb: 1 }}>
        <TextField
          size="small"
          fullWidth
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("fetch_features_search_values")}
          inputProps={{ "aria-label": t("fetch_features_search_values") }}
        />
      </Box>
      <PickerRow
        label={t("fetch_features_any_value")}
        checked={operator === "is_set"}
        muted
        onClick={() => flow.updateFilter(filter.id, { values: [], operator: "is" })}
      />
      <PickerRow
        label={t("fetch_features_no_value")}
        checked={operator === "is_not_set"}
        muted
        onClick={() => flow.updateFilter(filter.id, { values: [], operator: "is_not" })}
      />
      <Divider />
      <Box role="listbox" sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {values.loading && !values.options.length && <PickerSkeleton />}
        {rows.map((option) => (
          <PickerRow
            key={option.value}
            label={option.value}
            count={!values.sampled && option.count ? option.count.toLocaleString(i18n.language) : undefined}
            checked={ticked.includes(option.value)}
            onClick={() => toggle(option.value)}
          />
        ))}
        {/* A value seen nowhere in the list yet can still be asked for. */}
        {typedIsNew && (
          <PickerRow
            label={t("fetch_features_use_typed", { value: query.trim() })}
            checked={ticked.includes(query.trim())}
            onClick={() => toggle(query.trim())}
          />
        )}
      </Box>
      {note && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 3, py: 1 }}>
          {note}
        </Typography>
      )}
      <Stack
        direction="row"
        justifyContent="flex-end"
        sx={{ px: 2, py: 1, borderTop: 1, borderColor: "divider" }}>
        <Button variant="text" size="small" onClick={onClose}>
          {t("done")}
        </Button>
      </Stack>
    </FieldDropdown>
  );
};

/**
 * One filter on one line: the key, the values field led by its condition, and a remove button.
 * The condition is a small token: a click flips it, "is" and "is not" with values, "is set" and
 * "is not set" without. An exclusion is drawn inverted, so it stands out in a list.
 */
const FilterRow = ({
  flow,
  filter,
  open,
  keyRef,
  valuesRef,
  onOpenKey,
  onOpenValues,
  onRemove,
}: {
  flow: FetchFlow["fetch"];
  filter: TagFilter;
  open: "key" | "values" | null;
  keyRef: (element: HTMLElement | null) => void;
  valuesRef: (element: HTMLElement | null) => void;
  onOpenKey: () => void;
  onOpenValues: () => void;
  onRemove: () => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const key = filter.key.trim();
  const operator = operatorOf(filter);
  const negative = operator === "is_not" || operator === "is_not_set";
  const flipped = { is: "is_not", is_not: "is", is_set: "is_not_set", is_not_set: "is_set" }[operator];
  const listed = operator === "is" || operator === "is_not" ? filter.values : [];
  const keyLabel = t(flow.source === "osm" ? "fetch_features_tag" : "fetch_features_attribute");
  const switchLabel = t("fetch_features_switch_to", { condition: t(`fetch_features_filter_${flipped}`) });
  // The panel's outlined input, as a button: same height, border, radius and type.
  const field = (isOpen: boolean) =>
    ({
      // Selector's height, the dropdown these fields stand in for.
      height: 38,
      boxSizing: "border-box",
      minWidth: 0,
      display: "flex",
      alignItems: "center",
      gap: 0.75,
      border: 1,
      borderColor: isOpen ? "primary.main" : alpha(theme.palette.text.primary, 0.23),
      boxShadow: isOpen ? `0 0 0 1px ${theme.palette.primary.main}` : "none",
      borderRadius: `${theme.shape.borderRadius}px`,
      typography: "body2",
      color: "text.primary",
      "&:hover": { borderColor: isOpen ? "primary.main" : "text.secondary" },
    }) as const;
  return (
    <Box
      data-negative={negative || undefined}
      sx={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr) 28px",
        gap: "6px",
        alignItems: "center",
      }}>
      <ButtonBase
        ref={keyRef}
        onClick={onOpenKey}
        aria-label={keyLabel}
        aria-expanded={open === "key"}
        sx={{ ...field(open === "key"), justifyContent: "space-between", pl: 2.5, pr: 2 }}>
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            // As Selector shows a chosen value: bold body2, in the secondary text colour.
            color: key ? "text.secondary" : "text.disabled",
            fontWeight: key ? 700 : 400,
          }}>
          {key || t(flow.source === "osm" ? "fetch_features_choose_tag" : "fetch_features_choose_attribute")}
        </Box>
        <Icon
          iconName={ICON_NAME.CHEVRON_DOWN}
          style={{ fontSize: ICON_SIZE.small, flexShrink: 0 }}
          htmlColor={theme.palette.text.secondary}
        />
      </ButtonBase>
      <Box ref={valuesRef} sx={{ ...field(open === "values"), pl: 1.25, pr: 2 }}>
        {/* The condition only means something once a tag is chosen. */}
        {key && (
          <Tooltip title={switchLabel} placement="top">
            <Box component="span" sx={{ display: "inline-flex", flexShrink: 0 }}>
              <ButtonBase
                onClick={() => flow.updateFilter(filter.id, { operator: negative ? "is" : "is_not" })}
                aria-label={switchLabel}
                sx={{
                  flexShrink: 0,
                  gap: "3px",
                  pl: 1,
                  pr: 0.75,
                  typography: "caption",
                  lineHeight: "20px",
                  whiteSpace: "nowrap",
                  borderRadius: 2.5,
                  // Told apart by shape, not colour: an exclusion is outlined, a match filled.
                  border: 1,
                  ...(negative
                    ? { borderColor: "text.secondary", color: "text.primary", fontWeight: "fontWeightBold" }
                    : {
                        borderColor: "transparent",
                        backgroundColor: "action.selected",
                        color: "text.secondary",
                        fontWeight: "fontWeightMedium",
                      }),
                }}>
                {t(`fetch_features_filter_${operator}`)}
                <Icon
                  iconName={ICON_NAME.CHEVRON_DOWN}
                  style={{ fontSize: ICON_SIZE.tiny }}
                  htmlColor="inherit"
                />
              </ButtonBase>
            </Box>
          </Tooltip>
        )}
        {/* The first value as a chip, the rest as "+N": two chips in a field this narrow
            shrank to unreadable stubs, and the row stays one line however many are chosen. */}
        {listed.length > 0 && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0, overflow: "hidden" }}>
            {listed.slice(0, 1).map((value) => (
              <Chip
                key={value}
                size="small"
                label={value}
                title={value}
                onClick={onOpenValues}
                onDelete={() =>
                  flow.updateFilter(filter.id, { values: filter.values.filter((v) => v !== value) })
                }
                sx={{ minWidth: 40, flexShrink: 1 }}
              />
            ))}
            {listed.length > 1 && (
              <Tooltip title={listed.join(", ")} placement="top">
                <Chip
                  size="small"
                  label={`+${listed.length - 1}`}
                  onClick={onOpenValues}
                  sx={{ flexShrink: 0 }}
                />
              </Tooltip>
            )}
          </Box>
        )}
        {/* The rest of the field opens the values; without values the condition token
            already says "is set" or "is not set". */}
        <ButtonBase
          onClick={onOpenValues}
          disabled={!key}
          aria-label={t("fetch_features_values")}
          aria-expanded={open === "values"}
          sx={{ flex: 1, minWidth: 16, height: "100%", justifyContent: "flex-end" }}>
          {key && (
            <Icon
              iconName={ICON_NAME.CHEVRON_DOWN}
              style={{ fontSize: ICON_SIZE.small, flexShrink: 0 }}
              htmlColor={theme.palette.text.secondary}
            />
          )}
        </ButtonBase>
      </Box>
      {/* The tool forms' remove button (RepeatableObjectInput), centred on the row. */}
      <Tooltip title={t("fetch_features_remove_filter", { key })} placement="top">
        <IconButton
          size="small"
          aria-label={t("fetch_features_remove_filter", { key })}
          onClick={onRemove}
          sx={{ p: 0.5, justifySelf: "center", "&:hover": { color: theme.palette.error.main } }}>
          <Icon htmlColor="inherit" iconName={ICON_NAME.TRASH} style={{ fontSize: ICON_SIZE.medium }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

/** Is the SQL condition one the server accepts here? Asked once typing rests. */
const useSqlCheck = (flow: FetchFlow["fetch"]) => {
  const where = flow.filterMode === "sql" ? flow.sql.trim() : "";
  // Not over an area no fetch reads: a selective condition would scan all of it.
  const question =
    where && flow.area && !flow.tooLarge
      ? JSON.stringify([flow.area, flow.source, flow.featureType, where])
      : null;
  const area = flow.area;
  return useAreaQuestion(question, () =>
    area
      ? getMirrorSample(area, flow.featureType, flow.source, { where }, 1).then(() => true)
      : Promise.resolve(true)
  );
};

const FilterSection = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const isSql = flow.filterMode === "sql";
  // Over the read limit only filters with values can make the area fit: SQL is never counted.
  // Past the ceiling nothing does, so the filters wait for a smaller area.
  const paused = flow.tooLarge;
  const beyond = flow.beyondFilters;
  const [open, setOpen] = useState<{ id: number; part: "key" | "values" } | null>(null);
  const [place, setPlace] = useState<DropdownPlace | null>(null);
  const fields = useRef<Record<string, HTMLElement | null>>({});
  // The key list is read only while someone looks at it: an open key dropdown, or SQL mode's
  // insert chips. A map move then asks for the size alone, which is what keeps a pan quick.
  const keys = useTagOptions(flow, undefined, open?.part === "key" || isSql);
  const [confirmBack, setConfirmBack] = useState(false);
  const check = useSqlCheck(flow);

  // Placed once, from the field as it is when the dropdown opens (a new row's field exists
  // only after it renders, hence after layout rather than in the click).
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const element = fields.current[`${open.id}:${open.part}`];
    if (!element) return;
    setPlace(
      open.part === "key"
        ? placeDropdown(element, KEY_DROPDOWN.height, "start")
        : placeDropdown(element, VALUES_DROPDOWN.height, "end")
    );
  }, [open]);

  const insert = (key: string) => {
    const column = sqlColumn(flow.source, key);
    flow.setSql(flow.sql ? `${flow.sql} ${column}` : column);
  };
  const toMode = (mode: "builder" | "sql") => {
    if (mode === "sql") {
      setConfirmBack(false);
      setOpen(null);
      flow.startSql();
    } else if (flow.sqlEdited) {
      setConfirmBack(true);
    } else {
      flow.setFilterMode("builder");
    }
  };
  const openFilter = open ? flow.filters.find((f) => f.id === open.id) : undefined;

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          {t(flow.source === "osm" ? "fetch_features_tag_filters" : "fetch_features_attribute_filters")}
        </Typography>
        <SmallToggle
          label={t("fetch_features_how_to_filter")}
          value={isSql ? "sql" : "builder"}
          onChange={toMode}
          disabled={paused && !isSql}
          items={[
            { value: "builder", label: t("fetch_features_mode_filters") },
            { value: "sql", label: "SQL" },
          ]}
        />
      </Stack>
      {paused && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
          {t(beyond ? "fetch_features_filters_paused" : "fetch_features_filters_values_only")}
        </Typography>
      )}
      {confirmBack && (
        <Box role="alert" sx={{ mb: 2, px: 2.5, py: 2, borderRadius: 2, border: 1, borderColor: "divider" }}>
          <Typography variant="caption" sx={{ display: "block", lineHeight: 1.5 }}>
            {t("fetch_features_sql_edited_note")}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button variant="text" size="small" color="inherit" onClick={() => setConfirmBack(false)}>
              {t("fetch_features_keep_sql")}
            </Button>
            <Button
              variant="text"
              size="small"
              onClick={() => {
                setConfirmBack(false);
                flow.setFilterMode("builder");
              }}>
              {t("fetch_features_use_filters")}
            </Button>
          </Stack>
        </Box>
      )}

      {isSql ? (
        <Stack spacing={1.5}>
          <TextField
            multiline
            minRows={4}
            fullWidth
            size="small"
            value={flow.sql}
            onChange={(event) => flow.setSql(event.target.value)}
            placeholder={
              flow.source === "osm"
                ? "tags['amenity'] IN ('school', 'kindergarten')"
                : "taxonomy['primary'] IN ('restaurant', 'cafe')"
            }
            inputProps={{
              spellCheck: false,
              "aria-label": t("fetch_features_sql_condition"),
            }}
            // Code in a monospace face, at the caption size.
            sx={{ "& .MuiInputBase-input": { fontFamily: MONO, typography: "caption" } }}
          />
          {!!flow.sql.trim() && (
            <Typography
              variant="caption"
              color={check.failed ? "error.main" : check.loading ? "text.secondary" : "primary.main"}
              sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              {!check.loading && !check.failed && (
                <Icon iconName={ICON_NAME.CHECK} style={{ fontSize: ICON_SIZE.small }} htmlColor="inherit" />
              )}
              {check.loading
                ? t("fetch_features_sql_checking")
                : check.failed
                  ? (check.error ?? t("fetch_features_sql_invalid"))
                  : t("fetch_features_sql_valid")}
            </Typography>
          )}
          {!!keys.options.length && (
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1} alignItems="center">
              <Typography variant="caption" color="text.secondary">
                {t("fetch_features_insert")}
              </Typography>
              {keys.options.slice(0, 8).map((option) => (
                <Chip
                  key={option.value}
                  size="small"
                  variant="outlined"
                  label={option.value}
                  onClick={() => insert(option.value)}
                />
              ))}
            </Stack>
          )}
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          {flow.filters.map((filter) => (
            <FilterRow
              key={filter.id}
              flow={flow}
              filter={filter}
              open={open?.id === filter.id ? open.part : null}
              keyRef={(element) => (fields.current[`${filter.id}:key`] = element)}
              valuesRef={(element) => (fields.current[`${filter.id}:values`] = element)}
              onOpenKey={() => {
                setOpen(
                  open?.id === filter.id && open.part === "key" ? null : { id: filter.id, part: "key" }
                );
                // Asked at once rather than after the pan wait: someone is looking at the list.
                keys.load();
              }}
              onOpenValues={() =>
                setOpen(
                  open?.id === filter.id && open.part === "values" ? null : { id: filter.id, part: "values" }
                )
              }
              onRemove={() => {
                if (open?.id === filter.id) setOpen(null);
                flow.removeFilter(filter.id);
              }}
            />
          ))}
          {flow.filters.length > 1 ? (
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Typography variant="caption" color="text.secondary">
                {t("fetch_features_match")}
              </Typography>
              <SmallToggle
                label={t("fetch_features_match")}
                value={flow.match}
                onChange={flow.setMatch}
                items={[
                  { value: "all", label: t("fetch_features_match_all_short") },
                  { value: "any", label: t("fetch_features_match_any_short") },
                ]}
              />
              <Typography variant="caption" color="text.secondary">
                {t(flow.match === "all" ? "fetch_features_match_all_hint" : "fetch_features_match_any_hint")}
              </Typography>
            </Stack>
          ) : (
            !flow.filters.length && (
              <Typography variant="caption" color="text.secondary">
                {t("fetch_features_no_filters")}
              </Typography>
            )
          )}
          {/* The tool panels' add button: a rule, then a full-width text button. A new row opens
              on its key. */}
          <Box>
            <Divider />
            <Button
              fullWidth
              variant="text"
              size="small"
              // One empty row at a time: a second would only be another blank to fill.
              disabled={beyond || flow.filters.some((filter) => !filter.key.trim())}
              startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: ICON_SIZE.medium }} />}
              onClick={() => {
                const id = flow.addFilter();
                setOpen({ id, part: "key" });
                keys.load();
              }}>
              <Typography variant="body2" color="inherit">
                {t("fetch_features_add_filter")}
              </Typography>
            </Button>
          </Box>
          {open && place && openFilter && open.part === "key" && (
            <KeyDropdown
              flow={flow}
              keys={keys}
              filter={openFilter}
              place={place}
              onPicked={() => setOpen({ id: openFilter.id, part: "values" })}
              onClose={() => setOpen(null)}
            />
          )}
          {open && place && openFilter && open.part === "values" && (
            <ValuesDropdown
              key={openFilter.id}
              flow={flow}
              filter={openFilter}
              place={place}
              onClose={() => setOpen(null)}
            />
          )}
        </Stack>
      )}
    </Box>
  );
};

type PreviewTab = "map" | "table" | "details";

/**
 * One question about the area, asked once it rests and dropped when the area moves on:
 * the sample and the columns are both slow enough that a pan must not queue them up.
 */
const useAreaQuestion = <T,>(question: string | null, ask: () => Promise<T>) => {
  const [answer, setAnswer] = useState<{ for: string; value?: T; failed?: boolean; error?: string }>();
  const latestAsk = useRef(ask);
  latestAsk.current = ask;
  useEffect(() => {
    if (!question) return;
    let current = true;
    const timer = setTimeout(() => {
      latestAsk
        .current()
        .then((value) => current && setAnswer({ for: question, value }))
        .catch(
          (error: unknown) =>
            current &&
            setAnswer({
              for: question,
              failed: true,
              error: error instanceof Error ? error.message : undefined,
            })
        );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [question]);
  const fresh = answer?.for === question ? answer : undefined;
  return { value: fresh?.value, failed: !!fresh?.failed, error: fresh?.error, loading: !!question && !fresh };
};

/** A few of the features a fetch would write, with the columns it would write. */
const SampleTable = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const question =
    flow.area && !isNetworkSource(flow.source) && !flow.tooLarge
      ? JSON.stringify([flow.area, flow.source, flow.featureType, flow.sampleFilters])
      : null;
  const { value, failed, loading } = useAreaQuestion(question, () =>
    getMirrorSample(flow.area!, flow.featureType, flow.source, flow.sampleFilters)
  );
  const message = isNetworkSource(flow.source)
    ? t("fetch_features_sample_network")
    : !flow.area
      ? t("fetch_features_choose_area_first")
      : flow.tooLarge
        ? t("fetch_features_sample_too_large")
        : failed
          ? t("fetch_features_sample_failed")
          : loading
            ? t("fetch_features_sample_loading")
            : !value?.rows.length
              ? t("fetch_features_sample_empty")
              : undefined;
  if (message)
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, p: 6 }}>
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {message}
        </Typography>
      </Stack>
    );
  return (
    <Stack spacing={2} sx={{ flex: 1, minHeight: 0, p: 4 }}>
      <Typography variant="caption" color="text.secondary">
        {t("fetch_features_sample_intro", { count: value!.rows.length })}
      </Typography>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 2,
        }}>
        <Box component="table" sx={{ borderCollapse: "collapse", width: "100%", typography: "caption" }}>
          <thead>
            <tr>
              {value!.columns.map((column) => (
                <Box
                  component="th"
                  scope="col"
                  key={column.name}
                  sx={{
                    position: "sticky",
                    top: 0,
                    textAlign: "left",
                    px: 2.5,
                    py: 2,
                    whiteSpace: "nowrap",
                    fontWeight: "fontWeightBold",
                    color: "text.secondary",
                    backgroundColor: "background.paper",
                    borderBottom: `1px solid ${theme.palette.divider}`,
                  }}>
                  {column.name}
                </Box>
              ))}
            </tr>
          </thead>
          <tbody>
            {value!.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <Box
                    component="td"
                    key={cellIndex}
                    sx={{
                      px: 2.5,
                      py: 1.75,
                      whiteSpace: "nowrap",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      borderBottom: `1px solid ${theme.palette.divider}`,
                    }}>
                    {cell}
                  </Box>
                ))}
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
    </Stack>
  );
};

/** A street network's layers: the edges and nodes of the routing network, cut whole. */
const NETWORK_COLUMNS = [
  "id",
  "class",
  "length_m",
  "impedance_slope",
  "impedance_slope_reverse",
  "impedance_surface",
  "speed_limit_kph_forward",
  "speed_limit_kph_backward",
  "source_node",
  "target_node",
];

/** What the layer will be: source, licence, size, geometry and its columns. */
const DetailsPanel = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t, i18n } = useTranslation("common");
  const isNetwork = isNetworkSource(flow.source);
  const question =
    flow.area && !isNetwork ? JSON.stringify([flow.area, flow.source, flow.featureType]) : null;
  const { value, loading } = useAreaQuestion(question, () =>
    getMirrorColumns(flow.area!, flow.featureType, flow.source)
  );
  const columns = isNetwork ? NETWORK_COLUMNS : (value?.columns.map((column) => column.name) ?? []);
  const geometry = isNetwork
    ? t("fetch_features_details_network_geometry")
    : t(`fetch_features_geometry_${value?.geometryType ?? "point"}`);
  const rows: [string, string][] = [
    [t("fetch_features_details_source"), t(`fetch_features_source_${flow.source}`)],
    [t("fetch_features_details_licence"), t(`fetch_features_licence_${flow.source}`)],
    [
      t("fetch_features_details_features"),
      isNetwork
        ? "–"
        : flow.estimate != null
          ? t("fetch_features_estimate", {
              count: flow.estimate,
              formatted: flow.estimate.toLocaleString(i18n.language),
            })
          : t("fetch_features_estimate_counting"),
    ],
    [t("fetch_features_details_geometry"), `${geometry} · EPSG:4326`],
  ];
  return (
    <Stack spacing={4} sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 5 }}>
      <Box sx={{ display: "grid", gridTemplateColumns: "160px minmax(0, 1fr)", columnGap: 4, rowGap: 2 }}>
        {rows.map(([label, text]) => (
          <Box key={label} sx={{ display: "contents" }}>
            <Typography variant="body2" color="text.secondary">
              {label}
            </Typography>
            <Typography variant="body2">{text}</Typography>
          </Box>
        ))}
      </Box>
      <Box>
        <FieldLabel>{t("fetch_features_details_columns", { count: columns.length })}</FieldLabel>
        {!isNetwork && !flow.area ? (
          <Typography variant="body2" color="text.secondary">
            {t("fetch_features_choose_area_first")}
          </Typography>
        ) : loading && !isNetwork ? (
          <Typography variant="body2" color="text.secondary">
            {t("fetch_features_sample_loading")}
          </Typography>
        ) : (
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
            {columns.map((name) => (
              <Chip key={name} size="small" label={name} sx={{ fontFamily: MONO }} />
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
};

const SOURCE_ICONS = {
  osm: ICON_NAME.OSM,
  overture: ICON_NAME.OVERTURE,
  street_network: ICON_NAME.ROAD_NETWORK,
  pt_network: ICON_NAME.BUS,
} as const;

/**
 * Open data GOAT hosts, for an area: where, which features, and what the layer will be.
 *
 * The settings column is built from the tool panels' own parts (sections, selectors,
 * segmented controls), so it can move into the toolbox as it is.
 */
const FetchBody = ({ controller }: { controller: FetchFlow }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { fetch: flow } = controller;
  const isNetwork = isNetworkSource(flow.source);
  const [tab, setTab] = useState<PreviewTab>("map");
  // One picker for the settings column and the map, so the search and the radius on the left
  // and the clicks on the right edit the same shape; it outlives the map when another tab shows.
  const picker = useSpatialPicker({
    mode: flow.areaMode === "view" ? null : flow.areaMode,
    // Each way shows its own last choice; the flow keeps one, so another way's shows nothing.
    value: flow.areaMode !== "view" && flow.spatial?.kind === flow.areaMode ? flow.spatial : null,
    onChange: flow.setSpatial,
  });

  return (
    <Stack sx={{ minHeight: 0, flex: 1 }}>
      <Stack
        direction="row"
        spacing={2.5}
        alignItems="center"
        sx={{ px: 5, py: 3, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "text.secondary",
            backgroundColor: theme.palette.action.hover,
          }}>
          <Icon
            iconName={SOURCE_ICONS[flow.source]}
            style={{ fontSize: ICON_SIZE.large }}
            htmlColor="currentColor"
          />
        </Box>
        <Typography variant="body1" fontWeight="fontWeightBold">
          {t(`fetch_features_source_${flow.source}`)}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {t(`fetch_features_licence_${flow.source}`)}
        </Typography>
        <Typography
          variant="caption"
          fontWeight="fontWeightBold"
          color="text.secondary"
          sx={{ px: 2.5, py: 0.5, borderRadius: 999, border: `1px solid ${theme.palette.divider}` }}>
          {t("connect_service_copy")}
        </Typography>
      </Stack>
      <Box sx={{ display: "flex", flexDirection: { xs: "column", md: "row" }, flex: 1, minHeight: 0 }}>
        <Box
          sx={{
            width: { xs: "100%", md: 400 },
            flexShrink: 0,
            overflowY: "auto",
            borderRight: { md: `1px solid ${theme.palette.divider}` },
          }}>
          <Stack spacing={1} sx={{ px: 4, py: 3 }}>
            {/* The source's description goes above the sections, as a tool's does, so the
                sections' guide line runs through unbroken. */}
            {isNetwork && (
              <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", pb: 2 }}>
                {t(`fetch_features_${flow.source}_hint`)}
              </Typography>
            )}
            <Section label={t("fetch_features_area")} icon={ICON_NAME.BOUNDING_BOX}>
              <AreaSettings flow={flow} picker={picker} />
            </Section>
            {isNetwork ? null : (
              <Section label={t("fetch_features_section_features")} icon={ICON_NAME.FILTER}>
                <FeatureChoice flow={flow} />
                <QuickPicks flow={flow} />
                <FilterSection flow={flow} />
              </Section>
            )}
            {!flow.inWorkflow && (
              <Section label={t("fetch_features_section_result")} icon={ICON_NAME.LAYERS}>
                <TextFieldInput
                  label={t(isNetwork ? "fetch_features_bundle_name" : "layer_name")}
                  value={flow.name}
                  onChange={flow.setName}
                  // As the tool forms' name fields: no clear button.
                  clearable={false}
                  inputProps={{ "aria-label": t(isNetwork ? "fetch_features_bundle_name" : "layer_name") }}
                />
                <Box>
                  <FieldLabel>{t("connect_service_save_to")}</FieldLabel>
                  <UploadDestinationPill
                    folders={flow.folders}
                    spaces={flow.spaces}
                    selected={flow.selectedFolder}
                    onSelect={flow.setSelectedFolder}
                  />
                </Box>
              </Section>
            )}
          </Stack>
        </Box>
        <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Tabs
            value={tab}
            onChange={(_, next: PreviewTab) => setTab(next)}
            sx={{ px: 3, minHeight: 44, borderBottom: `1px solid ${theme.palette.divider}` }}>
            <Tab
              value="map"
              label={t("fetch_features_tab_map")}
              sx={{ minHeight: 44, textTransform: "none" }}
            />
            {!isNetwork && (
              <Tab
                value="table"
                label={t("fetch_features_tab_table")}
                sx={{ minHeight: 44, textTransform: "none" }}
              />
            )}
            <Tab
              value="details"
              label={t("fetch_features_tab_details")}
              sx={{ minHeight: 44, textTransform: "none" }}
            />
          </Tabs>
          {tab === "map" || (tab === "table" && isNetwork) ? (
            <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <AreaMap flow={flow} picker={picker} />
            </Box>
          ) : tab === "table" ? (
            <SampleTable flow={flow} />
          ) : (
            <DetailsPanel flow={flow} />
          )}
        </Stack>
      </Box>
    </Stack>
  );
};

export default FetchBody;
