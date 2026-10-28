"use client";

import SyncIcon from "@mui/icons-material/Sync";
import { Button, Checkbox, FormControlLabel, Stack, TextField, Typography, useTheme } from "@mui/material";
import type { StyleSpecification } from "maplibre-gl";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { lockSnapshot, visibleProjectLayers } from "@/lib/print/mapElements";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import type { SelectorItem } from "@/types/map/common";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import SelectorFreeSolo from "@/components/map/panels/common/SelectorFreeSolo";
import Selector from "@/components/map/panels/common/Selector";

// =============================================================================
// Zoom <-> Scale conversion utilities
// =============================================================================

// MapLibre uses 512px tiles. Earth circumference / tile size = 78271.51696
const METERS_PER_PIXEL_AT_ZOOM0 = 78271.51696;

// Standard screen DPI assumption for scale calculation
const SCREEN_DPI = 96;
const METERS_PER_INCH = 0.0254;
const METERS_PER_PIXEL_SCREEN = METERS_PER_INCH / SCREEN_DPI;

/**
 * Convert zoom level + latitude to scale denominator (e.g. 5000 for 1:5,000)
 */
function zoomToScale(zoom: number, latitude: number): number {
  const metersPerPixelMap =
    (METERS_PER_PIXEL_AT_ZOOM0 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  return Math.round(metersPerPixelMap / METERS_PER_PIXEL_SCREEN);
}

/**
 * Convert scale denominator + latitude to zoom level
 */
function scaleToZoom(scale: number, latitude: number): number {
  const metersPerPixelMap = scale * METERS_PER_PIXEL_SCREEN;
  const zoom = Math.log2(
    (METERS_PER_PIXEL_AT_ZOOM0 * Math.cos((latitude * Math.PI) / 180)) / metersPerPixelMap
  );
  return Math.round(zoom * 100) / 100; // 2 decimal places
}

/**
 * Format scale denominator for display: 5000 -> "1:5,000"
 */
function formatScale(scale: number): string {
  return `1:${scale.toLocaleString()}`;
}

/**
 * Parse scale string to denominator: "1:5,000" -> 5000, "5000" -> 5000
 */
function parseScale(input: string): number | null {
  // Remove "1:" prefix, spaces, and thousand separators
  const cleaned = input.replace(/^1\s*:\s*/, "").replace(/[,.\s]/g, "");
  const num = parseInt(cleaned, 10);
  return isNaN(num) || num <= 0 ? null : num;
}

// Predefined scales commonly used in cartography/GIS
const PREDEFINED_SCALES = [
  500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
];

// =============================================================================

interface MapElementConfigProps {
  element: ReportElement;
  projectLayers?: MapLayer[];
  basemapUrl?: string | StyleSpecification;
  onChange: (updates: Partial<ReportElement>) => void;
  onSyncLayers?: () => void;
}

type AtlasMode = "best_fit" | "fixed_scale";

const MapElementConfig: React.FC<MapElementConfigProps> = ({ element, projectLayers = [], basemapUrl, onChange, onSyncLayers }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  // Section collapsed states
  const [mainPropertiesCollapsed, setMainPropertiesCollapsed] = useState(false);
  const [layersCollapsed, setLayersCollapsed] = useState(false);
  const [atlasCollapsed, setAtlasCollapsed] = useState(false);

  // Get current settings from element config
  const viewState = element.config?.viewState || {};
  const currentZoom = viewState.zoom ?? 10;
  const currentLatitude = viewState.latitude ?? 48;
  const currentRotation = viewState.bearing ?? 0;
  // If the user explicitly picked a scale, we stored it here so we can display it exactly
  const storedScale = viewState.scale_denominator as number | undefined;

  // Display scale: use stored exact value if available, otherwise derive from zoom
  const displayScale = storedScale ?? zoomToScale(currentZoom, currentLatitude);

  // Predefined scale options for the free-solo selector
  const scaleOptions: SelectorItem[] = useMemo(
    () =>
      PREDEFINED_SCALES.map((s) => ({
        label: formatScale(s),
        value: s,
      })),
    []
  );

  // Find the closest matching predefined scale, or create a custom item
  const selectedScaleItem: SelectorItem = useMemo(() => {
    const match = scaleOptions.find((opt) => opt.value === displayScale);
    if (match) return match;
    return { label: formatScale(displayScale), value: displayScale };
  }, [scaleOptions, displayScale]);

  // Layer lock settings
  const lockLayers = element.config?.lock_layers ?? false;
  const lockStyles = element.config?.lock_styles ?? false;

  // Atlas control settings
  const atlasEnabled = element.config?.atlas?.enabled ?? false;
  const atlasMode: AtlasMode = element.config?.atlas?.mode ?? "best_fit";
  const marginPercent = element.config?.atlas?.margin_percent ?? 10;

  // Mode selector items
  const modeItems: SelectorItem[] = useMemo(
    () => [
      { label: t("margin_around_feature"), value: "best_fit" },
      { label: t("fixed_scale"), value: "fixed_scale" },
    ],
    [t]
  );

  const selectedModeItem = useMemo(
    () => modeItems.find((item) => item.value === atlasMode),
    [modeItems, atlasMode]
  );

  // Update viewState helper
  const updateViewState = useCallback(
    (updates: Record<string, unknown>) => {
      onChange({
        config: {
          ...element.config,
          viewState: {
            ...element.config?.viewState,
            ...updates,
          },
        },
      });
    },
    [element.config, onChange]
  );

  // Handle scale selection (from dropdown or typed)
  const handleScaleChange = (item: SelectorItem | undefined) => {
    if (!item) return;
    const scaleValue =
      typeof item.value === "number" ? item.value : parseScale(String(item.value));
    if (scaleValue) {
      const newZoom = scaleToZoom(scaleValue, currentLatitude);
      // Store both the zoom and the exact scale denominator so display matches exactly
      updateViewState({ zoom: newZoom, scale_denominator: scaleValue });
    }
  };

  const handleRotationChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value)) {
      const normalized = ((value % 360) + 360) % 360;
      const bearing = normalized > 180 ? normalized - 360 : normalized;
      updateViewState({ bearing });
    }
  };

  // Layer lock handlers
  const captureLayerSnapshot = (layers: boolean, styles: boolean) => {
    onChange({
      config: lockSnapshot(
        { ...element.config, lock_layers: layers, lock_styles: styles },
        visibleProjectLayers(projectLayers),
        basemapUrl
      ),
    });
  };

  const handleLockLayersChange = (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    if (checked) {
      captureLayerSnapshot(true, lockStyles);
    } else {
      captureLayerSnapshot(false, false);
    }
  };

  const handleLockStylesChange = (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    captureLayerSnapshot(lockLayers, checked);
  };

  const handleSyncLayers = () => {
    captureLayerSnapshot(lockLayers, lockStyles);
    onSyncLayers?.();
  };

  // Atlas handlers
  const handleAtlasEnabledChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    onChange({
      config: {
        ...element.config,
        atlas: {
          ...element.config?.atlas,
          enabled,
        },
      },
    });
  };

  const handleModeChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item || Array.isArray(item)) return;
    const mode = item.value as AtlasMode;
    onChange({
      config: {
        ...element.config,
        atlas: {
          ...element.config?.atlas,
          mode,
        },
      },
    });
  };

  const handleMarginChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    if (!isNaN(value) && value >= 0 && value <= 100) {
      onChange({
        config: {
          ...element.config,
          atlas: {
            ...element.config?.atlas,
            margin_percent: value,
          },
        },
      });
    }
  };

  // Count locked layers for display
  const lockedLayerCount = (element.config?.locked_layer_ids as number[] | undefined)?.length ?? 0;

  return (
    <Stack spacing={2}>
      {/* Main Properties Section */}
      <SectionHeader
        label={t("main_properties")}
        icon={ICON_NAME.MAP}
        active={true}
        alwaysActive
        collapsed={mainPropertiesCollapsed}
        setCollapsed={setMainPropertiesCollapsed}
        disableAdvanceOptions
      />
      <SectionOptions
        active={true}
        collapsed={mainPropertiesCollapsed}
        baseOptions={
          <Stack spacing={3}>
            {/* Scale */}
            <SelectorFreeSolo
              label={t("scale")}
              options={scaleOptions}
              selectedItem={selectedScaleItem}
              onSelect={handleScaleChange}
              placeholder="1:10,000"
            />

            {/* Rotation */}
            <Stack spacing={0.5}>
              <FormLabelHelper label={t("map_rotation")} color={theme.palette.text.secondary} />
              <TextField
                type="number"
                size="small"
                value={currentRotation}
                onChange={handleRotationChange}
                InputProps={{
                  endAdornment: (
                    <Typography variant="body2" color="text.secondary">
                      °
                    </Typography>
                  ),
                }}
              />
            </Stack>
          </Stack>
        }
      />

      {/* Layers Section */}
      <SectionHeader
        label={t("layers")}
        icon={ICON_NAME.LAYERS}
        active={true}
        alwaysActive
        collapsed={layersCollapsed}
        setCollapsed={setLayersCollapsed}
        disableAdvanceOptions
      />
      <SectionOptions
        active={true}
        collapsed={layersCollapsed}
        baseOptions={
          <Stack spacing={1}>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={lockLayers}
                  onChange={handleLockLayersChange}
                />
              }
              label={
                <Typography variant="body2">
                  {t("lock_layers")}
                </Typography>
              }
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={lockStyles}
                  onChange={handleLockStylesChange}
                  disabled={!lockLayers}
                />
              }
              label={
                <Typography variant="body2" color={!lockLayers ? "text.disabled" : "text.primary"}>
                  {t("lock_styles")}
                </Typography>
              }
            />
            {lockLayers && (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  {t("locked_layers_count", { count: lockedLayerCount })}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<SyncIcon />}
                  onClick={handleSyncLayers}
                  sx={{ textTransform: "none" }}>
                  {t("sync_layers")}
                </Button>
              </Stack>
            )}
          </Stack>
        }
      />

      {/* Controlled by Atlas Section */}
      <SectionHeader
        label={t("controlled_by_atlas")}
        icon={ICON_NAME.LAYERS}
        active={atlasEnabled}
        onToggleChange={handleAtlasEnabledChange}
        collapsed={atlasCollapsed}
        setCollapsed={setAtlasCollapsed}
        disableAdvanceOptions
      />
      <SectionOptions
        active={atlasEnabled}
        collapsed={atlasCollapsed}
        baseOptions={
          <Stack spacing={3}>
            <Selector
              selectedItems={selectedModeItem}
              setSelectedItems={handleModeChange}
              items={modeItems}
              label={t("mode")}
            />

            {atlasMode === "best_fit" && (
              <Stack spacing={0.5}>
                <FormLabelHelper label={t("margin_percent")} color={theme.palette.text.secondary} />
                <TextField
                  type="number"
                  size="small"
                  value={marginPercent}
                  onChange={handleMarginChange}
                  inputProps={{ min: 0, max: 100 }}
                  InputProps={{
                    endAdornment: (
                      <Typography variant="body2" color="text.secondary">
                        %
                      </Typography>
                    ),
                  }}
                />
              </Stack>
            )}

            {atlasMode === "fixed_scale" && (
              <Typography variant="caption" color="text.secondary">
                {t("fixed_scale_uses_main_properties")}
              </Typography>
            )}
          </Stack>
        }
      />
    </Stack>
  );
};

export default MapElementConfig;
