import { Box, Button, FormControl, Link, MenuItem, Select, Stack, Switch, TextField, Typography, useTheme } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { BASEMAPS } from "@/lib/constants/basemaps";

import WidgetColorPicker from "@/components/builder/widgets/common/WidgetColorPicker";

import { languages } from "@/i18n/settings";

import type { InteractionRule } from "@/lib/validations/interaction";
import type {
  BuilderPanelSchema,
  ControlKey,
  ControlPositions,
  Project,
  ProjectLayer,
  ProjectLayerGroup,
  SearchSettings as SearchSettingsType,
} from "@/lib/validations/project";
import { DEFAULT_CONTROL_POSITIONS, DEFAULT_FAVICON_URL, builderConfigSchema } from "@/lib/validations/project";

import InteractionsModal, { InteractionsEntryButton } from "@/components/builder/InteractionsModal";
import MapControlsLayout from "@/components/builder/MapControlsLayout";
import NumberLocaleSelect from "@/components/builder/settings/NumberLocaleSelect";
import { SearchSettingsSection } from "@/components/builder/settings/SearchSettings";
import SocialPreviewImagePicker from "@/components/builder/SocialPreviewImagePicker";
import SettingsGroupHeader from "@/components/builder/widgets/common/SettingsGroupHeader";
import ConfirmModal from "@/components/modals/Confirm";
import Selector from "@/components/map/panels/common/Selector";
import SliderInput from "@/components/map/panels/common/SliderInput";
import MarkerIconPicker from "@/components/map/panels/style/marker/MarkerIconPicker";

/** Google Fonts available for dashboard display */
const DASHBOARD_FONTS = [
  { label: "Mulish", value: "Mulish, sans-serif" },
  { label: "Roboto", value: "Roboto, sans-serif" },
  { label: "Open Sans", value: "'Open Sans', sans-serif" },
  { label: "Lato", value: "Lato, sans-serif" },
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Poppins", value: "Poppins, sans-serif" },
  { label: "Montserrat", value: "Montserrat, sans-serif" },
  { label: "Nunito", value: "Nunito, sans-serif" },
  { label: "Source Sans 3", value: "'Source Sans 3', sans-serif" },
  { label: "Raleway", value: "Raleway, sans-serif" },
  { label: "PT Sans", value: "'PT Sans', sans-serif" },
  { label: "Merriweather", value: "Merriweather, serif" },
  { label: "Playfair Display", value: "'Playfair Display', serif" },
  { label: "Lora", value: "Lora, serif" },
];

const GOAT_GREEN = "#2BB381";
const DEFAULT_ICON_COLOR = "#8A8D93";
const DEFAULT_FONT_COLOR = "#3A3541";

