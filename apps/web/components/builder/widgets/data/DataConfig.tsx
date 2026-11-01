import DeleteIcon from "@mui/icons-material/Delete";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import {
  Checkbox,
  FormControlLabel,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type {
  FilterDataSchema,
  FilterLayoutTypes,
  WidgetDataConfig,
} from "@/lib/validations/widget";
import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import { filterLayoutTypes } from "@/lib/validations/widget";

import type { SelectorItem } from "@/types/map/common";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useLayerDatasetId } from "@/hooks/map/ToolsHooks";

import WidgetColorPicker from "@/components/builder/widgets/common/WidgetColorPicker";
import CategoryColorConfig from "@/components/builder/widgets/data/CategoryColorConfig";
import FilterValueLabelConfig from "@/components/builder/widgets/data/FilterValueLabelConfig";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import Selector from "@/components/map/panels/common/Selector";
import SliderInput from "@/components/map/panels/common/SliderInput";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

export type FilterDataConfigurationProps = {
  config: WidgetDataConfig;
  onChange: (config: WidgetDataConfig) => void;
};

// Component for a single target layer item
interface TargetLayerItemProps {
  layerName: string;
  columnName: string;
  columnOptions: SelectorItem[];
  onColumnChange: (column: string) => void;
  onRemove: () => void;
}

const TargetLayerItem = ({
  layerName,
  columnName,
  columnOptions,
  onColumnChange,
  onRemove,
}: TargetLayerItemProps) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);

  const selectedColumn = useMemo(() => {
    return columnOptions.find((col) => col.value === columnName);
  }, [columnOptions, columnName]);

  return (
    <Stack
      spacing={1}
      sx={{
        p: 1,
        backgroundColor: theme.palette.background.paper,
        borderRadius: 1,
        border: `1px solid ${theme.palette.divider}`,
      }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography
          variant="body2"
          fontWeight="medium"
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}>
          {layerName}
        </Typography>
        <IconButton size="small" onClick={(e) => setMenuAnchorEl(e.currentTarget)}>
          <MoreVertIcon fontSize="small" />
        </IconButton>
        <Menu anchorEl={menuAnchorEl} open={Boolean(menuAnchorEl)} onClose={() => setMenuAnchorEl(null)}>
          <MenuItem
            onClick={() => {
              setMenuAnchorEl(null);
              onRemove();
            }}>
            <ListItemIcon>
              <DeleteIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>{t("remove")}</ListItemText>
          </MenuItem>
        </Menu>
      </Stack>
      <Selector
        selectedItems={selectedColumn}
        setSelectedItems={(item: SelectorItem) => {
          if (item?.value) {
            onColumnChange(item.value as string);
          }
        }}
        items={columnOptions}
        label={t("column")}
        placeholder={t("select_field")}
      />
    </Stack>
  );
};

// Wrapper component that fetches fields for a target layer
interface TargetLayerItemWithFieldsProps {
  layerId: string;
  layerName: string;
  columnName: string;
  onColumnChange: (column: string) => void;
  onRemove: () => void;
}

const TargetLayerItemWithFields = ({
  layerId,
  layerName,
  columnName,
  onColumnChange,
  onRemove,
}: TargetLayerItemWithFieldsProps) => {
  const { layerFields } = useLayerFields(layerId);

  const columnOptions = useMemo(() => {
    return (
      layerFields?.map((field) => ({
        value: field.name,
        label: field.name,
      })) || []
    );
  }, [layerFields]);

  return (
    <TargetLayerItem
      layerName={layerName}
      columnName={columnName}
      columnOptions={columnOptions}
      onColumnChange={onColumnChange}
      onRemove={onRemove}
    />
  );
};

// Extracted component for target layers configuration (used by WidgetOptions)
interface TargetLayersConfigProps {
  layerProjectId: number;
  targetLayers?: { layer_project_id: number; column_name: string }[];
  projectLayers: { id: number; name: string; layer_id: string }[];
  onTargetLayersChange: (targets: { layer_project_id: number; column_name: string }[] | undefined) => void;
}

