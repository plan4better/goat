"use client";

import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import type { Map as MaplibreMap } from "maplibre-gl";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type MirrorValue, getMirrorValues } from "@/lib/api/processes";

import {
  type AreaMode,
  type FetchFlow,
  type Geometry,
  MAX_FEATURES,
  OSM_TYPES,
  OVERTURE_THEMES,
  type TagFilter,
  roundBox,
} from "@/hooks/addLayer/useFetchFlow";

import UploadDestinationPill from "@/components/addLayer/UploadDestinationPill";
import CatalogSpatialPicker from "@/components/dashboard/catalog/CatalogSpatialPicker";
import SpatialModeSwitch from "@/components/dashboard/catalog/SpatialModeSwitch";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SHAPE_COLOR = "#2BB381";
/** How far in from the preview's edges the map-view box is drawn, in pixels. */
const VIEW_INSET = 28;

const SectionLabel = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2, minHeight: 30 }}>
    <Typography
      variant="caption"
      fontWeight={700}
      color="text.secondary"
      sx={{ flex: 1, letterSpacing: 0.6, textTransform: "uppercase" }}>
      {children}
    </Typography>
    {action}
  </Stack>
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
          // A full read that hit the cap saw more features than a fetch takes,
          // whatever the index guessed: the guess runs low where features cluster.
          if (!key && result.estimate != null)
            flow.setEstimate(result.sampled ? Math.max(result.estimate, MAX_FEATURES + 1) : result.estimate);
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
        if (result.estimate != null) flow.setEstimate(result.estimate);
        // Final: the quick read saw the whole area, or a big view's list came
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
  useEffect(() => {
    askedFor.current = null;
    if (shownFor.current !== subject) {
      shownFor.current = subject;
      setOptions([]);
      setSampled(false);
    }
    setCounting(false);
    setLoading(false);
    if (!prefetch || !question) return;
    // The map view changes on every pan; wait until it rests before asking.
    const timer = setTimeout(() => latestLoad.current(), 400);
    return () => clearTimeout(timer);
  }, [question, prefetch, subject]);

  return { options, loading, counting, failed, sampled, load };
};

