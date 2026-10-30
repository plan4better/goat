import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Box,
  Checkbox,
  FormControlLabel,
  IconButton,
  MenuItem,
  Popover,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon, ICON_NAME } from "@p4b/ui/components/Icon";

import { useProjectLayerGroups, useProjectLayers } from "@/lib/api/projects";
import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import type { GroupSwitcherLayoutType, LayerInformationSchema } from "@/lib/validations/widget";
import { layersOutOfZoomBehaviorTypes } from "@/lib/validations/widget";
import type { Marker } from "@/lib/validations/layer";

import type { SelectorItem } from "@/types/map/common";

import { MAKI_ICON_SIZE } from "@/lib/constants/icons";

import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import SegmentedControl from "@/components/map/panels/common/SegmentedControl";
import SwitchRow from "@/components/map/panels/common/SwitchRow";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import MarkerPopper from "@/components/map/panels/style/marker/MarkerPopper";
import { MaskedImageIcon } from "@/components/map/panels/style/other/MaskedImageIcon";

interface LayersWidgetConfigProps {
  config: LayerInformationSchema;
  onChange: (config: LayerInformationSchema) => void;
}

const LayersWidgetConfig = ({ config, onChange }: LayersWidgetConfigProps) => {
  const { t } = useTranslation("common");
  const { projectId } = useParams() as { projectId: string };
  const { layers: projectLayers } = useProjectLayers(projectId);
  const { layerGroups } = useProjectLayerGroups(projectId);

  const handleSetupChange = useCallback(
    (key: string, value: unknown) => {
      onChange({
        ...config,
        setup: { ...config.setup, [key]: value },
      } as LayerInformationSchema);
    },
    [config, onChange]
  );

  const handleOptionChange = useCallback(
    (key: string, value: unknown) => {
      onChange({
        ...config,
        options: { ...config.options, [key]: value },
      } as LayerInformationSchema);
    },
    [config, onChange]
  );

  const options = config.options ?? {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = options as Record<string, any>;
  const excludedLayers: number[] = opts.excluded_layers ?? [];
  const legendHiddenLayers: number[] = opts.legend_hidden_layers ?? [];
  const legendSimpleLayers: number[] = opts.legend_simple_layers ?? [];
  const downloadableLayers: number[] = opts.downloadable_layers ?? [];
  const groupInfo = config.setup?.group_info ?? {};

  const groupSwitchers = config.setup?.group_switchers ?? {};

  /** "list" is the plain tree; the other types show the group one layer at a time. */
  const handleGroupTypeChange = useCallback(
    (groupId: number, type: "list" | GroupSwitcherLayoutType) => {
      const { [String(groupId)]: previous, ...others } = groupSwitchers;
      handleSetupChange(
        "group_switchers",
        type === "list" ? others : { ...others, [String(groupId)]: { show_play: previous?.show_play ?? false, layout: type } }
      );
    },
    [groupSwitchers, handleSetupChange]
  );

  const handleGroupPlayChange = useCallback(
    (groupId: number, showPlay: boolean) => {
      const current = groupSwitchers[String(groupId)];
      if (!current) return;
      handleSetupChange("group_switchers", { ...groupSwitchers, [String(groupId)]: { ...current, show_play: showPlay } });
    },
    [groupSwitchers, handleSetupChange]
  );

  const handleGroupInfoChange = useCallback(
    (groupId: number, value: string) => {
      const updated = { ...groupInfo, [String(groupId)]: value };
      handleSetupChange("group_info", updated);
    },
    [groupInfo, handleSetupChange]
  );

  const toggleLayerExclusion = useCallback(
    (layerId: number) => {
      const current = [...excludedLayers];
      const idx = current.indexOf(layerId);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(layerId);
      }
      handleOptionChange("excluded_layers", current);
    },
    [excludedLayers, handleOptionChange]
  );

  const toggleGroupExclusion = useCallback(
    (groupId: number) => {
      const groupLayerIds = filteredLayers
        .filter((l) => l.layer_project_group_id === groupId)
        .map((l) => l.id);
      const allExcluded = groupLayerIds.every((id) => excludedLayers.includes(id));
      let current = [...excludedLayers];
      if (allExcluded) {
        // Include all
        current = current.filter((id) => !groupLayerIds.includes(id));
      } else {
        // Exclude all
        groupLayerIds.forEach((id) => {
          if (!current.includes(id)) current.push(id);
        });
      }
      handleOptionChange("excluded_layers", current);
    },
    [excludedLayers, handleOptionChange]
  );

  const toggleArrayOption = useCallback(
    (key: string, arr: number[], id: number) => {
      const current = [...arr];
      const idx = current.indexOf(id);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(id);
      handleOptionChange(key, current);
    },
    [handleOptionChange]
  );

  const layoutStyleItems: SelectorItem[] = [
    { value: "tree", label: t("tree") },
    { value: "tabs", label: t("tabs") },
  ];

  const toggleStyleItems: SelectorItem[] = [
    { value: "eye", label: t("eye") },
    { value: "checkbox", label: t("checkbox") },
    { value: "switch", label: t("switch") },
  ];

  const togglePositionItems: SelectorItem[] = [
    { value: "left", label: t("left") },
    { value: "right", label: t("right") },
  ];

  const outOfZoomBehaviorItems: SelectorItem[] = layersOutOfZoomBehaviorTypes.options.map((value) => ({
    value,
    label: t(`out_of_zoom_${value}`),
  }));

  const moreOptionsStyleItems: SelectorItem[] = [
    { value: "compact", label: t("compact_mode"), icon: ICON_NAME.MORE_VERT },
    { value: "direct_actions", label: t("direct_actions_mode"), icon: ICON_NAME.MORE_HORIZ },
  ];

  const filteredLayers = useMemo(
    () => (projectLayers || []).filter((l) => !l.layer_id || !SYSTEM_LAYERS_IDS.includes(l.layer_id)),
    [projectLayers]
  );

  const topLevelGroups = useMemo(
    () =>
      (layerGroups || [])
        .filter((g) => !g.parent_id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [layerGroups]
  );

  return (
    <Stack direction="column" spacing={2} justifyContent="space-between">
      {/* Info */}
      <SectionHeader active alwaysActive label={t("info")} icon={ICON_NAME.CIRCLEINFO} disableAdvanceOptions />
      <SectionOptions
        active
        baseOptions={
          <>
            <TextFieldInput
              type="text"
              label={t("title")}
              placeholder={t("add_widget_title")}
              clearable={false}
              value={config.setup?.title || ""}
              onChange={(value: string) => handleSetupChange("title", value)}
            />
            <TextFieldInput
              type="text"
              label={t("description")}
              placeholder={t("add_widget_description")}
              multiline
              clearable={false}
              value={options.description || ""}
              onChange={(value: string) => handleOptionChange("description", value)}
            />
          </>
        }
      />

      {/* Layers — tree with checkboxes to include/exclude + per-layer settings */}
      <SectionHeader active alwaysActive label={t("layers")} icon={ICON_NAME.LAYERS} disableAdvanceOptions />
      <SectionOptions
        active
        baseOptions={
          <Stack spacing={0}>
            {topLevelGroups.map((group) => {
              const groupLayers = filteredLayers.filter((l) => l.layer_project_group_id === group.id);
              const allExcluded = groupLayers.length > 0 && groupLayers.every((l) => excludedLayers.includes(l.id));
              const someExcluded = groupLayers.some((l) => excludedLayers.includes(l.id));
              return (
                <Stack key={group.id} spacing={0}>
                  {/* Group row */}
                  <Stack direction="row" alignItems="center" spacing={0.5} sx={{ py: 0.25 }}>
                    <Checkbox
                      size="small"
                      checked={!allExcluded}
                      indeterminate={someExcluded && !allExcluded}
                      onChange={() => toggleGroupExclusion(group.id)}
                      sx={{ p: 0.25 }}
                    />
                    <GroupIconButton
                      marker={opts[`group_icon_${group.id}`] as Marker | undefined}
                      onSelectMarker={(marker) => handleOptionChange(`group_icon_${group.id}`, marker)}
                    />
                    <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }} noWrap>
                      {group.name}
                    </Typography>
                    <GroupInfoButton
                      groupName={group.name}
                      value={groupInfo[String(group.id)] ?? ""}
                      onChange={(value) => handleGroupInfoChange(group.id, value)}
                    />
                  </Stack>
                  {/* How the group is shown: a list, or one layer at a time. Offered where there is
                      something to switch between (the switcher leaves out tables and locked layers),
                      and always once set, so it can be undone. */}
                  {(groupSwitchers[String(group.id)] ||
                    groupLayers.filter((l) => !excludedLayers.includes(l.id) && l.type !== "table" && !l.locked)
                      .length >= 2) && (
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ pl: 3.5, pb: 0.5 }}>
                      <Select
                        size="small"
                        value={groupSwitchers[String(group.id)]?.layout ?? "list"}
                        onChange={(e) => handleGroupTypeChange(group.id, e.target.value as "list" | GroupSwitcherLayoutType)}
                        inputProps={{ "aria-label": `${t("layout_style")}: ${group.name}` }}
                        sx={{ fontSize: "0.8125rem", minWidth: 110, "& .MuiSelect-select": { py: 0.5 } }}>
                        <MenuItem value="list">{t("list")}</MenuItem>
                        <MenuItem value="chips">{t("chips")}</MenuItem>
                        <MenuItem value="slider">{t("slider")}</MenuItem>
                        <MenuItem value="dropdown">{t("dropdown")}</MenuItem>
                      </Select>
                      {groupSwitchers[String(group.id)] && (
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={groupSwitchers[String(group.id)]?.show_play ?? false}
                              onChange={(e) => handleGroupPlayChange(group.id, e.target.checked)}
                            />
                          }
                          label={<Typography variant="body2">{t("play")}</Typography>}
                          sx={{ ml: 0 }}
                        />
                      )}
                    </Stack>
                  )}
                  {/* Layers in group */}
                  {groupLayers.map((l) => (
                    <ConfigLayerRow
                      key={l.id}
                      name={l.name || ""}
                      included={!excludedLayers.includes(l.id)}
                      legendShow={!legendHiddenLayers.includes(l.id)}
                      legendSimple={legendSimpleLayers.includes(l.id)}
                      downloadable={downloadableLayers.includes(l.id)}
                      onToggleInclude={() => toggleLayerExclusion(l.id)}
                      onToggleLegend={() => toggleArrayOption("legend_hidden_layers", legendHiddenLayers, l.id)}
                      onToggleSimpleLegend={() => toggleArrayOption("legend_simple_layers", legendSimpleLayers, l.id)}
                      onToggleDownload={() => toggleArrayOption("downloadable_layers", downloadableLayers, l.id)}
                    />
                  ))}
                </Stack>
              );
            })}
            {/* Ungrouped layers */}
            {filteredLayers
              .filter((l) => !l.layer_project_group_id)
              .map((l) => (
                <ConfigLayerRow
                  key={l.id}
                  name={l.name || ""}
                  included={!excludedLayers.includes(l.id)}
                  legendShow={!legendHiddenLayers.includes(l.id)}
                  legendSimple={legendSimpleLayers.includes(l.id)}
                  downloadable={downloadableLayers.includes(l.id)}
                  onToggleInclude={() => toggleLayerExclusion(l.id)}
                  onToggleLegend={() => toggleArrayOption("legend_hidden_layers", legendHiddenLayers, l.id)}
                  onToggleSimpleLegend={() => toggleArrayOption("legend_simple_layers", legendSimpleLayers, l.id)}
                  onToggleDownload={() => toggleArrayOption("downloadable_layers", downloadableLayers, l.id)}
                />
              ))}
          </Stack>
        }
      />

      {/* Layout */}
      <SectionHeader active alwaysActive label={t("layout")} icon={ICON_NAME.SLIDERS} disableAdvanceOptions />
      <SectionOptions
        active
        baseOptions={
          <>
            <SegmentedControl
              value={options.layout_style || "tree"}
              onChange={(value) => handleOptionChange("layout_style", value)}
              items={layoutStyleItems}
              label={t("layout_style")}
            />
            <SegmentedControl
              value={options.toggle_style || "eye"}
              onChange={(value) => handleOptionChange("toggle_style", value)}
              items={toggleStyleItems}
              label={t("toggle_style")}
            />
            <SegmentedControl
              value={options.toggle_position || "right"}
              onChange={(value) => handleOptionChange("toggle_position", value)}
              items={togglePositionItems}
              label={t("toggle_position")}
            />
            <Stack spacing={0}>
              <FormControlLabel
                control={<Checkbox checked={options.show_search ?? false} onChange={(e) => handleOptionChange("show_search", e.target.checked)} size="small" />}
                label={<Typography variant="body2">{t("search_layer_bar")}</Typography>}
                sx={{ ml: 0 }}
              />
              {options.layout_style === "tabs" && (
                <>
                  <FormControlLabel
                    control={<Checkbox checked={options.show_group_name ?? true} onChange={(e) => handleOptionChange("show_group_name", e.target.checked)} size="small" />}
                    label={<Typography variant="body2">{t("show_group_name")}</Typography>}
                    sx={{ ml: 0 }}
                  />
                  <FormControlLabel
                    control={<Checkbox checked={options.show_group_icons ?? false} onChange={(e) => handleOptionChange("show_group_icons", e.target.checked)} size="small" />}
                    label={<Typography variant="body2">{t("show_group_icons")}</Typography>}
                    sx={{ ml: 0 }}
                  />
                  <FormControlLabel
                    control={<Checkbox checked={options.show_all_toggle ?? true} onChange={(e) => handleOptionChange("show_all_toggle", e.target.checked)} size="small" />}
                    label={<Typography variant="body2">{t("show_all_toggle")}</Typography>}
                    sx={{ ml: 0 }}
                  />
                </>
              )}
              <FormControlLabel
                control={<Checkbox checked={opts.hide_legend_heading ?? false} onChange={(e) => handleOptionChange("hide_legend_heading", e.target.checked)} size="small" />}
                label={<Typography variant="body2">{t("hide_attribute_name")}</Typography>}
                sx={{ ml: 0 }}
              />
            </Stack>
          </>
        }
      />

      {/* Zoom Behavior */}
      <SectionHeader active alwaysActive label={t("zoom_behavior")} icon={ICON_NAME.ZOOM_IN} disableAdvanceOptions />
      <SectionOptions
        active
        baseOptions={
          <SegmentedControl
            value={options.out_of_zoom_behavior || "hide"}
            onChange={(value) => handleOptionChange("out_of_zoom_behavior", value)}
            items={outOfZoomBehaviorItems}
            label={t("out_of_zoom_behavior")}
          />
        }
      />

      {/* Layer Actions */}
      <SectionHeader active alwaysActive label={t("layer_actions")} icon={ICON_NAME.SETTINGS} disableAdvanceOptions />
      <SectionOptions
        active
        baseOptions={
          <>
            <SegmentedControl
              value={options.more_options_style || "compact"}
              onChange={(value) => handleOptionChange("more_options_style", value)}
              items={moreOptionsStyleItems}
              label={t("more_options_style")}
            />
            <Stack spacing={0}>
              <FormControlLabel control={<Checkbox checked={options.show_style_action ?? true} onChange={(e) => handleOptionChange("show_style_action", e.target.checked)} size="small" />} label={<Typography variant="body2">{t("style")}</Typography>} sx={{ ml: 0 }} />
              <FormControlLabel control={<Checkbox checked={options.show_view_data_action ?? true} onChange={(e) => handleOptionChange("show_view_data_action", e.target.checked)} size="small" />} label={<Typography variant="body2">{t("view_data")}</Typography>} sx={{ ml: 0 }} />
              <FormControlLabel control={<Checkbox checked={options.show_properties_action ?? true} onChange={(e) => handleOptionChange("show_properties_action", e.target.checked)} size="small" />} label={<Typography variant="body2">{t("properties")}</Typography>} sx={{ ml: 0 }} />
              <FormControlLabel control={<Checkbox checked={options.show_zoom_to_action ?? true} onChange={(e) => handleOptionChange("show_zoom_to_action", e.target.checked)} size="small" />} label={<Typography variant="body2">{t("zoom_to")}</Typography>} sx={{ ml: 0 }} />
            </Stack>
          </>
        }
      />
    </Stack>
  );
};

