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
  Divider,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { formatDistance } from "date-fns";
import { useParams } from "next/navigation";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useDataset } from "@/lib/api/layers";
import { useFeatureCount } from "@/lib/api/processes";
import { filterIssues } from "@/lib/filter/issues";
import type { FilterModel } from "@/lib/filter/model";
import type { AppDispatch } from "@/lib/store";
import { selectActiveDataPanelView } from "@/lib/store/workflow/selectors";
import { requestMapView, requestTableView, updateNode } from "@/lib/store/workflow/slice";
import { inheritedNodeFilter, nodeFilterFrom, nodeFilterModel } from "@/lib/utils/workflowFilter";
import type { ContentItem } from "@/lib/validations/content";
import type { ProjectLayer } from "@/lib/validations/project";
import type { WorkflowNode } from "@/lib/validations/workflow";

import type { SelectorItem } from "@/types/map/common";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useFilterFields } from "@/hooks/map/useFilterFields";
import { useStepFieldFocus } from "@/hooks/workflows/useStepFieldFocus";

import DatasetPickerDialog from "@/components/addLayer/DatasetPickerDialog";
import Container from "@/components/map/panels/Container";
import Selector from "@/components/map/panels/common/Selector";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import { FilterPanel } from "@/components/map/panels/filter/FilterPanel";
import StepIssuesSummary from "@/components/workflows/issues/StepIssuesSummary";
import { useStepIssues } from "@/components/workflows/issues/WorkflowIssuesContext";

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

  // The step's own filter (not the project layer's), as the filter panel's rows. The fields first: read without them
  // the rows would guess their types.
  const { fields, fieldInfos, isLoading: areFieldsLoading } = useFilterFields(nodeLayerId || undefined);
  const storedFilter = node.type === "dataset" && node.data.type === "dataset" ? node.data.filter : undefined;
  const filterModel = useMemo(() => nodeFilterModel(storedFilter, fields), [storedFilter, fields]);
  const filterRowIssues = useMemo(() => filterIssues(filterModel, fields), [filterModel, fields]);

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
      const inheritedFilter = inheritedNodeFilter(layer.query?.cql);

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

      setShowLayerSelector(false);
    },
    [layers, node, dispatch]
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
    },
    [node, dispatch]
  );

  // Save the filter to the node in the shape it is stored in. The node as of now, so a save from a row's editor
  // opened before another change keeps that change.
  const latestNode = useRef(node);
  latestNode.current = node;
  const saveFilterToNode = useCallback(
    (next: FilterModel) => {
      const current = latestNode.current;
      if (current.type !== "dataset" || current.data.type !== "dataset") return;
      dispatch(
        updateNode({
          id: current.id,
          changes: {
            data: {
              ...current.data,
              filter: nodeFilterFrom(next, current.data.filter, fields),
              filterInitialized: true, // Preserve this flag so filter doesn't get re-inherited
            },
          },
        })
      );
    },
    [dispatch, fields]
  );

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
              <Tab label={t("source")} {...a11yProps(0)} sx={{ fontWeight: 600, minHeight: 40, py: 1 }} />
              <Tab
                label={t("filter")}
                {...a11yProps(1)}
                disabled={!selectedLayer}
                sx={{ fontWeight: 600, minHeight: 40, py: 1 }}
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
            {selectedLayer && !areFieldsLoading && (
              // The panel's rows run edge to edge, as in a layer's Filter tab.
              <Box sx={{ mx: -3 }}>
                <FilterPanel
                  // A draft per step: another step starts from its own filter.
                  key={node.id}
                  model={filterModel}
                  fields={fields}
                  fieldInfos={fieldInfos}
                  issues={filterRowIssues}
                  canEdit
                  // The step's saved rows have no switch: a row switched off would be lost on save.
                  canSwitch={false}
                  // No map to draw on or read here: a step's filter has conditions only.
                  area={false}
                  onApply={saveFilterToNode}
                  layerId={selectedLayer.id}
                  scope={node.id}
                />
              </Box>
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
