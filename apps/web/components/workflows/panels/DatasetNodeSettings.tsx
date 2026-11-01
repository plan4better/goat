"use client";

/**
 * Dataset Node Settings Panel
 *
 * Shows configuration for a selected dataset node with two tabs:
 * - SOURCE: Select/change the dataset from project layers, my datasets, or catalog
 * - FILTER: Apply workflow-specific filters to the dataset (not persisted to project layer)
 */
import {
  Box,
  Button,
  ClickAwayListener,
  Divider,
  ListItemIcon,
  Menu,
  MenuItem,
  MenuList,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { formatDistance } from "date-fns";
import { useParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useDataset } from "@/lib/api/layers";
import { useFeatureCount } from "@/lib/api/processes";
import type { AppDispatch } from "@/lib/store";
import { selectActiveDataPanelView } from "@/lib/store/workflow/selectors";
import { requestMapView, requestTableView, updateNode } from "@/lib/store/workflow/slice";
import { parseCQLQueryToObject } from "@/lib/transformers/filter";
import { layerType } from "@/lib/validations/common";
import type { ContentItem } from "@/lib/validations/content";
import type { Expression as ExpressionType } from "@/lib/validations/filter";
import { FilterType } from "@/lib/validations/filter";
import type { ProjectLayer } from "@/lib/validations/project";
import type { WorkflowNode } from "@/lib/validations/workflow";

import type { SelectorItem } from "@/types/map/common";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";

import DatasetPickerDialog from "@/components/addLayer/DatasetPickerDialog";
import Container from "@/components/map/panels/Container";
import Selector from "@/components/map/panels/common/Selector";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import StepIssuesSummary from "@/components/workflows/issues/StepIssuesSummary";
import { useStepIssues } from "@/components/workflows/issues/WorkflowIssuesContext";
import { useStepFieldFocus } from "@/hooks/workflows/useStepFieldFocus";
import Expression from "@/components/map/panels/filter/Expression";

// Tab panel component
interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`dataset-tabpanel-${index}`}
      aria-labelledby={`dataset-tab-${index}`}
      {...other}>
      {value === index && <Box sx={{ pt: 1.5 }}>{children}</Box>}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `dataset-tab-${index}`,
    "aria-controls": `dataset-tabpanel-${index}`,
  };
}

// Dataset source type enum
enum DatasetSourceType {
  FromProject = "from_project",
  MyDatasets = "my_datasets",
}

interface DatasetNodeSettingsProps {
  node: WorkflowNode;
  projectLayers?: ProjectLayer[];
  onBack: () => void;
}