/** Inline popover for editing a group's info text */
const GroupInfoButton = ({
  groupName,
  value,
  onChange,
}: {
  groupName: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const { t } = useTranslation("common");
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const hasContent = value.trim().length > 0;

  return (
    <>
      <Tooltip title={hasContent ? t("edit_group_info") : t("add_group_info")} placement="top">
        <IconButton
          size="small"
          onClick={(e) => setAnchorEl(anchorEl ? null : e.currentTarget)}
          sx={{
            p: 0.25,
            color: hasContent ? "primary.main" : "text.disabled",
            "&:hover": { bgcolor: hasContent ? "primary.light" : "action.hover", opacity: 0.85 },
          }}>
          <InfoOutlinedIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { p: 1.5, width: 260 } } }}>
        <Typography variant="caption" fontWeight="bold" color="text.secondary" sx={{ display: "block", mb: 0.75 }}>
          {groupName}
        </Typography>
        <TextField
          size="small"
          fullWidth
          multiline
          minRows={3}
          placeholder={t("group_info_placeholder")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 0.75 }}>
          {t("markdown_supported_hint")}
        </Typography>
      </Popover>
    </>
  );
};

/** Clickable group icon — shows default layers icon or custom marker, opens MarkerPopper on click */
const GroupIconButton = ({
  marker,
  onSelectMarker,
}: {
  marker?: Marker;
  onSelectMarker: (marker: Marker) => void;
}) => {
  const { t } = useTranslation("common");
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  return (
    <>
      <Tooltip title={t("change_icon")} placement="top">
        <Box
          onClick={(e) => setAnchorEl(anchorEl ? null : e.currentTarget as HTMLElement)}
          sx={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 0.5,
            "&:hover": { bgcolor: "action.hover" },
          }}>
          {marker?.url ? (
            <MaskedImageIcon
              imageUrl={marker.url}
              dimension={`${MAKI_ICON_SIZE * 0.6}px`}
              applyMask={marker.source === "library"}
              imgColor=""
            />
          ) : (
            <Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 14 }} />
          )}
        </Box>
      </Tooltip>
      <MarkerPopper
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        selectedMarker={marker}
        onSelectMarker={(m) => {
          onSelectMarker(m);
          setAnchorEl(null);
        }}
      />
    </>
  );
};

