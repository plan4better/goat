"use client";

import CheckIcon from "@mui/icons-material/Check";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import {
  Box,
  Button,
  ButtonBase,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Measurement } from "@/lib/store/map/slice";
import { copyText } from "@/lib/utils/clipboard";
import type { UnitPreference, UnitSystem } from "@/lib/utils/measurementUnits";

import { usePreferredUnitSystem } from "@/hooks/settings/usePreferredUnitSystem";

import { FloatingPanel } from "@/components/common/FloatingPanel";

import { MEASURE_TOOL_ICONS, type MeasureToolType } from "./Measure";

export type MeasurementResultsProps = {
  measurements: Measurement[];
  activeTool?: string;
  selectedMeasurementId?: string;
  isSnapEnabled?: boolean;
  onClose?: () => void;
  onSelectMeasurement?: (measurementId: string) => void;
  onDeleteMeasurement?: (measurementId: string) => void;
  onChangeUnitSystem?: (measurementId: string, unitSystem: UnitPreference) => void;
  onDeactivateTool?: () => void;
  onZoomToMeasurement?: (measurementId: string) => void;
  onToggleSnap?: () => void;
};

export function MeasurementResults({
  measurements,
  activeTool,
  selectedMeasurementId,
  isSnapEnabled,
  onClose,
  onSelectMeasurement,
  onDeleteMeasurement,
  onChangeUnitSystem,
  onDeactivateTool,
  onZoomToMeasurement,
  onToggleSnap,
}: MeasurementResultsProps) {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [highlightedDetailKey, setHighlightedDetailKey] = useState<string | null>(null);
  const [unitMenuState, setUnitMenuState] = useState<{
    measurementId: string;
    anchorEl: HTMLElement;
  } | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { unit: systemUnit } = usePreferredUnitSystem();

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (onDeactivateTool) {
          onDeactivateTool();
        } else if (onClose) {
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, onDeactivateTool]);

  const splitValueUnit = (formattedValue: string) => {
    const lastSpaceIndex = formattedValue.lastIndexOf(" ");
    if (lastSpaceIndex === -1) {
      return { value: formattedValue, unit: "" };
    }
    return {
      value: formattedValue.slice(0, lastSpaceIndex),
      unit: formattedValue.slice(lastSpaceIndex + 1),
    };
  };

  const getIcon = (type: string) => {
    return MEASURE_TOOL_ICONS[type as MeasureToolType] ?? ICON_NAME.RULER_HORIZONTAL;
  };

  const getMeasurementLabelKey = (type: string) => {
    if (type === "area") {
      return "measure_polygon";
    }
    if (type === "distance") {
      return "measure_flight_distance";
    }
    return `measure_${type}`;
  };

  const getMeasurementActiveKey = (type: string) => {
    return `${getMeasurementLabelKey(type)}_active`;
  };

  const getMeasurementDetails = (measurement: Measurement) => {
    const details: { label: string; value: string; unit: string }[] = [];
    const perimeterLabel = t("perimeter_label", { defaultValue: "Perimeter" });

    const addDetail = (label: string, formattedValue?: string) => {
      if (!formattedValue) return;
      const { value, unit } = splitValueUnit(formattedValue);
      details.push({ label, value, unit });
    };

    if (measurement.type === "area") {
      addDetail(t("area"), measurement.formattedValue);
      addDetail(perimeterLabel, measurement.properties?.formattedPerimeter);
      return details;
    }

    if (measurement.type === "circle") {
      addDetail(t("area"), measurement.formattedValue);
      addDetail(perimeterLabel, measurement.properties?.formattedPerimeter);
      addDetail(t("radius"), measurement.properties?.formattedRadius);
      addDetail(t("azimuth", { defaultValue: "Azimuth" }), measurement.properties?.formattedAzimuth);
      return details;
    }

    // Walking and car measurements - show distance and duration
    if (measurement.type === "walking" || measurement.type === "car") {
      addDetail(t("distance"), measurement.formattedValue);
      addDetail(t("duration", { defaultValue: "Duration" }), measurement.properties?.formattedDuration);
      return details;
    }

    addDetail(t("distance"), measurement.formattedValue);
    return details;
  };

  const highlightDetail = useCallback((detailKey: string) => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    setHighlightedDetailKey(detailKey);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedDetailKey((current) => (current === detailKey ? null : current));
      highlightTimeoutRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!unitMenuState) return;
    const exists = measurements.some((measurement) => measurement.id === unitMenuState.measurementId);
    if (!exists) {
      setUnitMenuState(null);
    }
  }, [measurements, unitMenuState]);

  const handleValueClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, value: string, detailKey: string) => {
      event.stopPropagation();
      void copyText(value);
      highlightDetail(detailKey);
    },
    [highlightDetail]
  );

  const metricLabel = t("measurement_unit_metric", { defaultValue: "Metric (m, km)" });
  const imperialLabel = t("measurement_unit_imperial", { defaultValue: "Imperial (ft, mi)" });
  const getBaseLabel = useCallback(
    (unit: UnitSystem) => (unit === "metric" ? metricLabel : imperialLabel),
    [metricLabel, imperialLabel]
  );

  const formatOptionLabel = useCallback(
    (unit: UnitSystem) => {
      return getBaseLabel(unit);
    },
    [getBaseLabel]
  );

  const formatMeasurementUnitLabel = useCallback(
    (measurement: Measurement) => {
      const preference = measurement.unitSystem ?? "default";
      const effectiveUnit = preference === "default" ? systemUnit : preference;
      return getBaseLabel(effectiveUnit);
    },
    [getBaseLabel, systemUnit]
  );

  const isOptionSelected = useCallback(
    (measurement: Measurement, option: UnitSystem) => {
      const preference = measurement.unitSystem ?? "default";
      if (preference === "default") {
        return option === systemUnit;
      }
      return preference === option;
    },
    [systemUnit]
  );

  const openUnitMenu = useCallback((event: ReactMouseEvent<HTMLElement>, measurementId: string) => {
    event.stopPropagation();
    setUnitMenuState({ measurementId, anchorEl: event.currentTarget });
  }, []);

  const closeUnitMenu = useCallback(() => {
    setUnitMenuState(null);
  }, []);

  const handleUnitSelection = useCallback(
    (unitSelection: UnitSystem) => {
      if (!unitMenuState) return;
      const preference: UnitPreference = unitSelection === systemUnit ? "default" : unitSelection;
      onChangeUnitSystem?.(unitMenuState.measurementId, preference);
      setUnitMenuState(null);
    },
    [onChangeUnitSystem, systemUnit, unitMenuState]
  );

  if (!activeTool && measurements.length === 0) {
    return null;
  }

  const unitMenuMeasurement = unitMenuState
    ? measurements.find((measurement) => measurement.id === unitMenuState.measurementId)
    : undefined;

  return (
    <FloatingPanel width={320} minHeight="auto" maxHeight="70vh">
      <Stack direction="column" sx={{ p: 3, gap: 2 }}>
        {/* Header */}
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="body1" fontWeight="bold">
            {t("measurements")}
          </Typography>
          {onClose && (
            <IconButton
              size="small"
              onClick={onClose}
              sx={{
                color: theme.palette.action.active,
              }}>
              <Icon iconName={ICON_NAME.CLOSE} fontSize="small" />
            </IconButton>
          )}
        </Stack>

        {/* Settings toolbar (snap, save-as-dataset, …) */}
        {onToggleSnap && (
          <Stack
            direction="row"
            spacing={1}
            sx={{
              pb: 1,
              borderBottom: `1px solid ${theme.palette.divider}`,
            }}>
            <Tooltip
              title={t("measure_snap_to_layers", { defaultValue: "Snap to layers" })}
              arrow
              placement="bottom">
              <span style={{ display: "flex" }}>
                <Button
                  variant={isSnapEnabled ? "contained" : "outlined"}
                  size="small"
                  sx={{ minWidth: 36, width: 36, height: 36, px: 0 }}
                  onClick={onToggleSnap}
                  aria-pressed={isSnapEnabled}>
                  <Icon iconName={ICON_NAME.BULLSEYE} style={{ fontSize: 16 }} />
                </Button>
              </span>
            </Tooltip>
          </Stack>
        )}

        {/* Active Tool Info */}
        {activeTool && (
          <Box
            sx={{
              p: 2,
              borderRadius: 1,
              backgroundColor: theme.palette.primary.main + "10",
              border: `1px solid ${theme.palette.primary.main}40`,
            }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Icon iconName={getIcon(activeTool)} htmlColor={theme.palette.primary.main} fontSize="small" />
              <Typography variant="body2" color={theme.palette.primary.main}>
                {t(getMeasurementActiveKey(activeTool))}
              </Typography>
            </Stack>
          </Box>
        )}

        {/* Measurements List */}
        {measurements.length > 0 ? (
          <Box
            sx={{
              maxHeight: "400px",
              overflowY: "auto",
              overflowX: "hidden",
              mr: -3,
              pr: 3,
            }}>
            <Stack direction="column" spacing={4}>
              {[...measurements].reverse().map((measurement) => {
                const isSelected = selectedMeasurementId === measurement.id;
                const unitLabel = formatMeasurementUnitLabel(measurement);
                return (
                  <Box
                    key={measurement.id}
                    onClick={() => onSelectMeasurement?.(measurement.id)}
                    sx={{
                      p: 2,
                      borderRadius: 1,
                      border: `1px solid ${isSelected ? theme.palette.primary.main : theme.palette.divider}`,
                      cursor: "pointer",
                      transition: "all 0.15s ease-in-out",
                      "&:hover": {
                        borderColor: theme.palette.primary.main,
                      },
                    }}>
                    <Stack spacing={1.5}>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <Icon
                            iconName={getIcon(measurement.type)}
                            htmlColor={isSelected ? theme.palette.primary.main : theme.palette.action.active}
                            fontSize="small"
                          />
                          <Typography
                            variant="body2"
                            fontWeight={600}
                            color={isSelected ? theme.palette.primary.main : theme.palette.text.primary}>
                            {t(getMeasurementLabelKey(measurement.type))}
                          </Typography>
                        </Stack>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <IconButton
                            size="small"
                            onClick={(event) => {
                              event.stopPropagation();
                              onZoomToMeasurement?.(measurement.id);
                            }}
                            title={t("zoom_to_feature")}
                            aria-label={t("zoom_to_feature")}
                            sx={{
                              color: theme.palette.action.active,
                              width: 28,
                              height: 28,
                              p: 0.25,
                              fontSize: 16,
                            }}>
                            <Icon iconName={ICON_NAME.ZOOM_IN} fontSize="inherit" />
                          </IconButton>
                          <IconButton
                            size="small"
                            onClick={(event) => openUnitMenu(event, measurement.id)}
                            sx={{
                              color: theme.palette.action.active,
                              width: 28,
                              height: 28,
                              p: 0.25,
                              fontSize: 16,
                              "&:hover": {
                                color: theme.palette.text.primary,
                              },
                            }}>
                            <MoreVertIcon fontSize="inherit" />
                          </IconButton>
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteMeasurement?.(measurement.id);
                            }}
                            sx={{
                              color: theme.palette.action.active,
                              width: 28,
                              height: 28,
                              p: 0.25,
                              fontSize: 16,
                              "&:hover": {
                                color: theme.palette.error.main,
                              },
                            }}>
                            <Icon iconName={ICON_NAME.TRASH} fontSize="inherit" />
                          </IconButton>
                        </Stack>
                      </Stack>
                      <Typography variant="caption" color={theme.palette.text.secondary}>
                        {t("measurement_unit_label", { defaultValue: "Units: {{unit}}", unit: unitLabel })}
                      </Typography>

                      <Divider flexItem sx={{ my: 0.5 }} />

                      <Stack spacing={1.5}>
                        {getMeasurementDetails(measurement).map((detail) => {
                          const detailKey = `${measurement.id}-${detail.label}`;
                          const isHighlighted = highlightedDetailKey === detailKey;
                          const combinedValue = detail.unit ? `${detail.value} ${detail.unit}` : detail.value;
                          const actionIcon = isHighlighted ? ICON_NAME.CIRCLECHECK : ICON_NAME.COPY;
                          const actionColor = isHighlighted
                            ? theme.palette.primary.main
                            : theme.palette.action.active;

                          return (
                            <Stack
                              key={detailKey}
                              direction="row"
                              alignItems="center"
                              spacing={1}
                              sx={{ width: "100%" }}>
                              <Typography
                                variant="body2"
                                color={theme.palette.text.secondary}
                                noWrap
                                sx={{
                                  width: 120,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}>
                                {detail.label}
                              </Typography>
                              <ButtonBase
                                disableRipple
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => handleValueClick(event, combinedValue, detailKey)}
                                sx={{
                                  flexGrow: 1,
                                  borderRadius: 1,
                                  px: 1.25,
                                  py: 0.75,
                                  backgroundColor: isHighlighted
                                    ? theme.palette.primary.main + "12"
                                    : "transparent",
                                  cursor: "pointer",
                                  userSelect: "none",
                                  fontVariantNumeric: "tabular-nums",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  border: `1px solid ${
                                    isHighlighted ? theme.palette.primary.main : "transparent"
                                  }`,
                                  transition: "border-color 0.15s ease, background-color 0.15s ease",
                                  "&:hover, &:focus-visible": {
                                    borderColor: theme.palette.primary.main,
                                    backgroundColor: theme.palette.action.hover,
                                  },
                                  "&:hover .measurement-copy-icon": {
                                    opacity: 1,
                                  },
                                  "&:focus-visible .measurement-copy-icon": {
                                    opacity: 1,
                                  },
                                }}>
                                <Stack
                                  direction="row"
                                  spacing={0.5}
                                  alignItems="center"
                                  sx={{ flexShrink: 1 }}>
                                  <Typography variant="body2" fontWeight={600}>
                                    {detail.value}
                                  </Typography>
                                  {detail.unit && (
                                    <Typography variant="body2" color={theme.palette.text.secondary}>
                                      {detail.unit}
                                    </Typography>
                                  )}
                                </Stack>
                                <Icon
                                  className="measurement-copy-icon"
                                  iconName={actionIcon}
                                  fontSize="small"
                                  htmlColor={actionColor}
                                  sx={{
                                    opacity: isHighlighted ? 1 : 0,
                                    transition: "opacity 0.15s ease",
                                    flexShrink: 0,
                                  }}
                                />
                              </ButtonBase>
                            </Stack>
                          );
                        })}
                      </Stack>
                    </Stack>
                  </Box>
                );
              })}
            </Stack>
          </Box>
        ) : (
          <Box sx={{ py: 2, textAlign: "center" }}>
            <Typography variant="body2" color={theme.palette.text.secondary}>
              {t("no_measurements_yet")}
            </Typography>
            <Typography variant="caption" color={theme.palette.text.secondary}>
              {t("click_on_map_to_start_measuring")}
            </Typography>
          </Box>
        )}
      </Stack>
      <Menu
        open={Boolean(unitMenuState)}
        anchorEl={unitMenuState?.anchorEl}
        onClose={closeUnitMenu}
        anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
        transformOrigin={{ horizontal: "right", vertical: "top" }}
        keepMounted>
        {(systemUnit === "metric"
          ? (["metric", "imperial"] as UnitSystem[])
          : (["imperial", "metric"] as UnitSystem[])
        ).map((option) => {
          const isSelected = unitMenuMeasurement ? isOptionSelected(unitMenuMeasurement, option) : false;
          return (
            <MenuItem key={option} selected={isSelected} dense onClick={() => handleUnitSelection(option)}>
              <ListItemIcon sx={{ minWidth: 28 }}>
                {isSelected ? <CheckIcon fontSize="small" /> : null}
              </ListItemIcon>
              <ListItemText primary={formatOptionLabel(option)} />
            </MenuItem>
          );
        })}
      </Menu>
    </FloatingPanel>
  );
}