export default function DatasetNodeSettings({ node, projectLayers = [], onBack }: DatasetNodeSettingsProps) {
  const { t } = useTranslation("common");
  const stepIssues = useStepIssues(node.id);
  const settingsRef = useStepFieldFocus(node.id);
  const dispatch = useDispatch<AppDispatch>();
  const { projectId } = useParams();
  const dateLocale = useDateFnsLocale();

  // Track active data panel view for button selected state
  const activeDataPanelView = useSelector(selectActiveDataPanelView);

  // Fetch project layers (for "From project" selector)
  const { layers: fetchedLayers } = useFilteredProjectLayers(projectId as string);
  const layers = fetchedLayers || projectLayers;

  // Get layer ID from node data
  const nodeLayerId = useMemo(() => {
    if (node.type !== "dataset" || node.data.type !== "dataset") return null;
    return node.data.layerId || null;
  }, [node]);

  // Fetch full layer details using layerId
  const { dataset: selectedLayer } = useDataset(nodeLayerId || "");
  const { featureCount } = useFeatureCount(selectedLayer?.id);

  // Tab state
  const [tabValue, setTabValue] = useState(0);

  // Dataset source menu state
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchorEl);

  // Modal states
  const [myDatasetsOpen, setMyDatasetsOpen] = useState(false);

  // Show layer selector (for "From project" option)
  const [showLayerSelector, setShowLayerSelector] = useState(false);

  // Get layer fields for filter
  useLayerFields(nodeLayerId || "");

  // Filter expressions state - workflow-specific, initialized from layer's existing filter
  const [expressions, setExpressions] = useState<ExpressionType[]>([]);
  const [logicalOperator, setLogicalOperator] = useState<SelectorItem | undefined>({
    value: "and",
    label: t("and"),
  });

  // Filter menu state
  const [filterMenuAnchorEl, setFilterMenuAnchorEl] = useState<null | HTMLElement>(null);
  const filterMenuOpen = Boolean(filterMenuAnchorEl);

  const logicalOperators = useMemo(
    () => [
      { value: "and", label: t("match_all_filters") },
      { value: "or", label: t("match_at_least_one_filter") },
    ],
    [t]
  );

  const filterExpressionTypes = [
    { sourceType: FilterType.Logical, iconName: ICON_NAME.TABLE, label: t("logical_expression") },
    { sourceType: FilterType.Spatial, iconName: ICON_NAME.MAP, label: t("spatial_expression") },
  ];

  // Track if we've loaded expressions for current node to avoid re-running on every render
  const loadedNodeIdRef = React.useRef<string | null>(null);

  // Initialize filter expressions from node data (runs once per node selection)
  useEffect(() => {
    // Skip if we already loaded for this node
    if (loadedNodeIdRef.current === node.id) {
      return;
    }

    // Only handle dataset nodes with filter capability
    if (node.type !== "dataset" || node.data.type !== "dataset") {
      loadedNodeIdRef.current = node.id;
      setExpressions([]);
      return;
    }

    // Load existing filter from node if present
    if (node.data.filter) {
      const nodeFilter = node.data.filter as {
        op?: string;
        expressions?: ExpressionType[];
        args?: unknown[];
      };
      if (nodeFilter.op && nodeFilter.expressions && nodeFilter.expressions.length > 0) {
        setLogicalOperator(logicalOperators.find((item) => item.value === nodeFilter.op));
        setExpressions(nodeFilter.expressions);
      } else if (nodeFilter.op && nodeFilter.args) {
        // Fall back to CQL format (with args array) for backward compatibility
        const savedExpressions = parseCQLQueryToObject(nodeFilter as { op: string; args: unknown[] });
        setLogicalOperator(logicalOperators.find((item) => item.value === nodeFilter.op));
        setExpressions(savedExpressions);
      } else {
        setExpressions([]);
      }
    } else {
      setExpressions([]);
    }
    loadedNodeIdRef.current = node.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // Convert layers to selector items
  const layerSelectorItems: SelectorItem[] = useMemo(() => {
    return layers.map((layer) => ({
      value: String(layer.id),
      label: layer.name,
      icon:
        layer.feature_layer_geometry_type === "point"
          ? ICON_NAME.POINT_FEATURE
          : layer.feature_layer_geometry_type === "line"
            ? ICON_NAME.LINE_FEATURE
            : layer.feature_layer_geometry_type === "polygon"
              ? ICON_NAME.POLYGON_FEATURE
              : ICON_NAME.TABLE,
    }));
  }, [layers]);

  // Menu items for "Add Dataset" dropdown
  const menuItems = [
    { type: DatasetSourceType.FromProject, icon: ICON_NAME.LAYERS, label: t("from_project") },
    { type: DatasetSourceType.MyDatasets, icon: ICON_NAME.DATABASE, label: t("my_datasets") },
  ];

  // Handle tab change
  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  // Handle menu open
  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setMenuAnchorEl(event.currentTarget);
  };

  // Handle menu close
  const handleMenuClose = () => {
    setMenuAnchorEl(null);
  };

  // Handle menu item click
  const handleMenuItemClick = (type: DatasetSourceType) => {
    handleMenuClose();
    switch (type) {
      case DatasetSourceType.FromProject:
        setShowLayerSelector(true);
        break;
      case DatasetSourceType.MyDatasets:
        setMyDatasetsOpen(true);
        break;
    }
  };

  // Handle layer selection from "From project"
  const handleLayerSelect = useCallback(
    (item: SelectorItem | SelectorItem[] | undefined) => {
      if (!item || Array.isArray(item)) return;

      const layer = layers.find((l) => String(l.id) === item.value);
      if (!layer || node.type !== "dataset") return;

      // Copy layer's existing filter to the workflow node (one-way sync)
      let inheritedFilter: Record<string, unknown> | undefined;
      if (layer.query?.cql) {
        const layerCql = layer.query.cql as { op?: string; args?: unknown[] };
        if (layerCql.op && layerCql.args) {
          const layerExpressions = parseCQLQueryToObject(layerCql as { op: string; args: unknown[] });
          if (layerExpressions.length > 0) {
            inheritedFilter = {
              op: layerCql.op,
              expressions: layerExpressions,
            };
          }
        }
      }

      // Update node data with selected layer and inherited filter.
      // - projectLayerId (ProjectLayer.id) is the canonical reference used to render the live name
      // - layerId (dataset UUID) is kept for tile/feature API calls
      // - `unresolved` (set outside datasetNodeDataSchema, see DatasetNode.tsx) is cleared: this is
      //   the picker a template's unresolved "ask" slot sends the user to (T7).
      dispatch(
        updateNode({
          id: node.id,
          changes: {
            data: {
              ...node.data,
              label: layer.name,
              projectLayerId: layer.id,
              layerId: layer.layer_id,
              layerName: layer.name,
              geometryType: layer.feature_layer_geometry_type || undefined,
              layerType: (layer.type as "feature" | "table" | "raster") || undefined,
              // Inherit filter from project layer (one-way copy)
              filter: inheritedFilter,
              filterInitialized: true,
              unresolved: false,
            },
          },
        })
      );

      // Update local expressions state with inherited filter
      if (inheritedFilter) {
        const expressions = inheritedFilter.expressions as ExpressionType[];
        setExpressions(expressions);
        setLogicalOperator(logicalOperators.find((op) => op.value === inheritedFilter.op));
      } else {
        setExpressions([]);
      }
      setShowLayerSelector(false);
    },
    [layers, node, dispatch, logicalOperators]
  );

  // Handle dataset selection from the dataset shelf (workflow-only, no project add)
  const handleMyDatasetsPick = useCallback(
    (item: ContentItem) => {
      if (node.type !== "dataset") return;
      // A bundle is a set of layers, not an input a dataset node can read.
      if (item.type !== "layer") return;

      // Update node data with selected layer (without adding to project).
      // No projectLayerId because this dataset is not part of the project — name lookup falls
      // back to the snapshotted label. Also clears `unresolved` (see handleLayerSelect above).
      dispatch(
        updateNode({
          id: node.id,
          changes: {
            data: {
              ...node.data,
              label: item.name,
              projectLayerId: undefined,
              layerId: item.id,
              layerName: item.name,
              geometryType: item.feature_layer_geometry_type || undefined,
              layerType: (item.layer_type as "feature" | "table" | "raster" | null) || undefined,
              // No filter inheritance for external datasets
              filter: undefined,
              filterInitialized: true,
              unresolved: false,
            },
          },
        })
      );

      setExpressions([]);
    },
    [node, dispatch]
  );

  // Create a new filter expression
  const createExpression = (type: FilterType) => {
    setExpressions((prev) => [
      ...prev,
      {
        id: v4(),
        attribute: "",
        expression: "",
        value: "",
        type,
      },
    ]);

    // If creating a spatial filter, dispatch action to open map view
    if (type === FilterType.Spatial) {
      dispatch(requestMapView());
    }
  };

  // Handle filter expression add menu
  const handleFilterMenuClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (selectedLayer?.type === layerType.Values.feature) {
      setFilterMenuAnchorEl(event.currentTarget);
    } else {
      createExpression(FilterType.Logical);
    }
  };

  // Save filter to node data
  const saveFilterToNode = useCallback(
    (newExpressions: ExpressionType[], operator: SelectorItem | undefined) => {
      if (node.type !== "dataset") return;

      // For now, store as simplified structure
      // The actual CQL generation will happen at workflow execution time
      const filter =
        newExpressions.length > 0
          ? {
              op: operator?.value || "and",
              expressions: newExpressions,
            }
          : undefined;

      dispatch(
        updateNode({
          id: node.id,
          changes: {
            data: {
              ...node.data,
              filter,
              filterInitialized: true, // Preserve this flag so filter doesn't get re-inherited
            },
          },
        })
      );
    },
    [node, dispatch]
  );

  // Handle expression delete
  const handleExpressionDelete = async (expression: ExpressionType) => {
    const updatedExpressions = expressions.filter((e) => e.id !== expression.id);
    setExpressions(updatedExpressions);
    saveFilterToNode(updatedExpressions, logicalOperator);
  };

  // Handle expression duplicate
  const handleExpressionDuplicate = async (expression: ExpressionType) => {
    const updatedExpressions = [...expressions, { ...expression, id: v4() }];
    setExpressions(updatedExpressions);
    saveFilterToNode(updatedExpressions, logicalOperator);
  };

  // Handle expression update
  const handleExpressionUpdate = async (expression: ExpressionType) => {
    const updatedExpressions = expressions.map((e) => (e.id === expression.id ? expression : e));
    setExpressions(updatedExpressions);
    saveFilterToNode(updatedExpressions, logicalOperator);
  };

  // Handle logical operator change
  const handleLogicalOperatorChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    const newOperator = item as SelectorItem;
    setLogicalOperator(newOperator);
    saveFilterToNode(expressions, newOperator);
  };

  // Clear all filters
  const clearFilter = () => {
    setExpressions([]);
    saveFilterToNode([], logicalOperator);
  };

  // Validate expressions
  const areAllExpressionsValid = useMemo(() => {
    return expressions.every((expression) => {
      let hasValue = !!expression.value?.toString();
      if (
        expression.expression === "is_empty_string" ||
        expression.expression === "is_not_empty_string" ||
        expression.expression === "is_blank" ||
        expression.expression === "is_not_blank"
      ) {
        hasValue = true;
      }
      return expression.attribute && expression.expression && hasValue;
    });
  }, [expressions]);

  // Panel title - always "Dataset" for dataset nodes
  const nodeTitle = t("dataset");

  return (
    <Container
      header={<ToolsHeader onBack={onBack} title={nodeTitle} />}
      disablePadding={false}
      body={
        <Box ref={settingsRef} sx={{ mt: -1 }}>
          <StepIssuesSummary issues={stepIssues} sx={{ mt: 2 }} />
          {/* Tabs */}
          <Box sx={{ borderBottom: 1, borderColor: "divider", mx: -3 }}>
            <Tabs value={tabValue} onChange={handleTabChange} variant="fullWidth" sx={{ minHeight: 40 }}>
              <Tab
                label={t("source")}
                {...a11yProps(0)}
                sx={{ textTransform: "uppercase", fontWeight: 600, minHeight: 40, py: 1 }}
              />
              <Tab
                label={t("filter")}
                {...a11yProps(1)}
                disabled={!selectedLayer}
                sx={{ textTransform: "uppercase", fontWeight: 600, minHeight: 40, py: 1 }}
              />
            </Tabs>
          </Box>

          {/* SOURCE Tab */}
          <TabPanel value={tabValue} index={0}>
            {/* Selected layer info */}
            {selectedLayer && !showLayerSelector && (
              <>
                {/* Details section title */}
                <Box sx={{ mb: 2 }}>
                  <Typography variant="body2" fontWeight="bold" sx={{ mb: 1 }}>
                    {t("details")}
                  </Typography>
                  <Divider />
                </Box>

                <Stack spacing={2.5}>
                  {/* Name */}
                  <Stack spacing={0.5}>
                    <Typography variant="body2" fontWeight="bold">
                      {t("name")}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {selectedLayer.name}
                    </Typography>
                  </Stack>

                  {/* Type */}
                  <Stack spacing={0.5}>
                    <Typography variant="body2" fontWeight="bold">
                      {t("type")}
                    </Typography>
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Icon
                        iconName={
                          selectedLayer.feature_layer_geometry_type === "point"
                            ? ICON_NAME.POINT_FEATURE
                            : selectedLayer.feature_layer_geometry_type === "line"
                              ? ICON_NAME.LINE_FEATURE
                              : selectedLayer.feature_layer_geometry_type === "polygon"
                                ? ICON_NAME.POLYGON_FEATURE
                                : ICON_NAME.TABLE
                        }
                        style={{ fontSize: 16 }}
                      />
                      <Typography variant="body2" color="text.secondary">
                        {selectedLayer.type === "feature"
                          ? t("feature_layer")
                          : selectedLayer.type === "table"
                            ? t("table_layer")
                            : selectedLayer.type}
                      </Typography>
                    </Stack>
                  </Stack>

                  {/* Number of features */}
                  {featureCount !== undefined && (
                    <Stack spacing={0.5}>
                      <Typography variant="body2" fontWeight="bold">
                        {t("features")}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {featureCount.toLocaleString()}
                      </Typography>
                    </Stack>
                  )}

                  {/* Description */}
                  {selectedLayer.description && (
                    <Stack spacing={0.5}>
                      <Typography variant="body2" fontWeight="bold">
                        {t("description")}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {selectedLayer.description}
                      </Typography>
                    </Stack>
                  )}

                  {/* Created at */}
                  {selectedLayer.created_at && (
                    <Stack spacing={0.5}>
                      <Typography variant="body2" fontWeight="bold">
                        {t("created_at")}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatDistance(new Date(selectedLayer.created_at), new Date(), {
                          addSuffix: true,
                          locale: dateLocale,
                        })}
                      </Typography>
                    </Stack>
                  )}

                  {/* Last updated */}
                  {selectedLayer.updated_at && (
                    <Stack spacing={0.5}>
                      <Typography variant="body2" fontWeight="bold">
                        {t("last_updated")}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatDistance(new Date(selectedLayer.updated_at), new Date(), {
                          addSuffix: true,
                          locale: dateLocale,
                        })}
                      </Typography>
                    </Stack>
                  )}
                </Stack>

                {/* Actions section title */}
                <Box sx={{ mt: 4, mb: 2 }}>
                  <Typography variant="body2" fontWeight="bold" sx={{ mb: 1 }}>
                    {t("actions")}
                  </Typography>
                  <Divider />
                </Box>

                {/* Action buttons - Table, Map */}
                <Stack spacing={2}>
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant={activeDataPanelView === "table" ? "contained" : "outlined"}
                      size="small"
                      startIcon={<Icon iconName={ICON_NAME.TABLE} style={{ fontSize: 16 }} />}
                      onClick={() => {
                        // Open table view in data panel
                        dispatch(requestTableView());
                      }}
                      sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", flex: 1 }}>
                      {t("table")}
                    </Button>
                    {selectedLayer.type !== "table" && (
                      <Button
                        variant={activeDataPanelView === "map" ? "contained" : "outlined"}
                        size="small"
                        startIcon={<Icon iconName={ICON_NAME.MAP} style={{ fontSize: 16 }} />}
                        onClick={() => {
                          // Open map view in data panel
                          dispatch(requestMapView());
                        }}
                        sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", flex: 1 }}>
                        {t("map")}
                      </Button>
                    )}
                  </Stack>

                  {/* Change dataset button */}
                  <Button
                    variant="outlined"
                    size="small"
                    fullWidth
                    startIcon={<Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 16 }} />}
                    onClick={handleMenuOpen}
                    sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
                    {t("change_dataset")}
                  </Button>
                </Stack>
              </>
            )}

            {/* Layer selector (shown when "From project" is selected) */}
            {showLayerSelector && (
              <Box sx={{ mb: 3 }}>
                <Selector
                  selectedItems={
                    selectedLayer ? { value: String(selectedLayer.id), label: selectedLayer.name } : undefined
                  }
                  setSelectedItems={handleLayerSelect}
                  items={layerSelectorItems}
                  label={t("select_layer")}
                  placeholder={t("select_layer")}
                />
                <Button
                  variant="text"
                  size="small"
                  onClick={() => setShowLayerSelector(false)}
                  sx={{ mt: 1, textTransform: "none" }}>
                  {t("cancel")}
                </Button>
              </Box>
            )}

            {/* Add Dataset button (only shown when no layer selected) */}
            {!showLayerSelector && !selectedLayer && (
              <Box sx={{ pt: 2 }}>
                <Button
                  variant="outlined"
                  size="small"
                  fullWidth
                  startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 15 }} />}
                  onClick={handleMenuOpen}
                  sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
                  {t("add_dataset")}
                </Button>
              </Box>
            )}

            {/* Menu for dataset source selection */}
            <Menu
              anchorEl={menuAnchorEl}
              open={menuOpen}
              onClose={handleMenuClose}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              transformOrigin={{ vertical: "top", horizontal: "left" }}
              slotProps={{
                paper: {
                  sx: {
                    width: menuAnchorEl?.offsetWidth,
                    minWidth: menuAnchorEl?.offsetWidth,
                  },
                },
              }}>
              {menuItems.map((item) => (
                <MenuItem key={item.type} onClick={() => handleMenuItemClick(item.type)}>
                  <ListItemIcon>
                    <Icon iconName={item.icon} style={{ fontSize: 15 }} />
                  </ListItemIcon>
                  <Typography variant="body2">{item.label}</Typography>
                </MenuItem>
              ))}
            </Menu>
          </TabPanel>

          {/* FILTER Tab */}
          <TabPanel value={tabValue} index={1}>
            {/* Description */}
            {expressions.length === 0 && (
              <Typography variant="body2" sx={{ fontStyle: "italic", mb: 3 }}>
                {t("filter_layer_message")}
              </Typography>
            )}

            {/* Logical operator selector */}
            {expressions.length > 1 && (
              <>
                <Divider />
                <Selector
                  selectedItems={logicalOperator}
                  setSelectedItems={handleLogicalOperatorChange}
                  items={logicalOperators}
                  label={t("filter_results")}
                />
              </>
            )}

            {/* Expression list */}
            {expressions.length > 0 && (
              <Stack spacing={4} sx={{ pt: 2 }}>
                <Divider />
                {expressions.map((expression) => (
                  <Expression
                    key={expression.id}
                    expression={expression}
                    onDelete={handleExpressionDelete}
                    onDuplicate={handleExpressionDuplicate}
                    onUpdate={handleExpressionUpdate}
                    layerId={selectedLayer?.id}
                  />
                ))}
              </Stack>
            )}

            {/* Add expression button */}
            {selectedLayer && (
              <Stack spacing={2} sx={{ pt: 4 }}>
                <Button
                  onClick={handleFilterMenuClick}
                  fullWidth
                  size="small"
                  disabled={!areAllExpressionsValid}
                  startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 15 }} />}>
                  <Typography variant="body2" fontWeight="bold" color="inherit">
                    {t("add_expression")}
                  </Typography>
                </Button>

                {/* Expression type menu (for feature layers) */}
                {selectedLayer.type === layerType.Values.feature && (
                  <Menu
                    anchorEl={filterMenuAnchorEl}
                    sx={{
                      "& .MuiPaper-root": {
                        boxShadow: "0px 0px 10px 0px rgba(58, 53, 65, 0.1)",
                      },
                    }}
                    anchorOrigin={{ vertical: "top", horizontal: "center" }}
                    transformOrigin={{ vertical: "bottom", horizontal: "center" }}
                    open={filterMenuOpen}
                    onClose={() => setFilterMenuAnchorEl(null)}>
                    <ClickAwayListener onClickAway={() => setFilterMenuAnchorEl(null)}>
                      <MenuList>
                        {filterExpressionTypes.map((item, index) => (
                          <MenuItem
                            key={index}
                            onClick={() => {
                              createExpression(item.sourceType);
                              setFilterMenuAnchorEl(null);
                            }}>
                            <ListItemIcon>
                              <Icon iconName={item.iconName} style={{ fontSize: 15 }} />
                            </ListItemIcon>
                            <Typography variant="body2">{item.label}</Typography>
                          </MenuItem>
                        ))}
                      </MenuList>
                    </ClickAwayListener>
                  </Menu>
                )}

                {/* Clear filter button */}
                <Button
                  variant="outlined"
                  fullWidth
                  size="small"
                  color="error"
                  disabled={expressions.length === 0}
                  onClick={clearFilter}>
                  <Typography variant="body2" color="inherit">
                    {t("clear_filter")}
                  </Typography>
                </Button>
              </Stack>
            )}
          </TabPanel>

          {/* Modals */}
          <DatasetPickerDialog
            open={myDatasetsOpen}
            onClose={() => setMyDatasetsOpen(false)}
            onPick={handleMyDatasetsPick}
          />
        </Box>
      }
    />
  );
}