export const TargetLayersConfig = ({
  layerProjectId,
  targetLayers,
  projectLayers,
  onTargetLayersChange,
}: TargetLayersConfigProps) => {
  const { t } = useTranslation("common");

  // Available layers for target selection (excluding the primary filter layer)
  const availableTargetLayers = useMemo(() => {
    if (!projectLayers) return [];
    const existingTargetIds = targetLayers?.map((t) => t.layer_project_id) || [];

    return projectLayers
      .filter((layer) => layer.id !== layerProjectId && !existingTargetIds.includes(layer.id))
      .map((layer) => ({
        value: layer.id,
        label: layer.name,
      }));
  }, [projectLayers, layerProjectId, targetLayers]);

  // Handler to add a target layer
  const handleAddTargetLayer = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item || Array.isArray(item)) return;
    const layerId = item.value as number;
    const newTarget = { layer_project_id: layerId, column_name: "" };
    const currentTargets = targetLayers || [];
    onTargetLayersChange([...currentTargets, newTarget]);
  };

  // Handler to update a target layer's column
  const handleUpdateTargetColumn = (index: number, newColumnName: string) => {
    const currentTargets = [...(targetLayers || [])];
    currentTargets[index] = { ...currentTargets[index], column_name: newColumnName };
    onTargetLayersChange(currentTargets);
  };

  // Handler to remove a target layer
  const handleRemoveTargetLayer = (index: number) => {
    const currentTargets = [...(targetLayers || [])];
    currentTargets.splice(index, 1);
    onTargetLayersChange(currentTargets.length > 0 ? currentTargets : undefined);
  };

  return (
    <Stack spacing={1}>
      <Typography variant="body2" fontWeight="medium">
        {t("apply_to_additional_layers")}
      </Typography>
      {/* Add layer dropdown */}
      {availableTargetLayers.length > 0 && (
        <Selector
          selectedItems={undefined}
          setSelectedItems={handleAddTargetLayer}
          items={availableTargetLayers}
          label={t("add_layer")}
          placeholder={t("select_layer")}
        />
      )}

      {/* List of target layers */}
      {targetLayers?.map((target, index) => {
        const targetLayer = projectLayers?.find((l) => l.id === target.layer_project_id);
        if (!targetLayer) return null;

        return (
          <TargetLayerItemWithFields
            key={target.layer_project_id}
            layerId={targetLayer.layer_id}
            layerName={targetLayer.name}
            columnName={target.column_name}
            onColumnChange={(column) => handleUpdateTargetColumn(index, column)}
            onRemove={() => handleRemoveTargetLayer(index)}
          />
        );
      })}

      {!targetLayers?.length && availableTargetLayers.length === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
          {t("no_additional_layers_available")}
        </Typography>
      )}
    </Stack>
  );
};