interface SettingsTabProps {
  settings: { [key: string]: unknown };
  onChange: (name: string, value: unknown) => void;
  onReset: () => void;
  project?: Project;
  projectLayers?: ProjectLayer[];
  projectLayerGroups?: ProjectLayerGroup[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (key: string, value: any, refresh?: boolean) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  settings,
  onChange,
  onReset,
  project,
  projectLayers = [],
  projectLayerGroups = [],
  onProjectUpdate,
}) => {
  const { t } = useTranslation("common");

  const [showInteractionsModal, setShowInteractionsModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const theme = useTheme();
  const { map } = useMap();

  const currentMapView = settings?.map_view as { min_zoom?: number | null; max_zoom?: number | null } | undefined;
  const [zoomLevels, setZoomLevels] = useState<number[]>([
    currentMapView?.min_zoom ?? 0,
    currentMapView?.max_zoom ?? 22,
  ]);

  // Live map zoom, mirrored onto the slider as a marker (same as the style panel)
  const [currentZoom, setCurrentZoom] = useState<number>(map?.getZoom() ?? 0);
  useEffect(() => {
    if (!map) return;
    const updateZoom = () => setCurrentZoom(map.getZoom());
    map.on("move", updateZoom);
    updateZoom();
    return () => {
      map.off("move", updateZoom);
    };
  }, [map]);
  const currentZoomPercent = Math.min(Math.max((currentZoom / 22) * 100, 0), 100);

  const builderConfig = useMemo(() => {
    const parsed = builderConfigSchema.safeParse(project?.builder_config);
    return parsed.success ? parsed.data : undefined;
  }, [project]);

  const interactions = useMemo(
    () => (builderConfig?.interactions ?? []) as InteractionRule[],
    [builderConfig]
  );

  const panels = useMemo(
    () => (builderConfig?.interface ?? []) as BuilderPanelSchema[],
    [builderConfig]
  );

  const handleInteractionsChange = (newInteractions: InteractionRule[]) => {
    if (!builderConfig) return;
    const updatedConfig = { ...builderConfig, interactions: newInteractions };
    onProjectUpdate?.("builder_config", updatedConfig);
  };

  return (
    <Stack direction="column" spacing={2} justifyContent="space-between" sx={{ p: 3 }}>
      <Stack direction="column">
        {/* ── Map ── */}
        <Box sx={{ mb: 6 }}>
          <SettingsGroupHeader label={t("map")} />
          <Stack spacing={2}>
            {/* Toolbar / Scalebar toggles */}
            <Stack direction="row" alignItems="center">
              <Switch
                size="small"
                name="toolbar"
                checked={(settings?.toolbar as boolean) ?? true}
                onChange={(e) => onChange("toolbar", e.target.checked)}
              />
              <Typography variant="body2" color="textSecondary">
                {t("toolbar")}
              </Typography>
            </Stack>
            <Stack direction="row" alignItems="center">
              <Switch
                size="small"
                name="scalebar"
                checked={(settings?.scalebar as boolean) ?? true}
                onChange={(e) => onChange("scalebar", e.target.checked)}
              />
              <Typography variant="body2" color="textSecondary">
                {t("scalebar")}
              </Typography>
            </Stack>

            {/* Control layout picker */}
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: "block" }}>
                {t("control_layout")}
              </Typography>
              <MapControlsLayout
                controlPositions={(settings?.control_positions as ControlPositions) ?? DEFAULT_CONTROL_POSITIONS}
                onChange={(positions) => onChange("control_positions", positions)}
              />
            </Box>

            {/* Basemap allowlist — only shown when basemap control is placed in any corner */}
            {Object.values((settings?.control_positions as ControlPositions) ?? {}).some((arr) => (arr as ControlKey[]).includes("basemap")) && (() => {
              const customBasemapItems = (project?.custom_basemaps ?? []).map((cb) => ({
                value: cb.id,
                label: cb.name,
              }));
              // Translated like the map's basemap selector; built-ins sharing a
              // title (the BKG maps) are told apart by their subtitle.
              const builtInTitle = (b: (typeof BASEMAPS)[number]) =>
                t(`basemap_types.${b.value}.title`, { defaultValue: b.title });
              const builtInLabel = (b: (typeof BASEMAPS)[number]) =>
                BASEMAPS.filter((other) => builtInTitle(other) === builtInTitle(b)).length > 1
                  ? `${builtInTitle(b)} – ${t(`basemap_types.${b.value}.subtitle`, { defaultValue: b.subtitle })}`
                  : builtInTitle(b);
              const allBasemapItems = [
                ...BASEMAPS.map((b) => ({ value: b.value, label: builtInLabel(b) })),
                ...customBasemapItems,
              ];
              return (
                <Box>
                  <Selector
                    multiple
                    label={t("allowed_basemaps")}
                    placeholder={t("basemaps")}
                    items={allBasemapItems}
                    selectedItems={
                      (settings?.allowed_basemaps as string[] | null) === null
                        ? allBasemapItems
                        : allBasemapItems.filter((b) =>
                            (settings?.allowed_basemaps as string[]).includes(b.value)
                          )
                    }
                    setSelectedItems={(items) => {
                      const selected = (items as { value: string; label: string }[] ?? []).map((i) => i.value);
                      onChange(
                        "allowed_basemaps",
                        selected.length === allBasemapItems.length ? null : selected
                      );
                    }}
                  />
                </Box>
              );
            })()}

            {/* Zoom limits — dashboard-only min/max zoom */}
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                {t("zoom_limits")}
              </Typography>
              <Typography variant="caption" color="text.disabled" sx={{ mb: 1, display: "block" }}>
                {t("zoom_limits_help")}
              </Typography>
              <Box sx={{ position: "relative", width: "100%", px: 4, mt: 3 }}>
                {/* Current map zoom marker above the slider */}
                <Box sx={{ position: "absolute", top: 0, left: 0, right: 0, padding: "0 16px" }}>
                  <Box sx={{ position: "relative", width: "100%" }}>
                    <Box
                      sx={{
                        position: "absolute",
                        top: "-12px",
                        left: `${currentZoomPercent}%`,
                        transform: "translateX(-50%)",
                        pointerEvents: "none",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                      }}>
                      <Typography variant="caption" fontWeight="bold" sx={{ fontSize: 12, lineHeight: 1, mb: "2px" }}>
                        {currentZoom.toFixed(1)}
                      </Typography>
                      <Box
                        sx={{
                          width: 0,
                          height: 0,
                          borderLeft: "6px solid transparent",
                          borderRight: "6px solid transparent",
                          borderTop: `6px solid ${theme.palette.primary.main}`,
                        }}
                      />
                    </Box>
                  </Box>
                </Box>
                <SliderInput
                  value={zoomLevels}
                  isRange
                  min={0}
                  max={22}
                  step={1}
                  onChange={(value) => setZoomLevels(value as number[])}
                  onChangeCommitted={(value) => {
                    const [min, max] = value as number[];
                    onChange("map_view", {
                      ...(settings?.map_view as Record<string, unknown>),
                      min_zoom: min,
                      max_zoom: max,
                    });
                  }}
                />
              </Box>
            </Box>
          </Stack>
        </Box>
        {/* ── Search ── */}
        <Box sx={{ mb: 6 }}>
          <SearchSettingsSection
            settings={(settings?.search as SearchSettingsType) ?? { places: true, layers: [] }}
            projectLayers={projectLayers}
            onChange={(next) => onChange("search", next)}
          />
        </Box>
        <Box sx={{ mb: 6 }}>
          <SettingsGroupHeader label={t("branding")} />
          <Stack spacing={2}>
            {/* Font */}
            {(() => {
              const CUSTOM_SENTINEL = "__custom__";
              const fontUrl = settings?.font_url as string | undefined;
              const isCustom = typeof fontUrl === "string";
              const selectValue = isCustom
                ? CUSTOM_SENTINEL
                : (settings?.font_family as string) || "Mulish, sans-serif";
              return (
                <>
                  <FormControl size="small" fullWidth>
                    <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
                      {t("font")}
                    </Typography>
                    <Select
                      value={selectValue}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === CUSTOM_SENTINEL) {
                          onChange("font_url", "");
                        } else {
                          onChange("font_url", undefined);
                          onChange("font_family", value);
                        }
                      }}
                      renderValue={(selected) => {
                        if (selected === CUSTOM_SENTINEL) return t("custom_font");
                        const font = DASHBOARD_FONTS.find((f) => f.value === selected);
                        return font?.label ?? "Mulish";
                      }}>
                      {DASHBOARD_FONTS.map((font) => (
                        <MenuItem key={font.value} value={font.value}>
                          <Typography sx={{ fontFamily: font.value }}>{font.label}</Typography>
                        </MenuItem>
                      ))}
                      <MenuItem value={CUSTOM_SENTINEL}>
                        <Typography>{t("custom_font")}</Typography>
                      </MenuItem>
                    </Select>
                  </FormControl>
                  {isCustom && (
                    <>
                      <Box>
                        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: "block" }}>
                          {t("font_url")}
                        </Typography>
                        <TextField
                          size="small"
                          fullWidth
                          placeholder="https://example.com/font.woff2"
                          value={fontUrl ?? ""}
                          onChange={(e) => onChange("font_url", e.target.value)}
                        />
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: "block" }}>
                          {t("font_family")}
                        </Typography>
                        <TextField
                          size="small"
                          fullWidth
                          placeholder="BaWue Sans, sans-serif"
                          value={(settings?.font_family as string) ?? ""}
                          onChange={(e) => onChange("font_family", e.target.value)}
                        />
                      </Box>
                    </>
                  )}
                </>
              );
            })()}

            {/* Primary Color */}
            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t("primary_color")}
                </Typography>
                {!!settings?.primary_color && (
                  <Link
                    component="button"
                    variant="caption"
                    underline="always"
                    onClick={() => onChange("primary_color", undefined)}
                    sx={{ cursor: "pointer" }}>
                    {t("reset")}
                  </Link>
                )}
              </Stack>
              <WidgetColorPicker
                color={(settings?.primary_color as string) || GOAT_GREEN}
                onChange={(color) => onChange("primary_color", color)}
              />
            </Box>

            {/* Icon Color */}
            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t("icon_color")}
                </Typography>
                {!!settings?.icon_color && (
                  <Link
                    component="button"
                    variant="caption"
                    underline="always"
                    onClick={() => onChange("icon_color", undefined)}
                    sx={{ cursor: "pointer" }}>
                    {t("reset")}
                  </Link>
                )}
              </Stack>
              <WidgetColorPicker
                color={(settings?.icon_color as string) || DEFAULT_ICON_COLOR}
                onChange={(color) => onChange("icon_color", color)}
              />
            </Box>

            {/* Font Color */}
            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t("font_color")}
                </Typography>
                {!!settings?.font_color && (
                  <Link
                    component="button"
                    variant="caption"
                    underline="always"
                    onClick={() => onChange("font_color", undefined)}
                    sx={{ cursor: "pointer" }}>
                    {t("reset")}
                  </Link>
                )}
              </Stack>
              <WidgetColorPicker
                color={(settings?.font_color as string) || DEFAULT_FONT_COLOR}
                onChange={(color) => onChange("font_color", color)}
              />
            </Box>

            {/* Favicon */}
            <MarkerIconPicker
              label={t("favicon")}
              selectedMarker={
                settings?.favicon_url
                  ? {
                      name: (settings.favicon_url as string) === DEFAULT_FAVICON_URL ? "GOAT" : t("favicon"),
                      url: settings.favicon_url as string,
                      category: "",
                      source: "custom",
                    }
                  : undefined
              }
              onSelectMarker={(marker) => {
                onChange("favicon_url", marker.url || DEFAULT_FAVICON_URL);
              }}
            />

            {/* App icon (PWA / home-screen). Falls back to the GOAT logo —
                deliberately NOT to the favicon. */}
            <Box>
              <MarkerIconPicker
                label={t("app_icon")}
                selectedMarker={
                  settings?.app_icon_url
                    ? {
                        name: t("app_icon"),
                        url: settings.app_icon_url as string,
                        category: "",
                        source: "custom",
                      }
                    : undefined
                }
                onSelectMarker={(marker) => {
                  onChange("app_icon_url", marker.url ?? "");
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {t("app_icon_description")}
              </Typography>
            </Box>

          </Stack>
        </Box>
        {/* ── Social sharing ── */}
        <Box sx={{ mb: 6 }}>
          <SettingsGroupHeader label={t("social_sharing")} />
          <Stack spacing={2}>
            <Typography variant="caption" color="text.secondary">
              {t("social_sharing_description")}
            </Typography>
            <SocialPreviewImagePicker
              label={t("social_preview_image")}
              imageUrl={settings?.og_image_url as string | undefined}
              helperText={t("social_preview_image_helper")}
              onChange={(url) => onChange("og_image_url", url)}
            />
            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t("meta_description")}
                </Typography>
                {!!settings?.meta_description && (
                  <Link
                    component="button"
                    variant="caption"
                    underline="always"
                    onClick={() => onChange("meta_description", undefined)}
                    sx={{ cursor: "pointer" }}>
                    {t("reset")}
                  </Link>
                )}
              </Stack>
              <TextField
                size="small"
                fullWidth
                multiline
                rows={3}
                value={(settings?.meta_description as string) ?? ""}
                onChange={(e) =>
                  onChange("meta_description", e.target.value ? e.target.value.slice(0, 300) : undefined)
                }
                placeholder={t("meta_description_placeholder")}
                helperText={`${((settings?.meta_description as string) ?? "").length} / 300 — ${t("meta_description_helper")}`}
              />
            </Box>
          </Stack>
        </Box>
        {/* ── General ── */}
        <Box sx={{ mb: 6 }}>
          <SettingsGroupHeader label={t("general")} />
          <Stack spacing={2}>
            <FormControl size="small" fullWidth>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
                {t("language")}
              </Typography>
              <Select
                value={(settings?.language as string) ?? "auto"}
                onChange={(e) => onChange("language", e.target.value)}>
                <MenuItem value="auto">{t("auto_browser_default")}</MenuItem>
                {languages.map((lng) => (
                  <MenuItem key={lng} value={lng}>
                    {lng === "en" ? "English" : lng === "de" ? "Deutsch" : lng}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {project && onProjectUpdate && (
              <NumberLocaleSelect
                value={project.locale}
                onChange={(locale) => onProjectUpdate("locale", locale)}
              />
            )}
          </Stack>
        </Box>
        {project && onProjectUpdate && (
          <Box sx={{ mb: 6 }}>
            <SettingsGroupHeader label={t("interactions")} />
            <InteractionsEntryButton
              interactionCount={interactions.filter((r) => r.enabled).length}
              onClick={() => setShowInteractionsModal(true)}
            />
          </Box>
        )}
      </Stack>
      <Stack>
        <Button onClick={() => setShowResetConfirm(true)} fullWidth size="small" color="error">
          <Typography variant="body2" fontWeight="bold" color="inherit">
            {t("common:reset")}
          </Typography>
        </Button>
      </Stack>
      <ConfirmModal
        open={showResetConfirm}
        title={t("common:reset_dashboard_title")}
        body={t("common:reset_dashboard_body")}
        closeText={t("common:cancel")}
        confirmText={t("common:reset")}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={() => {
          setShowResetConfirm(false);
          onReset();
        }}
      />
      {showInteractionsModal && builderConfig && (
        <InteractionsModal
          open={showInteractionsModal}
          onClose={() => setShowInteractionsModal(false)}
          interactions={interactions}
          onChange={handleInteractionsChange}
          panels={panels}
          projectLayers={projectLayers}
          projectLayerGroups={projectLayerGroups}
        />
      )}
    </Stack>
  );
};

export default SettingsTab;
