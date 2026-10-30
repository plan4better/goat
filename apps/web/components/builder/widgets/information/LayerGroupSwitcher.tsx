import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import {
  Box,
  Chip,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import { emitInteractionEvent } from "@/lib/store/interaction/slice";
import { rgbToHex } from "@/lib/utils/helpers";
import { getLegendColorMap, getLegendMarkerMap, resolveFeatureMarker } from "@/lib/utils/map/legend";
import type { ProjectLayer, ProjectLayerTreeUpdate } from "@/lib/validations/project";
import type { GroupSwitcherType } from "@/lib/validations/widget";

import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { selectableChipSx } from "@/components/builder/widgets/common/selectableChipSx";
import { useWidgetLayerTree } from "@/components/builder/widgets/information/useWidgetLayerTree";
import { LayerIcon } from "@/components/map/panels/layer/legend/LayerIcon";
import { LayerLegendPanel } from "@/components/map/panels/layer/legend/LayerLegend";

/** How long each layer stays on the map while playing. */
export const PLAY_INTERVAL_MS = 1500;

const isVisible = (layer: ProjectLayer) => layer.properties?.visibility ?? true;

const toCssColor = (value: unknown) =>
  Array.isArray(value)
    ? value.length >= 3
      ? rgbToHex(value as [number, number, number])
      : undefined
    : (value as string | undefined);

/** The legend of the layer on the map, so the layer tree can leave the switched layers out. */
const ActiveLayerLegend = ({
  layer,
  simple,
  hideHeading,
}: {
  layer: ProjectLayer;
  simple: boolean;
  hideHeading: boolean;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (layer.properties ?? {}) as Record<string, any>;
  if (props.legend?.show === false) return null;
  const geometryType = layer.feature_layer_geometry_type?.toLowerCase() || "polygon";
  const hasBreakdown =
    !simple &&
    (getLegendColorMap(props, "color").length > 1 ||
      getLegendColorMap(props, "stroke_color").length > 1 ||
      getLegendMarkerMap(props).length > 1);
  const marker = resolveFeatureMarker(props);
  return (
    <Box sx={{ pt: 1, pl: 0.5 }}>
      {hasBreakdown ? (
        <LayerLegendPanel properties={props} geometryType={geometryType} hideHeading={hideHeading} />
      ) : (
        <Stack direction="row" alignItems="center" spacing={1}>
          <LayerIcon
            type={geometryType}
            color={toCssColor(props.color) ?? "#ccc"}
            strokeColor={props.stroked !== false ? toCssColor(props.stroke_color) : undefined}
            filled={props.filled !== false}
            iconUrl={marker?.url}
            iconSource={marker?.source ?? "library"}
          />
          <Typography variant="body2" color="text.secondary">
            {layer.name}
          </Typography>
        </Stack>
      )}
    </Box>
  );
};

interface LayerGroupSwitcherProps {
  groupId: number;
  /** Group name, announced by screen readers. */
  title?: string;
  config: GroupSwitcherType;
  /** Layers the Layers widget leaves out are not offered here either. */
  excludedLayers: number[];
  /** Layers hidden from the legend get none here either. */
  legendHiddenLayers: number[];
  /** Layers whose legend is a single row instead of the attribute breakdown. */
  simpleLegendLayers: number[];
  hideLegendHeading?: boolean;
  viewOnly?: boolean;
}

/**
 * A layer group of the Layers widget shown one layer at a time: picking a layer
 * turns it on and the others of the group off. The legend of the layer on the map
 * is shown below, since the layer tree does not list these layers.
 */
export const LayerGroupSwitcher = ({
  groupId,
  title,
  config,
  excludedLayers,
  legendHiddenLayers,
  simpleLegendLayers,
  hideLegendHeading,
  viewOnly,
}: LayerGroupSwitcherProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const { layers, updateTree } = useWidgetLayerTree(viewOnly);
  const layout = config.layout;
  const showPlay = config.show_play ?? false;

  const groupLayers = useMemo(
    () =>
      layers
        .filter((l) => l.layer_project_group_id === groupId)
        .filter((l) => !(l.layer_id && SYSTEM_LAYERS_IDS.includes(l.layer_id)))
        .filter((l) => !excludedLayers.includes(l.id))
        // Tables have nothing to show on the map; locked layers carry no style to draw
        .filter((l) => l.type !== "table" && !l.locked)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [layers, groupId, excludedLayers]
  );

  // The first visible layer counts as the current one; none visible means none picked yet
  const active = groupLayers.find(isVisible);

  // In the editor, play steps and slider drags are only shown, not saved; this marks that the
  // layer on the map has not been saved yet, so the step that ends them saves it once.
  const unsaved = useRef(false);

  const select = useCallback(
    async (layerId: number, persist = true) => {
      const changed = groupLayers.filter((l) => isVisible(l) !== (l.id === layerId));
      if (changed.length === 0 && !(persist && unsaved.current)) return;
      unsaved.current = !persist && !viewOnly;
      const payload: ProjectLayerTreeUpdate = {
        items: groupLayers.map((layer, index) => ({
          id: layer.id,
          type: "layer" as const,
          order: index,
          parent_id: null,
          properties: { ...(layer.properties ?? {}), visibility: layer.id === layerId },
        })),
      };
      changed.forEach((l) =>
        dispatch(
          emitInteractionEvent({ type: "visibility_changed", sourceId: l.id, value: l.id === layerId })
        )
      );
      await updateTree(payload, { persist });
    },
    [groupLayers, viewOnly, dispatch, updateTree]
  );

  // Viewers see exactly one layer at a time, even if the project was saved with none or several
  // on. Public view only: there the change stays local, while in the editor it would be saved.
  const tidied = useRef(false);
  useEffect(() => {
    if (!viewOnly || tidied.current || groupLayers.length === 0) return;
    tidied.current = true;
    const shown = groupLayers.filter(isVisible).length;
    if (shown !== 1) select((active ?? groupLayers[groupLayers.length - 1]).id);
  }, [viewOnly, groupLayers, active, select]);

  // Play: step through the layers in order, wrapping around
  const [playing, setPlaying] = useState(false);
  const activeIndex = active ? groupLayers.findIndex((l) => l.id === active.id) : -1;
  useEffect(() => {
    if (!playing || !showPlay || groupLayers.length < 2) return;
    const timer = setTimeout(() => {
      select(groupLayers[(activeIndex + 1) % groupLayers.length].id, false);
    }, PLAY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, showPlay, activeIndex, groupLayers, select]);

  // Stopping saves the layer playing has left on the map
  const stopPlaying = useCallback(() => {
    setPlaying(false);
    if (unsaved.current && active) select(active.id);
  }, [active, select]);
  useEffect(() => {
    if (!showPlay && playing) stopPlaying();
  }, [showPlay, playing, stopPlaying]);

  const pick = (layerId: number, persist = true) => {
    setPlaying(false);
    select(layerId, persist);
  };

  if (groupLayers.length === 0) return null;

  const groupLabel = title || t("layer_group");

  const color = theme.palette.primary.main;
  const playButton = showPlay && groupLayers.length > 1 && (
    <Tooltip title={t(playing ? "pause" : "play")} placement="top" arrow>
      <IconButton
        size="small"
        color="primary"
        aria-label={t(playing ? "pause" : "play")}
        aria-pressed={playing}
        onClick={() => (playing ? stopPlaying() : setPlaying(true))}>
        {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );

  const withLegend = (control: ReactNode) => (
    <Box>
      {control}
      {active && !legendHiddenLayers.includes(active.id) && (
        <ActiveLayerLegend
          layer={active}
          simple={simpleLegendLayers.includes(active.id)}
          hideHeading={hideLegendHeading ?? true}
        />
      )}
    </Box>
  );

  if (layout === "dropdown") {
    return withLegend(
      <Stack direction="row" alignItems="center" spacing={1}>
        {playButton}
        <Select
          fullWidth
          size="small"
          value={active?.id ?? ""}
          displayEmpty
          onChange={(e) => pick(Number(e.target.value))}
          inputProps={{ "aria-label": groupLabel }}>
          {groupLayers.map((layer) => (
            <MenuItem key={layer.id} value={layer.id}>
              {layer.name ?? ""}
            </MenuItem>
          ))}
        </Select>
      </Stack>
    );
  }

  if (layout === "slider") {
    const marks = groupLayers.map((layer, index) => ({
      value: index,
      label: layer.name ?? "",
    }));
    return withLegend(
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        {playButton}
        <Box sx={{ flex: 1, px: 1.5, pb: 1 }}>
          <Slider
            size="small"
            min={0}
            max={Math.max(groupLayers.length - 1, 1)}
            step={null}
            marks={marks}
            value={Math.max(activeIndex, 0)}
            // Dragging only shows each layer; letting go saves the one picked
            onChange={(_, value) => pick(groupLayers[value as number].id, false)}
            onChangeCommitted={(_, value) => pick(groupLayers[value as number].id)}
            getAriaValueText={(value) => groupLayers[value]?.name ?? ""}
            aria-label={groupLabel}
            sx={{
              color,
              "& .MuiSlider-markLabel": {
                fontSize: "0.75rem",
                color: theme.palette.text.secondary,
                // Each label gets its share of the track, so neighbours never overlap
                maxWidth: `calc(${100 / groupLayers.length}% - 4px)`,
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
              // Keep the outer labels inside the widget: align them to their end of the track
              '& .MuiSlider-markLabel[data-index="0"]': { transform: "translateX(-12px)" },
              [`& .MuiSlider-markLabel[data-index="${groupLayers.length - 1}"]`]: {
                transform: "translateX(calc(-100% + 12px))",
              },
              // Nothing visible yet: no thumb, so no layer looks picked
              "& .MuiSlider-thumb": { display: activeIndex < 0 ? "none" : undefined },
              "& .MuiSlider-markLabelActive": { color: theme.palette.text.primary },
              [`& .MuiSlider-markLabel[data-index="${activeIndex}"]`]: {
                color: theme.palette.text.primary,
                fontWeight: 700,
              },
            }}
          />
        </Box>
      </Stack>
    );
  }

  return withLegend(
    <Stack direction="row" alignItems="center" spacing={1}>
      {playButton}
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" role="radiogroup" aria-label={groupLabel}>
        {groupLayers.map((layer) => {
          const selected = layer.id === active?.id;
          return (
            <Chip
              key={layer.id}
              role="radio"
              aria-checked={selected}
              title={layer.name ?? undefined}
              label={layer.name ?? ""}
              size="small"
              clickable
              onClick={() => pick(layer.id)}
              sx={selectableChipSx(theme, selected, color)}
            />
          );
        })}
      </Stack>
    </Stack>
  );
};

export default LayerGroupSwitcher;