export const WidgetFilterLayout = ({
  config,
  onChange,
}: {
  config: FilterDataSchema;
  onChange: (config: FilterDataSchema) => void;
}) => {
  const { t } = useTranslation("common");
  const { projectId } = useParams();

  // Get the dataset ID from the selected layer
  const selectedLayerDatasetId = useLayerDatasetId(
    config.setup?.layer_project_id as number | undefined,
    projectId as string
  );

  const { layerFields } = useLayerFields(selectedLayerDatasetId ?? "");
  const isTemporal = useMemo<boolean>(() => {
    const field = layerFields.find((f) => f.name === config.setup?.column_name);
    return field?.type === "date";
  }, [layerFields, config.setup?.column_name]);

  const layoutOptions = useMemo(() => {
    const base: { value: FilterLayoutTypes; label: string }[] = [
      { value: filterLayoutTypes.Values.select, label: t("dropdown") },
      { value: filterLayoutTypes.Values.chips, label: t("chips") },
      { value: filterLayoutTypes.Values.checkbox, label: t("checkbox") },
      { value: filterLayoutTypes.Values.range, label: t("range") },
    ];
    if (isTemporal) base.push({ value: filterLayoutTypes.Values.picker, label: t("picker") });
    return base;
  }, [t, isTemporal]);

  const selectedLayout = useMemo(() => {
    return layoutOptions.find((option) => option.value === config.setup?.layout);
  }, [config.setup?.layout, layoutOptions]);

  const granularityOptions = useMemo(
    () => [
      { value: "minute", label: t("minute") },
      { value: "hour", label: t("hour") },
      { value: "day", label: t("day") },
      { value: "week", label: t("week") },
      { value: "month", label: t("month") },
    ],
    [t]
  );
  const selectedGranularity = useMemo(() => {
    const effective = config.setup?.granularity ?? "day";
    return granularityOptions.find((o) => o.value === effective);
  }, [granularityOptions, config.setup?.granularity]);

  return (
    <>
      <SectionHeader
        active={!!config?.setup?.column_name}
        alwaysActive
        label={t("setup")}
        icon={ICON_NAME.SETTINGS}
        disableAdvanceOptions
      />
      <SectionOptions
        active={true}
        baseOptions={
          <>
            <Selector
              selectedItems={selectedLayout}
              setSelectedItems={(item: SelectorItem) => {
                onChange({
                  ...config,
                  setup: {
                    ...config.setup,
                    layout: item?.value as FilterLayoutTypes,
                  },
                });
              }}
              items={layoutOptions}
              label={t("layout")}
            />
            {isTemporal && selectedLayout?.value === filterLayoutTypes.Values.range && (
              <Selector
                selectedItems={selectedGranularity}
                setSelectedItems={(item: SelectorItem | SelectorItem[] | undefined) => {
                  const value = Array.isArray(item) ? item[0]?.value : item?.value;
                  onChange({
                    ...config,
                    setup: {
                      ...config.setup,
                      granularity: value as "minute" | "hour" | "day" | "week" | "month" | undefined,
                    },
                  });
                }}
                items={granularityOptions}
                label={t("granularity")}
              />
            )}
            {/* Select (Dropdown) specific settings */}
            {selectedLayout?.value === filterLayoutTypes.Values.select && (
              <>
                <TextFieldInput
                  type="text"
                  label={t("placeholder")}
                  placeholder={t("enter_placeholder_text")}
                  clearable={false}
                  value={config.setup.placeholder || ""}
                  onChange={(value: string) => {
                    onChange({
                      ...config,
                      setup: {
                        ...config.setup,
                        placeholder: value,
                      },
                    });
                  }}
                />
              </>
            )}
            {/* Chips specific settings */}
            {selectedLayout?.value === filterLayoutTypes.Values.chips && (
              <>
                <Stack>
                  <Typography variant="body2" gutterBottom>
                    {t("min_visible_options")}
                  </Typography>
                  <SliderInput
                    value={config.setup.min_visible_options ?? 5}
                    isRange={false}
                    min={1}
                    max={20}
                    step={1}
                    onChange={(value) => {
                      onChange({
                        ...config,
                        setup: {
                          ...config.setup,
                          min_visible_options: value as number,
                        },
                      });
                    }}
                  />
                </Stack>
                <Stack>
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        checked={!!config.setup?.multiple}
                        onChange={(e) => {
                          onChange({
                            ...config,
                            setup: {
                              ...config.setup,
                              multiple: e.target.checked,
                            },
                          });
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("allow_multiple_selection")}</Typography>}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        checked={config.setup?.wrap !== false}
                        onChange={(e) => {
                          onChange({
                            ...config,
                            setup: {
                              ...config.setup,
                              wrap: e.target.checked,
                            },
                          });
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("wrap_chips")}</Typography>}
                  />
                  {config.setup?.multiple && (
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          color="primary"
                          checked={config.setup?.show_all_option !== false}
                          onChange={(e) => {
                            onChange({
                              ...config,
                              setup: {
                                ...config.setup,
                                show_all_option: e.target.checked,
                              },
                            });
                          }}
                        />
                      }
                      label={<Typography variant="body2">{t("show_all_button")}</Typography>}
                    />
                  )}
                </Stack>
              </>
            )}
            {/* Checkbox specific settings */}
            {selectedLayout?.value === filterLayoutTypes.Values.checkbox && (
              <>
                <Stack>
                  <Typography variant="body2" gutterBottom>
                    {t("min_visible_options")}
                  </Typography>
                  <SliderInput
                    value={config.setup.min_visible_options ?? 5}
                    isRange={false}
                    min={1}
                    max={20}
                    step={1}
                    onChange={(value) => {
                      onChange({
                        ...config,
                        setup: {
                          ...config.setup,
                          min_visible_options: value as number,
                        },
                      });
                    }}
                  />
                </Stack>
                <Stack>
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        checked={!!config.setup?.multiple}
                        onChange={(e) => {
                          onChange({
                            ...config,
                            setup: {
                              ...config.setup,
                              multiple: e.target.checked,
                            },
                          });
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("allow_multiple_selection")}</Typography>}
                  />
                </Stack>
              </>
            )}
            {/* Range specific settings */}
            {selectedLayout?.value === filterLayoutTypes.Values.range && (
              <>
                <Stack>
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        checked={config.setup?.show_histogram !== false}
                        onChange={(e) => {
                          onChange({
                            ...config,
                            setup: {
                              ...config.setup,
                              show_histogram: e.target.checked,
                            },
                          });
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("show_histogram")}</Typography>}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        checked={config.setup?.show_slider !== false}
                        onChange={(e) => {
                          onChange({
                            ...config,
                            setup: {
                              ...config.setup,
                              show_slider: e.target.checked,
                            },
                          });
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("show_slider")}</Typography>}
                  />
                </Stack>
                <Stack>
                  <Typography variant="body2" gutterBottom>
                    {t("steps")}
                  </Typography>
                  <SliderInput
                    value={config.setup.steps ?? 50}
                    isRange={false}
                    min={10}
                    max={100}
                    step={10}
                    onChange={(value) => {
                      onChange({
                        ...config,
                        setup: {
                          ...config.setup,
                          steps: value as number,
                        },
                      });
                    }}
                  />
                </Stack>
              </>
            )}
            {/* Common filter behavior settings */}
            <Stack>
              {selectedLayout?.value === filterLayoutTypes.Values.select && (
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      color="primary"
                      checked={!!config.setup?.multiple}
                      onChange={(e) => {
                        onChange({
                          ...config,
                          setup: {
                            ...config.setup,
                            multiple: e.target.checked,
                          },
                        });
                      }}
                    />
                  }
                  label={<Typography variant="body2">{t("allow_multiple_selection")}</Typography>}
                />
              )}
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    color="primary"
                    checked={config.options?.zoom_to_selection !== false}
                    onChange={(e) => {
                      onChange({
                        ...config,
                        options: {
                          ...config.options,
                          zoom_to_selection: e.target.checked,
                        },
                      });
                    }}
                  />
                }
                label={<Typography variant="body2">{t("zoom_to_selection")}</Typography>}
              />
              {selectedLayout?.value !== filterLayoutTypes.Values.range && (
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      color="primary"
                      checked={!!config.options?.filter_by_map_click}
                      onChange={(e) => {
                        onChange({
                          ...config,
                          options: {
                            ...config.options,
                            filter_by_map_click: e.target.checked,
                          },
                        });
                      }}
                    />
                  }
                  label={<Typography variant="body2">{t("filter_by_map_click")}</Typography>}
                />
              )}
            </Stack>
          </>
        }
      />

      {/* Style section - show for layouts that support color customization */}
      {(selectedLayout?.value === filterLayoutTypes.Values.select ||
        selectedLayout?.value === filterLayoutTypes.Values.chips ||
        selectedLayout?.value === filterLayoutTypes.Values.checkbox ||
        selectedLayout?.value === filterLayoutTypes.Values.range) && (
        <>
          <SectionHeader
            active={true}
            alwaysActive
            label={t("style")}
            icon={ICON_NAME.STYLE}
            disableAdvanceOptions
          />
          <SectionOptions
            active={true}
            baseOptions={
              <Stack spacing={2}>
                {(selectedLayout?.value === filterLayoutTypes.Values.chips ||
                  selectedLayout?.value === filterLayoutTypes.Values.checkbox ||
                  selectedLayout?.value === filterLayoutTypes.Values.range) && (
                  <WidgetColorPicker
                    color={config.options?.color || DEFAULT_WIDGET_COLOR}
                    onChange={(color) => {
                      onChange({
                        ...config,
                        options: {
                          ...config.options,
                          color,
                        },
                      });
                    }}
                    label={t("color")}
                  />
                )}
                {/* Category-style order/label config for chips and checkbox */}
                {(selectedLayout?.value === filterLayoutTypes.Values.chips ||
                  selectedLayout?.value === filterLayoutTypes.Values.checkbox) && (
                  <CategoryColorConfig
                    layerId={selectedLayerDatasetId}
                    fieldName={config.setup?.column_name}
                    customOrder={config.setup?.custom_order}
                    colorMap={[]}
                    labelMap={config.options?.label_map}
                    showColorPicker={false}
                    onChange={(order, _colorMap, labelMap) => {
                      onChange({
                        ...config,
                        setup: {
                          ...config.setup,
                          custom_order: order,
                        },
                        options: {
                          ...config.options,
                          label_map: labelMap,
                        },
                      });
                    }}
                  />
                )}
                {/* Value label mapping for discrete filter layouts */}
                {selectedLayout?.value === filterLayoutTypes.Values.select && (
                  <FilterValueLabelConfig
                    layerId={selectedLayerDatasetId}
                    fieldName={config.setup?.column_name}
                    customOrder={config.setup?.custom_order}
                    labelMap={config.options?.label_map}
                    onLabelMapChange={(labelMap) => {
                      onChange({
                        ...config,
                        options: {
                          ...config.options,
                          label_map: labelMap,
                        },
                      });
                    }}
                  />
                )}
              </Stack>
            }
          />
        </>
      )}
    </>
  );
};