/** The area's mode, and one map that is the area (map view) or the place to pick it. */
const AreaSection = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { areaMode, spatial } = flow;
  // Orange while the area holds more than a fetch reads.
  const shapeColor = flow.tooLarge ? theme.palette.warning.main : SHAPE_COLOR;
  const isView = areaMode === "view";

  const modes: { id: AreaMode; label: string; icon: ICON_NAME }[] = [
    { id: "view", label: t("fetch_features_area_view"), icon: ICON_NAME.MAP },
    { id: "region", label: t("catalog_mode_region"), icon: ICON_NAME.GLOBE },
    { id: "point", label: t("catalog_mode_point"), icon: ICON_NAME.LOCATION },
    { id: "polygon", label: t("catalog_mode_polygon"), icon: ICON_NAME.POLYGON_FEATURE },
  ];

  // Each mode shows its own last choice; the flow keeps one, so another mode's shows nothing.
  const value = !isView && spatial?.kind === areaMode ? spatial : null;
  // Another mode opens framed on its own area (the picker does it); only the map view needs the box.
  const [initialViewState] = useState(() =>
    isView && flow.viewBox ? { bounds: flow.viewBox, fitBoundsOptions: { padding: VIEW_INSET } } : undefined
  );

  // The box drawn over the map, not the map's own edges: what is fetched is what the box shows.
  const measure = (event: { target: MaplibreMap; originalEvent?: unknown }) => {
    const map = event.target;
    const { clientWidth, clientHeight } = map.getContainer();
    const sw = map.unproject([VIEW_INSET, clientHeight - VIEW_INSET]);
    const ne = map.unproject([clientWidth - VIEW_INSET, VIEW_INSET]);
    const next = roundBox([sw.lng, sw.lat, ne.lng, ne.lat]);
    // Only a person moving the map chooses the view; a fit to another area does not.
    if (next.join() !== flow.viewBox?.join() || event.originalEvent)
      flow.setViewBox(next, !!event.originalEvent);
  };

  return (
    <Stack spacing={3} sx={{ flex: 1, minHeight: 0 }}>
      <Box>
        <SectionLabel>{t("fetch_features_area")}</SectionLabel>
        <SpatialModeSwitch modes={modes} value={areaMode} onChange={flow.setAreaMode} />
        {/* A line is kept in every mode, so the map below never moves. */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 1.5, minHeight: 20 }}>
          {!isView && (flow.areaLabel ?? t("fetch_features_area_none"))}
        </Typography>
      </Box>
      <CatalogSpatialPicker
        variant="inline"
        mode={isView ? null : areaMode}
        value={value}
        geometry={isView || value ? undefined : flow.area}
        shapeColor={shapeColor}
        onChange={flow.setSpatial}
        mapId="fetch-features-preview"
        initialViewState={initialViewState}
        viewHint={t("fetch_features_area_view_hint")}
        onMoveEnd={measure}
        onLoad={measure}
        overlay={
          <>
            {isView && (
              <Box
                sx={{
                  position: "absolute",
                  inset: VIEW_INSET,
                  pointerEvents: "none",
                  border: `2px dashed ${shapeColor}`,
                  borderRadius: 1,
                  backgroundColor: alpha(shapeColor, 0.06),
                }}
              />
            )}
            <Box
              sx={{
                position: "absolute",
                top: 12,
                left: 12,
                px: 2.5,
                py: 1.5,
                borderRadius: 1.5,
                backgroundColor: "background.paper",
                boxShadow: "0 2px 10px rgba(58,53,65,0.12)",
              }}>
              <Typography variant="caption" fontWeight={700}>
                {isView ? t("fetch_features_area_view_label") : t("fetch_features_area_preview")}
              </Typography>
            </Box>
          </>
        }
      />
    </Stack>
  );
};

const GEOMETRIES: Geometry[] = ["point", "line", "polygon"];

