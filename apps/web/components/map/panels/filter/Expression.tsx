import { Divider, IconButton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import bbox from "@turf/bbox";
import bboxPolygon from "@turf/bbox-polygon";
import type { BBox } from "@turf/helpers";
import { useParams } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";
import TemporalPicker from "@p4b/ui/components/TemporalPicker";

import { useDayjsLocale } from "@/i18n/utils";

import {
  type Expression as ExpressionType,
  FilterType,
  SpatialIntersectionGeomType,
} from "@/lib/validations/filter";

import { FilterExpressionActions } from "@/types/common";
import type { SelectorItem } from "@/types/map/common";

import useLayerFields from "@/hooks/map/CommonHooks";
import useLogicalExpressionOperations from "@/hooks/map/FilteringHooks";
import { useActiveLayer } from "@/hooks/map/LayerPanelHooks";

import type { PopperMenuItem } from "@/components/common/PopperMenu";
import MoreMenu from "@/components/common/PopperMenu";
import LayerFieldSelector from "@/components/map/common/LayerFieldSelector";
import {
  spatialIntersectionOptions as buildSpatialIntersectionOptions,
  spatialGeometry,
  spatialGeometryType,
} from "@/components/map/panels/filter/spatialIntersection";
import Selector from "@/components/map/panels/common/Selector";
import SelectorLayerValue from "@/components/map/panels/common/SelectorLayerValue";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

type ExpressionProps = {
  expression: ExpressionType;
  onDelete: (expression: ExpressionType) => void;
  onUpdate: (expression: ExpressionType) => void;
  /** Omit where duplicating has no meaning — a bundle takes exactly one
   *  expression, so the menu entry is left out rather than shown inert. */
  onDuplicate?: (expression: ExpressionType) => void;
  /** Optional layer ID to use instead of active layer (for workflows) */
  layerId?: string;
};

const Expression: React.FC<ExpressionProps> = (props) => {
  const dayjsLocale = useDayjsLocale();
  const theme = useTheme();
  const { map } = useMap();

  const [expression, setExpression] = useState<ExpressionType>(props.expression);

  const { t } = useTranslation("common");
  const { projectId } = useParams();

  // A boundary appears only when the row holds one (set by the assistant).
  const currentSpatialType = expression.type === FilterType.Spatial ? spatialGeometryType(expression.value) : null;
  const spatialIntersectionOptions: SelectorItem[] = useMemo(
    () => buildSpatialIntersectionOptions(t, currentSpatialType),
    [t, currentSpatialType]
  );

  // Use provided layerId prop if available, otherwise fall back to active layer
  const { activeLayer } = useActiveLayer(projectId as string);
  const effectiveLayerId = props.layerId || activeLayer?.layer_id || "";
  const { layerFields } = useLayerFields(effectiveLayerId);
  const selectedAttribute = useMemo(() => {
    return layerFields.find((field) => field.name === expression.attribute);
  }, [layerFields, expression.attribute]);

  const { logicalExpressionTypes } = useLogicalExpressionOperations(selectedAttribute?.type);

  const selectedExpressionOperation = useMemo(() => {
    const operation = logicalExpressionTypes.find((operation) => operation.value === expression.expression);
    return operation;
  }, [expression.expression, logicalExpressionTypes]);

  const hasExpressionChanged = useMemo(() => {
    return JSON.stringify(expression) !== JSON.stringify(props.expression);
  }, [expression, props.expression]);

  const isExpressionValid = useMemo(() => {
    let hasValue = !!expression.value.toString();
    if (
      expression.expression === "is_empty_string" ||
      expression.expression === "is_not_empty_string" ||
      expression.expression === "is_blank" ||
      expression.expression === "is_not_blank" ||
      expression.expression === "is_true" ||
      expression.expression === "is_false"
    ) {
      hasValue = true;
    }
    if (expression.expression === "is_between" || expression.expression === "is_not_between") {
      const v = expression.value;
      hasValue = Array.isArray(v) ? v.length === 2 && !!v[0] && !!v[1] : hasValue;
    }
    return expression.attribute && expression.expression && hasValue;
  }, [expression]);

  const expressionMoreMenuOptions = useMemo(() => {
    const layerStyleMoreMenuOptions: PopperMenuItem[] = [
      {
        id: FilterExpressionActions.DELETE,
        label: t("delete"),
        icon: ICON_NAME.TRASH,
        color: theme.palette.error.main,
      },
    ];

    if (props.onDuplicate) {
      layerStyleMoreMenuOptions.push({
        id: FilterExpressionActions.DUPLICATE,
        label: t("duplicate"),
        disabled: !isExpressionValid,
        icon: ICON_NAME.COPY,
        color: theme.palette.text.secondary,
      });
    }

    return layerStyleMoreMenuOptions;
  }, [isExpressionValid, props.onDuplicate, t, theme.palette.error.main, theme.palette.text.secondary]);

  useEffect(() => {
    if (hasExpressionChanged && isExpressionValid) {
      props.onUpdate(expression);
    }
  }, [expression, hasExpressionChanged, isExpressionValid, props]);

  // A value that is not a geometry selects nothing and shows no label.
  const selectedIntersection = useMemo(
    () => spatialIntersectionOptions.find((intersection) => intersection.value === currentSpatialType),
    [currentSpatialType, spatialIntersectionOptions]
  );

  const formatedFeatureLabel = useMemo(() => {
    const geometry = expression.type === FilterType.Spatial ? spatialGeometry(expression.value) : null;
    if (!geometry) return "";
    if (geometry.properties?.type === SpatialIntersectionGeomType.BBOX) {
      const _bbox = bbox(geometry);
      return `SW(${_bbox[0].toFixed(3)}, ${_bbox[1].toFixed(3)}); NE(${_bbox[2].toFixed(3)}, ${_bbox[3].toFixed(3)})`;
    }
    const label = geometry.properties?.label;
    return typeof label === "string" ? label : "";
  }, [expression.type, expression.value]);

  return (
    <>
      <Stack direction="column">
        <Stack direction="row" justifyContent="space-between">
          <Stack direction="row" alignItems="center">
            <Icon
              iconName={expression.type === FilterType.Logical ? ICON_NAME.TABLE : ICON_NAME.MAP}
              style={{
                fontSize: "17px",
                color: theme.palette.text.secondary,
              }}
            />
            <Typography variant="body2" fontWeight="bold" sx={{ pl: 2 }}>
              {t(`${expression.type}_expression`)}
            </Typography>
          </Stack>
          <MoreMenu
            menuItems={expressionMoreMenuOptions}
            menuButton={
              <Tooltip title={t("more_options")} arrow placement="top">
                <IconButton>
                  <Icon iconName={ICON_NAME.MORE_HORIZ} style={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            }
            onSelect={async (menuItem: PopperMenuItem) => {
              if (menuItem.id === FilterExpressionActions.DELETE) {
                props.onDelete(expression);
              }
              if (menuItem.id === FilterExpressionActions.DUPLICATE) {
                props.onDuplicate?.(expression);
              }
            }}
          />
        </Stack>
        <Stack direction="column" spacing={2}>
          {/* {LOGICAL FILTER} */}
          {expression.type === FilterType.Logical && (
            <>
              <LayerFieldSelector
                label={t("select_field")}
                fields={layerFields}
                selectedField={selectedAttribute}
                setSelectedField={(field) => {
                  const existingFieldType = selectedAttribute?.type;
                  const newFieldType = field?.type;
                  let newExpression = {
                    ...expression,
                    value: "",
                    attribute: field?.name || "",
                  };
                  if (newFieldType !== existingFieldType) {
                    newExpression = {
                      ...newExpression,
                      expression: "",
                    };
                  }
                  setExpression(newExpression);
                }}
              />
              <Selector
                disabled={!selectedAttribute}
                selectedItems={selectedExpressionOperation}
                setSelectedItems={(selectedExpression: SelectorItem) =>
                  setExpression({
                    ...expression,
                    value: "",
                    expression: selectedExpression?.value as string,
                  })
                }
                items={logicalExpressionTypes}
                label={t("select_operator")}
              />
              {selectedAttribute && selectedExpressionOperation && (
                <>
                  {/* Free Text Input */}
                  {["starts_with", "ends_with", "contains_the_text", "does_not_contains_the_text"].includes(
                    selectedExpressionOperation.value as string
                  ) && (
                    <TextFieldInput
                      type="text"
                      label={t("enter_value")}
                      value={expression.value as string}
                      onChange={(value: string) => {
                        setExpression({
                          ...expression,
                          value,
                        });
                      }}
                    />
                  )}
                  {/* {Value Selector} */}
                  {["is", "is_not"].includes(selectedExpressionOperation.value as string) && (
                    <SelectorLayerValue
                      clearable
                      selectedValues={expression.value as string}
                      onSelectedValuesChange={(values: string | null) => {
                        if (values === null) {
                          setExpression({
                            ...expression,
                            value: "",
                          });
                          return;
                        }
                        const fieldType = selectedAttribute?.type;
                        if (fieldType === "number" && values) {
                          setExpression({
                            ...expression,
                            value: Number(values),
                          });
                        }
                        if (fieldType === "string" && values) {
                          setExpression({
                            ...expression,
                            value: values,
                          });
                        }
                      }}
                      layerId={effectiveLayerId}
                      fieldName={expression.attribute}
                      label={t("select_value")}
                    />
                  )}

                  {["includes", "excludes"].includes(selectedExpressionOperation.value as string) && (
                    <SelectorLayerValue
                      selectedValues={expression.value ? (expression.value as unknown[]).map(String) : []}
                      onSelectedValuesChange={(values: string[] | null) => {
                        if (values && values.length === 0) {
                          setExpression({
                            ...expression,
                            value: [],
                          });
                          return;
                        }
                        const fieldType = selectedAttribute?.type;
                        if (fieldType === "number" && values) {
                          const _values = values.map((value) => Number(value));
                          setExpression({
                            ...expression,
                            value: _values as number[],
                          });
                        }
                        if (fieldType === "string" && values) {
                          setExpression({
                            ...expression,
                            value: values as string[],
                          });
                        }
                      }}
                      layerId={effectiveLayerId}
                      fieldName={expression.attribute}
                      label={t("select_values")}
                      multiple
                    />
                  )}

                  {/* Number Input */}
                  {["is_at_least", "is_less_than", "is_at_most", "is_greater_than"].includes(
                    selectedExpressionOperation.value as string
                  ) && (
                    <>
                      <TextFieldInput
                        type="number"
                        label={t("enter_value")}
                        value={expression.value as string}
                        onChange={(value: string) => {
                          const numberValue = Number(value);
                          setExpression({
                            ...expression,
                            value: numberValue,
                          });
                        }}
                      />
                    </>
                  )}

                  {/* Single Date Input */}
                  {selectedAttribute?.type === "date" &&
                    ["is_on", "is_not_on", "is_before", "is_after"].includes(
                      selectedExpressionOperation.value as string
                    ) && (
                      <TemporalPicker
                        locale={dayjsLocale}
                        kind="datetime"
                        label={t("select_date")}
                        value={expression.value as string}
                        onChange={(value: string) => {
                          setExpression({ ...expression, value });
                        }}
                      />
                    )}

                  {/* Date Range Input (From / To) */}
                  {selectedAttribute?.type === "date" &&
                    ["is_between", "is_not_between"].includes(
                      selectedExpressionOperation.value as string
                    ) && (
                      <Stack direction="column" spacing={2}>
                        {[0, 1].map((index) => (
                          <TemporalPicker
                            locale={dayjsLocale}
                            key={index}
                            kind="datetime"
                            label={index === 0 ? t("from") : t("to")}
                            value={
                              Array.isArray(expression.value) ? String(expression.value[index] ?? "") : ""
                            }
                            onChange={(value: string) => {
                              const current = Array.isArray(expression.value)
                                ? [...(expression.value as string[])]
                                : ["", ""];
                              current[index] = value;
                              setExpression({ ...expression, value: current });
                            }}
                          />
                        ))}
                      </Stack>
                    )}

                  {/* Relative Range Input (number of days) */}
                  {selectedAttribute?.type === "date" &&
                    ["in_the_last", "not_in_the_last"].includes(
                      selectedExpressionOperation.value as string
                    ) && (
                      <TextFieldInput
                        type="number"
                        label={t("number_of_days")}
                        value={expression.value as string}
                        onChange={(value: string) => {
                          setExpression({ ...expression, value: Number(value) });
                        }}
                      />
                    )}
                </>
              )}
            </>
          )}
          {/* {SPATIAL FILTER} */}
          {expression.type === FilterType.Spatial && (
            <>
              <Selector
                selectedItems={selectedIntersection}
                placeholder={t("select_spatial_intersection")}
                setSelectedItems={(item: SelectorItem) => {
                  let coordinates = [] as number[][];
                  if (item.value === SpatialIntersectionGeomType.BBOX) {
                    const bbox = map?.getBounds().toArray().flat();
                    if (bbox) {
                      const polygon = bboxPolygon(bbox as BBox);
                      const geometry = polygon.geometry;
                      coordinates = geometry.coordinates as unknown as number[][];
                    }
                  }
                  const geometry = {
                    coordinates,
                    type: "Polygon",
                    properties: {
                      type: item.value,
                      label: item.label,
                    },
                  };
                  setExpression({
                    ...expression,
                    attribute: "geom",
                    expression: "s_intersects",
                    value: JSON.stringify(geometry),
                  });
                }}
                items={spatialIntersectionOptions}
                label={t("select_spatial_intersection")}
              />
              {selectedIntersection?.value === SpatialIntersectionGeomType.BBOX && (
                <Stack direction="row" spacing={2} alignItems="end" sx={{ pt: 2 }}>
                  <Typography variant="body2" fontWeight="bold">
                    {formatedFeatureLabel}
                  </Typography>
                  <Tooltip title={t("use_current_map_extent")} arrow>
                    <IconButton
                      color="secondary"
                      aria-label={t("use_current_map_extent")}
                      onClick={() => {
                        const bbox = map?.getBounds().toArray().flat();
                        if (bbox) {
                          const polygon = bboxPolygon(bbox as BBox);
                          const geometry = polygon.geometry;
                          //There is no "properties" key in the geometry object in the GeoJSON spec
                          //This is a bit hacky, but it doesn't break the backend and we can reuse to extract information
                          //from the geometry object on the intersectionType and the label.
                          geometry["properties"] = {
                            type: "bbox",
                            label: "Map Extent",
                          };
                          setExpression({
                            ...expression,
                            attribute: "geom",
                            expression: "s_intersects",
                            value: JSON.stringify(geometry),
                          });
                        }
                      }}>
                      <Icon iconName={ICON_NAME.REFRESH} fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              )}
              {selectedIntersection?.value === SpatialIntersectionGeomType.BOUNDARY && (
                <Typography variant="body2" fontWeight="bold" sx={{ pt: 2 }}>
                  {formatedFeatureLabel || t("boundary")}
                </Typography>
              )}
            </>
          )}
        </Stack>
      </Stack>
      <Divider />
    </>
  );
};

export default Expression;