/** Per-layer row with checkbox + three-dot → Show in legend / Download */
const ConfigLayerRow = ({
  name,
  included,
  legendShow,
  legendSimple,
  downloadable,
  onToggleInclude,
  onToggleLegend,
  onToggleSimpleLegend,
  onToggleDownload,
}: {
  name: string;
  included: boolean;
  legendShow: boolean;
  legendSimple: boolean;
  downloadable: boolean;
  onToggleInclude: () => void;
  onToggleLegend: () => void;
  onToggleSimpleLegend: () => void;
  onToggleDownload: () => void;
}) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      sx={{ pl: 3, py: 0.25, opacity: included ? 1 : 0.5, "&:hover": { bgcolor: "action.hover" }, borderRadius: 0.5 }}>
      <Checkbox
        size="small"
        checked={included}
        onChange={onToggleInclude}
        sx={{ p: 0.25 }}
      />
      <Typography variant="body2" sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </Typography>
      <IconButton size="small" onClick={(e) => setAnchorEl(e.currentTarget)} sx={{ p: 0.25 }}>
        <Icon iconName={ICON_NAME.MORE_VERT} style={{ fontSize: 14 }} />
      </IconButton>
      {anchorEl && (
        <LayerSettingsPopover
          anchorEl={anchorEl}
          legendShow={legendShow}
          legendSimple={legendSimple}
          downloadable={downloadable}
          onToggleLegend={onToggleLegend}
          onToggleSimpleLegend={onToggleSimpleLegend}
          onToggleDownload={onToggleDownload}
          onClose={() => setAnchorEl(null)}
        />
      )}
    </Stack>
  );
};

/** Separate component so parent ConfigLayerRow doesn't re-render when toggles fire */
const LayerSettingsPopover = ({
  anchorEl,
  legendShow,
  legendSimple,
  downloadable,
  onToggleLegend,
  onToggleSimpleLegend,
  onToggleDownload,
  onClose,
}: {
  anchorEl: HTMLElement;
  legendShow: boolean;
  legendSimple: boolean;
  downloadable: boolean;
  onToggleLegend: () => void;
  onToggleSimpleLegend: () => void;
  onToggleDownload: () => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation("common");

  return (
    <Popover
      open
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{ paper: { sx: { p: 1.5, minWidth: 180 } } }}>
      <Stack spacing={0.5}>
        <SwitchRow label={t("show_in_legend")} checked={legendShow} onChange={onToggleLegend} />
        {legendShow && (
          <SwitchRow label={t("simple_legend")} checked={legendSimple} onChange={onToggleSimpleLegend} />
        )}
        <SwitchRow label={t("download")} checked={downloadable} onChange={onToggleDownload} />
      </Stack>
    </Popover>
  );
};

export default LayersWidgetConfig;