/** One row per layer the source offers, one picked: a layer has one geometry and one source. */
const LayerList = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const isOsm = flow.source === "osm";
  const current = OVERTURE_THEMES.find((entry) => Object.values(entry.types).includes(flow.overtureType));
  const rows = isOsm
    ? OSM_TYPES.map((type) => ({
        id: type,
        title: t(`fetch_features_type_${type}`),
        on: flow.osmType === type,
        pick: () => flow.setOsmType(type),
      }))
    : OVERTURE_THEMES.map((entry) => ({
        id: entry.id,
        title: t(`fetch_features_theme_${entry.id}`),
        on: current?.id === entry.id,
        // A mixed theme opens on its areas, the geometry most of its features have.
        pick: () => flow.setOvertureType(entry.types.polygon ?? Object.values(entry.types)[0] ?? ""),
      }));
  return (
    <Stack role="radiogroup" spacing={0.5} sx={{ p: 2 }}>
      {rows.map((row) => (
        <Box
          key={row.id}
          component="button"
          type="button"
          role="radio"
          aria-checked={row.on}
          onClick={row.pick}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            px: 2.5,
            py: 2,
            border: "none",
            borderRadius: 2,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "text.primary",
            backgroundColor: row.on ? alpha(theme.palette.primary.main, 0.08) : "transparent",
          }}>
          <Box
            sx={{
              width: 18,
              height: 18,
              flexShrink: 0,
              boxSizing: "border-box",
              borderRadius: "50%",
              border: row.on
                ? `5px solid ${theme.palette.primary.main}`
                : `2px solid ${theme.palette.text.disabled}`,
            }}
          />
          <Typography variant="body2" fontWeight={700}>
            {row.title}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
};

/** Overture's mixed themes hold points, lines and areas together; a layer takes one. */
const GeometrySwitch = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const theme = OVERTURE_THEMES.find((entry) => Object.values(entry.types).includes(flow.overtureType));
  if (flow.source !== "overture" || !theme || Object.keys(theme.types).length < 2) return null;
  const geometry = GEOMETRIES.find((g) => theme.types[g] === flow.overtureType);
  return (
    <Box>
      <SectionLabel>{t("fetch_features_type")}</SectionLabel>
      <ToggleButtonGroup
        exclusive
        fullWidth
        size="small"
        color="primary"
        value={geometry}
        onChange={(_, value: Geometry | null) => {
          const type = value && theme.types[value];
          if (type) flow.setOvertureType(type);
        }}>
        {GEOMETRIES.filter((g) => theme.types[g]).map((value) => (
          <ToggleButton key={value} value={value} sx={{ textTransform: "none", fontWeight: 700 }}>
            {t(`fetch_features_geometry_${value}`)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
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

const FilterRow = ({
  flow,
  filter,
  keys,
}: {
  flow: FetchFlow["fetch"];
  filter: TagFilter;
  keys: ReturnType<typeof useTagOptions>;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // Asked as soon as a key is chosen, not when the list opens, so the values are
  // usually there by the time someone clicks.
  const values = useTagOptions(flow, filter.key.trim() || undefined, !!filter.key.trim());
  const counts = useMemo(
    () => Object.fromEntries(values.options.map((option) => [option.value, option.count])),
    [values.options]
  );
  const keyCounts = useMemo(
    () => Object.fromEntries(keys.options.map((option) => [option.value, option.count])),
    [keys.options]
  );
  const keyLabel = t(flow.source === "osm" ? "fetch_features_tag" : "fetch_features_attribute");
  const key = filter.key.trim();
  // What a tag or attribute and its values mean, e.g. building=yes, is the source's to say.
  const info =
    flow.source === "osm"
      ? {
          label: t("fetch_features_osm_wiki", { key }),
          href: `https://wiki.openstreetmap.org/wiki/Key:${encodeURIComponent(key)}`,
        }
      : {
          label: t("fetch_features_overture_docs", { key }),
          href: `https://docs.overturemaps.org/guides/${overtureGuide(flow.overtureType)}/`,
        };

  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Stack
        spacing={2.5}
        sx={{ flex: 1, minWidth: 0, p: 3, borderRadius: 2, border: `1px solid ${theme.palette.divider}` }}>
        <Autocomplete
          freeSolo
          size="small"
          options={keys.options.map((option) => option.value)}
          loading={keys.loading}
          onOpen={keys.load}
          value={filter.key}
          // The list reports the key it opens with as a change; only a new key clears the values.
          onInputChange={(_, next) =>
            next !== filter.key && flow.updateFilter(filter.id, { key: next, values: [] })
          }
          renderOption={({ key, ...props }, option) => (
            <li key={key} {...props}>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {option}
              </Typography>
              {/* A placeholder while the counts are read, so the number fills in
                  where it will stand rather than appearing out of nowhere. */}
              {keys.counting ? (
                <Typography variant="caption" color="text.disabled">
                  …
                </Typography>
              ) : (
                !keys.sampled &&
                !!keyCounts[option] && (
                  <Typography variant="caption" color="text.secondary">
                    {keyCounts[option].toLocaleString()}
                  </Typography>
                )
              )}
            </li>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              label={keyLabel}
              helperText={
                keys.failed
                  ? t("osm_tag_failed")
                  : keys.sampled && !keys.counting && !filter.values.length
                    ? t("fetch_features_reduce_area")
                    : undefined
              }
            />
          )}
        />
        <Autocomplete
          multiple
          freeSolo
          disableCloseOnSelect
          size="small"
          disabled={!filter.key.trim()}
          options={values.options.map((option) => option.value)}
          loading={values.loading}
          onOpen={values.load}
          value={filter.values}
          onChange={(_, next) => flow.updateFilter(filter.id, { values: next as string[] })}
          renderOption={({ key, ...props }, option) => (
            <li key={key} {...props}>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {option}
              </Typography>
              {!values.sampled && !!counts[option] && (
                <Typography variant="caption" color="text.secondary">
                  {counts[option].toLocaleString()}
                </Typography>
              )}
            </li>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              label={t("fetch_features_values")}
              helperText={
                values.failed
                  ? t("osm_tag_failed")
                  : values.sampled && !filter.values.length
                    ? t("fetch_features_reduce_area")
                    : !filter.values.length && filter.key.trim()
                      ? t("osm_tag_value_optional")
                      : undefined
              }
            />
          )}
        />
      </Stack>
      <Stack sx={{ mt: 4 }}>
        <IconButton aria-label={t("delete")} onClick={() => flow.removeFilter(filter.id)}>
          <Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 14 }} />
        </IconButton>
        {key && (
          <Tooltip title={info.label} placement="left">
            <IconButton
              component="a"
              href={info.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={info.label}>
              <Icon iconName={ICON_NAME.CIRCLEINFO} style={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Stack>
  );
};

const FilterSection = ({ flow }: { flow: FetchFlow["fetch"] }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const keys = useTagOptions(flow, undefined, true);
  const isSql = flow.filterMode === "sql";
  // Filters cannot make an area this large fit: no new ones, while the ones there stay editable.
  const paused = flow.tooLarge;

  const insert = (key: string) => {
    const column = flow.source === "osm" ? `tags['${key}']` : key;
    flow.setSql(flow.sql ? `${flow.sql} ${column}` : column);
  };

  return (
    <Box>
      <SectionLabel
        action={
          <ToggleButtonGroup
            exclusive
            size="small"
            color="primary"
            value={flow.filterMode}
            disabled={paused}
            onChange={(_, value) => value && flow.setFilterMode(value)}>
            <ToggleButton value="builder" sx={{ textTransform: "none", py: 0.5, px: 2.5 }}>
              {t("fetch_features_builder")}
            </ToggleButton>
            <ToggleButton value="sql" sx={{ textTransform: "none", py: 0.5, px: 2.5 }}>
              SQL
            </ToggleButton>
          </ToggleButtonGroup>
        }>
        {t(flow.source === "osm" ? "fetch_features_tag_filters" : "fetch_features_attribute_filters")}
      </SectionLabel>
      {paused && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2 }}>
          {t("fetch_features_filters_paused")}
        </Typography>
      )}

      {isSql ? (
        <Stack spacing={2.5}>
          <TextField
            multiline
            minRows={5}
            fullWidth
            value={flow.sql}
            onChange={(event) => flow.setSql(event.target.value)}
            placeholder={
              flow.source === "osm"
                ? "tags['amenity'] IN ('school', 'kindergarten')"
                : "categories['primary'] IN ('restaurant', 'cafe')"
            }
            inputProps={{ spellCheck: false, style: { fontFamily: MONO, fontSize: 13 } }}
          />
          <Typography variant="caption" color="text.secondary">
            {t(flow.source === "osm" ? "fetch_features_sql_hint_osm" : "fetch_features_sql_hint_overture")}
          </Typography>
          {!!keys.options.length && (
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
              {keys.options.slice(0, 16).map((option) => (
                <Chip
                  key={option.value}
                  size="small"
                  variant="outlined"
                  label={option.value}
                  onClick={() => insert(option.value)}
                  sx={{ fontFamily: MONO, fontSize: 11.5 }}
                />
              ))}
            </Stack>
          )}
        </Stack>
      ) : (
        <Stack spacing={2.5}>
          {flow.filters.length > 1 && (
            <Stack direction="row" spacing={2} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {t("fetch_features_match_prefix")}
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                color="primary"
                value={flow.match}
                onChange={(_, value) => value && flow.setMatch(value)}>
                <ToggleButton value="all" sx={{ textTransform: "none", py: 0.5, px: 2.5 }}>
                  {t("fetch_features_match_all")}
                </ToggleButton>
                <ToggleButton value="any" sx={{ textTransform: "none", py: 0.5, px: 2.5 }}>
                  {t("fetch_features_match_any")}
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          )}
          {flow.filters.map((filter) => (
            <FilterRow key={filter.id} flow={flow} filter={filter} keys={keys} />
          ))}
          {!flow.filters.length && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ p: 3, borderRadius: 2, backgroundColor: theme.palette.action.hover, lineHeight: 1.5 }}>
              {t("fetch_features_no_filters")}
            </Typography>
          )}
          <Box>
            <Button
              size="small"
              disabled={paused}
              startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 12 }} />}
              onClick={flow.addFilter}>
              {t("fetch_features_add_filter")}
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
};

/** Open data GOAT hosts, for an area: which layer, which features, where. */
const FetchBody = ({ controller }: { controller: FetchFlow }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { fetch: flow } = controller;
  const isNetwork = flow.source === "street_network";

  return (
    <Stack sx={{ minHeight: 0, flex: 1 }}>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={{ px: 6, py: 3, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Typography variant="body1" fontWeight={800}>
          {t(`fetch_features_source_${flow.source}`)}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {t(`fetch_features_licence_${flow.source}`)}
        </Typography>
        <Typography
          variant="caption"
          fontWeight={700}
          color="text.secondary"
          sx={{ px: 2.5, py: 0.5, borderRadius: 999, border: `1px solid ${theme.palette.divider}` }}>
          {t("connect_service_copy")}
        </Typography>
      </Stack>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", md: "row" },
          flex: 1,
          minHeight: 0,
        }}>
        <Box
          sx={{
            width: { xs: "100%", md: 380 },
            flexShrink: 0,
            overflowY: "auto",
            borderRight: { md: `1px solid ${theme.palette.divider}` },
          }}>
          {!isNetwork && <LayerList flow={flow} />}
          <Stack
            spacing={5}
            sx={{ p: 5, borderTop: isNetwork ? "none" : `1px solid ${theme.palette.divider}` }}>
            {/* Here, not over the map: a line there resized the map, which moved the area. */}
            {flow.tooBig && (
              <Alert severity="warning" sx={{ py: 0.5 }}>
                {t(
                  isNetwork
                    ? "fetch_features_street_network_too_large"
                    : flow.tooLarge
                      ? "fetch_features_area_too_large"
                      : "fetch_features_reduce_area"
                )}
              </Alert>
            )}
            {isNetwork ? (
              <Typography variant="body2" color="text.secondary">
                {t("fetch_features_street_network_hint")}
              </Typography>
            ) : (
              <>
                <GeometrySwitch flow={flow} />
                <FilterSection flow={flow} />
              </>
            )}
          </Stack>
        </Box>
        <Stack spacing={3} sx={{ flex: 1, minWidth: 0, p: 4 }}>
          <AreaSection flow={flow} />
        </Stack>
      </Box>
      {!flow.inWorkflow && (
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={4}
          alignItems={{ xs: "stretch", sm: "flex-end" }}
          sx={{ px: 6, pt: 3.5, pb: 4, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Box sx={{ width: { xs: "100%", sm: 400 } }}>
            <Typography
              variant="body2"
              fontWeight="bold"
              component="label"
              htmlFor="fetch-features-name"
              sx={{ display: "block", mb: 1.5 }}>
              {t(isNetwork ? "fetch_features_bundle_name" : "layer_name")}
            </Typography>
            <TextField
              id="fetch-features-name"
              fullWidth
              size="small"
              value={flow.name}
              onChange={(event) => flow.setName(event.target.value)}
              error={!flow.name.trim()}
            />
          </Box>
          <Box>
            <Typography variant="body2" fontWeight="bold" sx={{ display: "block", mb: 1.5 }}>
              {t("connect_service_save_to")}
            </Typography>
            <Box sx={{ height: 40, display: "flex", alignItems: "center" }}>
              <UploadDestinationPill
                folders={flow.folders}
                spaces={flow.spaces}
                selected={flow.selectedFolder}
                onSelect={flow.setSelectedFolder}
              />
            </Box>
          </Box>
        </Stack>
      )}
    </Stack>
  );
};

export default FetchBody;
