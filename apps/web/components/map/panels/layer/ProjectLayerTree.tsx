// Icons
import AddIcon from "@mui/icons-material/Add";
// MUI
import {
  Badge,
  Box,
  Button,
  Checkbox,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useCatalogDatasetVersions, useCatalogItemVersions } from "@/lib/api/catalog";
import { projectMapUrl } from "@/lib/api/map";
import { projectLayerGroupsKey, projectLayersKey, updateCatalogEntry } from "@/lib/api/projects";
// ----------------------------------------------------------------------
// 3. MAIN COMPONENT
// ----------------------------------------------------------------------
// Redux
import { useUserProfile } from "@/lib/api/users";
import { getWorkflow, refreshWorkflowList } from "@/lib/api/workflows";
import { MAX_EDITABLE_LAYER_SIZE } from "@/lib/constants";
import { activeParts } from "@/lib/filter/read";
import { clearRestoreGroup, closeExplorer, openExplorer } from "@/lib/store/explorer/slice";
import { emitInteractionEvent } from "@/lib/store/interaction/slice";
import { setSelectedBundle, setSelectedLayers } from "@/lib/store/layer/slice";
import { setActiveRightPanel, setDataPanelLayerId, setIsDataPanelOpen } from "@/lib/store/map/slice";
import { requestWorkflowReload } from "@/lib/store/workflow/slice";
import type { Geometry } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { buildLegend, informative, legendDependsOnZoom, titleOnly } from "@/lib/style/legend";
import { MAP_SCOPE } from "@/lib/style/render/viewPresence";
import type { TimeStep } from "@/lib/style/time";
import { isBundleMemberLayer, isEditableBundleMember } from "@/lib/utils/bundleEditable";
import {
  catalogItemSnapshot,
  isCatalogLayer,
  isCatalogLayerFailed,
  isCatalogLayerPending,
} from "@/lib/utils/catalog-layer";
import { canEditLayerFeatures } from "@/lib/utils/layerPermissions";
import { type ExtentLayer, canZoomTo } from "@/lib/utils/map/layerExtent";
import { selectedTreeItemIds } from "@/lib/utils/map/layerTreeSelection";
import { zoomToLayer, zoomToProjectLayer } from "@/lib/utils/map/navigate";
// API & Store
import type {
  ProjectLayer,
  ProjectLayerGroup,
  ProjectLayerTreeNode,
  ProjectLayerTreeUpdate,
} from "@/lib/validations/project";

import { ContentActions, MapLayerActions } from "@/types/common";
import { MapSidebarItemID } from "@/types/map/common";

import { useExplorerLeave } from "@/hooks/explorer/useExplorerLeave";
import { useLayerSettingsMoreMenu } from "@/hooks/map/LayerPanelHooks";
import { useBundleMemberGates } from "@/hooks/map/useBundleMemberGates";
import type { GroupStateChange, LayerStateChange, LayerTimeChange } from "@/hooks/map/useLayerTreeState";
import type { MapLayer } from "@/hooks/map/useMapLayers";
import useStartEditingGuard from "@/hooks/map/useStartEditingGuard";
import { timeOf } from "@/hooks/map/useTimeSteps";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";
import {
  type LegendLayer,
  legendLayerOf,
  useLayerLegend,
  useLegendZoom,
} from "@/hooks/style/useLegendPresence";

// Modals
import AddLayerMenu from "@/components/addLayer/AddLayerMenu";
import PopupContentRenderer from "@/components/builder/widgets/common/PopupContentRenderer";
// Common Components
import MoreMenu from "@/components/common/PopperMenu";
import type { PopperMenuItem } from "@/components/common/PopperMenu";
import { StyleLegend, TableLayerIcon, layerSwatchIcon } from "@/components/map/legend/StyleLegend";
import { areaOutlineStore, showSavedArea } from "@/components/map/panels/filter/area/outline";
import { LayerTimeSlider } from "@/components/map/panels/layer/LayerTimeSlider";
import { MaskedImageIcon } from "@/components/map/panels/style/other/MaskedImageIcon";
import ConfirmModal from "@/components/modals/Confirm";
import ContentDialogWrapper from "@/components/modals/ContentDialogWrapper";
import MapLayerChartModal from "@/components/modals/MapLayerChart";
import ProjectLayerDeleteModal from "@/components/modals/ProjectLayerDelete";
import ProjectLayerGroupModal from "@/components/modals/ProjectLayerGroupModal";
import ProjectLayerRenameModal from "@/components/modals/ProjectLayerRename";

// Tree Components
import { DraggableTreeView } from "./DraggableTreeView";
import { LockedLayerRow } from "./LockedLayerRow";
import {
  type ProjectTreeItem,
  TABLES_PREFIX,
  catalogBundleGroups,
  foldBundleTables,
  followCatalogUpdateInWorkflow,
  formatApiDataForDnd,
  formatDndDataForApi,
  outdatedBundleGroups,
  treeChanges,
  updatableCatalogEntry,
} from "./layerTreeItems";

/** For a visibility change made for the user rather than by a click. */
const SYNTHETIC_CLICK = { stopPropagation: () => undefined } as React.MouseEvent;
// Who shows a saved area on the map while a filter badge is hovered.
const BADGE_HOVER = {};

/** The zoom rows read their swatches and legends at when none of them changes with the zoom. */
const LEGEND_FIXED_ZOOM = 12;
// No groups, the same array on every render: the tree data is built from it.
const NO_GROUPS: ProjectLayerGroup[] = [];

// 1. HELPER COMPONENTS

export const AddLayerButton = ({
  projectId,
  variant = "outlined",
  startIcon = true,
  disabled = false,
}: {
  projectId: string;
  variant?: "text" | "outlined" | "contained";
  startIcon?: boolean;
  /** Off while the Explorer is open (board 5). */
  disabled?: boolean;
}) => {
  const { t } = useTranslation("common");
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  return (
    <>
      <Tooltip title={disabled ? t("explorer_add_layer_off") : ""}>
        <span>
          <Button
            variant={variant}
            size="small"
            disabled={disabled}
            startIcon={startIcon ? <AddIcon fontSize="small" /> : undefined}
            onClick={(event) => setAnchorEl(event.currentTarget)}
            sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold", whiteSpace: "nowrap" }}>
            {t("add_layer")}
          </Button>
        </span>
      </Tooltip>
      <AddLayerMenu anchorEl={anchorEl} onClose={() => setAnchorEl(null)} projectId={projectId} />
    </>
  );
};

/** A layer's legend under its row, with the classes its `legend.classes` lists (spec 7.2): those the layer's filter
 * keeps, or those in the map's view. A note once none of its classes is left. A legend of the name only draws its own
 * title alone. */
const TreeLayerLegend = ({
  style,
  geometry,
  zoom,
  serviceLegendUrl,
  layer,
  hideHeading,
}: {
  style: JsonObject;
  geometry?: Geometry;
  zoom: number;
  serviceLegendUrl?: string;
  layer: LegendLayer;
  hideHeading?: boolean;
}) => {
  const legend = useLayerLegend(style, { geometry, zoom, serviceLegendUrl }, layer, MAP_SCOPE);
  return legend && (informative(legend) || titleOnly(legend)) ? (
    // The caption goes into the row's caption slot instead.
    <StyleLegend
      legend={{ ...legend, caption: undefined }}
      variant="tree"
      hideHeading={hideHeading}
      // A long list of entries (of any legend) shows its first ten and "Show N more".
      collapseAfter={10}
    />
  ) : null;
};

/** How many rows a folded Tables row holds. */
const CountPill = ({ count }: { count: number }) => (
  <Box
    component="span"
    sx={{
      px: 0.75,
      py: 0.125,
      mr: 0.5,
      borderRadius: 1,
      bgcolor: "action.hover",
      color: "text.secondary",
      fontSize: 11,
      fontWeight: 600,
    }}>
    {count}
  </Box>
);

/** Marks the bundle the Explorer has open (board 5). */
const InExplorerChip = () => {
  const { t } = useTranslation("common");
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        px: "8px",
        py: 0.25,
        mr: 0.5,
        // A pill, as the Explorer's other small labels.
        borderRadius: "999px",
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12),
        // The icon in GOAT's darker green; the caption keeps its own grey.
        color: "primary.dark",
        flexShrink: 0,
      }}>
      <Icon iconName={ICON_NAME.BUS} style={{ fontSize: 10 }} htmlColor="inherit" />
      <Typography variant="caption" fontWeight={700} sx={{ lineHeight: 1.4, whiteSpace: "nowrap" }}>
        {t("explorer_in_explorer")}
      </Typography>
    </Stack>
  );
};

// --- Empty State ---
const EmptyLayerState = ({ projectId, isEditMode }: { projectId: string; isEditMode: boolean }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flexGrow: 1,
        p: 4,
        textAlign: "center",
        height: "100%",
        color: theme.palette.text.secondary,
      }}>
      <Box sx={{ mb: 2 }}>
        <Icon
          iconName={ICON_NAME.LAYERS}
          style={{ fontSize: "48px", color: theme.palette.action.disabled }}
        />
      </Box>
      <Typography variant="body1" fontWeight="bold" gutterBottom>
        {t("no_layers_added")}
      </Typography>
      <Typography variant="caption" sx={{ mb: 4, maxWidth: 200 }}>
        {isEditMode ? t("start_building_map_desc") : t("no_active_layers")}
      </Typography>
      {isEditMode && (
        <Stack spacing={2} direction="column" alignItems="center" sx={{ width: "100%" }}>
          <Box sx={{ width: "100%", maxWidth: 200, display: "flex", justifyContent: "center" }}>
            <AddLayerButton projectId={projectId} variant="contained" />
          </Box>
        </Stack>
      )}
    </Box>
  );
};

// --- Visibility Toggle ---
// Single source for the three toggle styles. Used as the row prefix
// (togglePosition "left"), inside the row actions ("right"), and by the
// dashboard widget's "show all" row.
//
// On coarse pointers the hit area is grown to 44px. The desktop target is
// ~24px, which is fine for a mouse but easy to miss with a finger — that is
// what made layers feel unresponsive in the mobile dashboard. Only the
// padding grows; the glyph itself stays the same size.
const COARSE_POINTER = "@media (pointer: coarse)";
const COARSE_TARGET = { p: 1.5, minWidth: 44, minHeight: 44 };

export const VisibilityToggle = ({
  toggleStyle,
  visible,
  compact,
  onToggle,
}: {
  toggleStyle: "eye" | "checkbox" | "switch";
  visible: boolean;
  /** Tighter desktop padding, used where the toggle sits inline before the label */
  compact?: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) => {
  const { t } = useTranslation("common");
  const padding = compact ? 0.25 : 0.5;

  if (toggleStyle === "checkbox") {
    return (
      <Checkbox
        size="small"
        checked={visible}
        onChange={(e) => onToggle(e as unknown as React.MouseEvent)}
        sx={{ p: padding, [COARSE_POINTER]: COARSE_TARGET }}
      />
    );
  }

  if (toggleStyle === "switch") {
    return (
      <Switch
        size="small"
        checked={visible}
        onChange={(e) => onToggle(e as unknown as React.MouseEvent)}
        sx={{
          transform: "scale(0.75)",
          mx: -0.5,
          // Undo the shrink on touch — the scaled switch is only ~28px tall
          [COARSE_POINTER]: { transform: "none", mx: 0 },
        }}
      />
    );
  }

  return (
    <Tooltip title={visible ? t("hide") : t("show")} placement="top">
      <IconButton size="small" onClick={onToggle} sx={{ p: padding, [COARSE_POINTER]: COARSE_TARGET }}>
        <Icon iconName={visible ? ICON_NAME.EYE : ICON_NAME.EYE_SLASH} style={{ fontSize: "15px" }} />
      </IconButton>
    </Tooltip>
  );
};

// ----------------------------------------------------------------------
// 2. UTILS
// ----------------------------------------------------------------------
const geometryOf = (type: string | null | undefined): Geometry | undefined => {
  const g = type?.toLowerCase();
  return g === "point" || g === "line" || g === "polygon" ? g : undefined;
};

const castNodeToProjectLayer = (node: ProjectLayerTreeNode): ProjectLayer => {
  return {
    ...node,
    layer_id: node.layer_id || "",
    id: node.id,
    name: node.name,
    // Map geometry_type from tree node to feature_layer_geometry_type expected by ProjectLayer
    feature_layer_geometry_type: node.geometry_type as "point" | "line" | "polygon" | undefined,
  } as unknown as ProjectLayer;
};

// Helper function to filter menu options for view mode
const filterMenuForViewMode = (
  menuOptions: PopperMenuItem[],
  allowedActions?: { style?: boolean }
): PopperMenuItem[] => {
  const excludedActions: string[] = [
    ContentActions.DELETE,
    MapLayerActions.RENAME,
    MapLayerActions.DUPLICATE,
    MapLayerActions.EDIT_FEATURES,
    MapLayerActions.UPDATE_CATALOG,
  ];
  // Only remove the Style action when the widget has not explicitly allowed it.
  // allowedActions.style === true means the dashboard builder configured this
  // layer-tree widget to expose styling to public/view-mode users.
  if (allowedActions?.style !== true) {
    excludedActions.push(MapLayerActions.STYLE);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return menuOptions.filter((option) => !excludedActions.includes(option.id as any));
};

// Catalogue layers cannot be duplicated or have features edited. Renaming is allowed: it only
// changes the project layer's name, never the shared catalog dataset.
const filterMenuForCatalogLayer = (menuOptions: PopperMenuItem[]): PopperMenuItem[] => {
  const excludedActions = [MapLayerActions.DUPLICATE, MapLayerActions.EDIT_FEATURES];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return menuOptions.filter((option) => !excludedActions.includes(option.id as any));
};

// ----------------------------------------------------------------------

// ----------------------------------------------------------------------

interface ProjectLayerTreeProps {
  projectId: string;
  /** The map's layers: rows with their map entry and active style. */
  projectLayers?: MapLayer[];
  projectLayerGroups?: ProjectLayerGroup[];
  /** Order, parents and groups opened or closed (the tree PUT). */
  onTreeUpdate?: (updatePayload: ProjectLayerTreeUpdate) => Promise<void>;
  /** A layer shown or hidden, its legend opened or closed (map state). */
  onLayerStateChange?: LayerStateChange;
  /** A group shown or hidden (map state). */
  onGroupStateChange?: GroupStateChange;
  /** A time-enabled layer's slider moved (map state). */
  onLayerTimeChange?: LayerTimeChange;
  onCreateGroup?: (groupData: { name: string; parent_id?: number }) => Promise<void>;
  onUpdateGroup?: (groupData: { name?: string; groupId?: number }) => Promise<void>;
  onDeleteGroup?: (groupData: { groupId?: number }) => Promise<void>;
  onLayerDuplicate?: (layerId: string) => Promise<void>;
  /** Callback when a layer starts being dragged (for workflow canvas integration) */
  onLayerDragStart?: (event: React.DragEvent, layer: ProjectLayer) => void;
  isLoading?: boolean;
  viewMode?: "edit" | "view";
  hideActions?: boolean;
  // New configurable props for dashboard widget
  toggleStyle?: "eye" | "checkbox" | "switch";
  togglePosition?: "left" | "right";
  moreOptionsStyle?: "compact" | "direct_actions";
  allowedActions?: {
    style?: boolean;
    viewData?: boolean;
    properties?: boolean;
    zoomTo?: boolean;
  };
  /** Layer IDs that should show download action (view mode only) */
  downloadableLayers?: number[];
  /** Layer IDs whose legend renders as a single row (base marker, else fill
   * color) instead of the full attribute breakdown */
  simpleLegendLayerIds?: number[];
  /** Hide attribute/field name headings in legend */
  hideLegendHeading?: boolean;
  /** Custom group icons keyed by group ID */
  groupIcons?: Record<string, { url: string; source?: string }>;
  /** Whether to dim layers that are outside the current zoom range (default: true for backward compat) */
  dimOutOfZoom?: boolean;
  /** Content rendered inside the scroll container, above the tree (e.g. a "show all" toggle row) */
  headerContent?: React.ReactNode;
  /** Per-group info text (keyed by group ID string) shown as an ⓘ button on the group row */
  groupInfo?: Record<string, string>;
  /** Content shown under a group row instead of its layers, keyed by group ID */
  groupContent?: Record<number, React.ReactNode>;
  /** Project owner's user id, used to decide whether feature editing is offered.
   * Passed in rather than fetched so the public dashboard, which renders this
   * tree read-only, makes no authenticated request. */
  projectOwnerId?: string | null;
}

export const ProjectLayerTree = ({
  projectId,
  projectLayers = [],
  projectLayerGroups = NO_GROUPS,
  onTreeUpdate,
  onLayerStateChange,
  onGroupStateChange,
  onLayerTimeChange,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onLayerDuplicate,
  onLayerDragStart,
  isLoading,
  viewMode = "edit",
  hideActions = false,
  toggleStyle = "eye",
  togglePosition = "right",
  moreOptionsStyle = "compact",
  allowedActions,
  downloadableLayers,
  simpleLegendLayerIds,
  hideLegendHeading,
  groupIcons,
  dimOutOfZoom = true,
  headerContent,
  groupInfo,
  groupContent,
  projectOwnerId,
}: ProjectLayerTreeProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { map } = useMap();
  const mapRef = useRef(map);
  mapRef.current = map;
  const dispatch = useAppDispatch();
  const { userProfile } = useUserProfile();
  // Only subscribe to currentZoom when dimming is enabled and in view mode
  const currentZoom = useAppSelector((state) =>
    dimOutOfZoom && viewMode === "view" ? state.map.currentZoom : undefined
  );
  // Swatches and legends show values by zoom at the zoom the map is at.
  const legendZoom = useLegendZoom();
  const editingLayerId = useAppSelector((state) => state.featureEditor.activeLayerId);
  const startEditingGuard = useStartEditingGuard();
  // Which member layers of the project's bundles may be edited, by role.
  const bundleMemberGates = useBundleMemberGates(projectLayerGroups.map((group) => group.bundle_id));
  // Bundle groups holding a GTFS feed, which the Explorer opens: a member
  // with the stop_times role says so, whatever the group is called.
  const ptBundleGroupIds = useMemo(() => {
    const ids = new Set<number>();
    for (const layer of projectLayers) {
      const role = bundleMemberGates?.get(layer.layer_id)?.role;
      if (role === "stop_times" && layer.layer_project_group_id) ids.add(layer.layer_project_group_id);
    }
    return ids;
  }, [projectLayers, bundleMemberGates]);

  const [items, setItems] = useState<ProjectTreeItem[]>([]);
  const itemsRef = useRef<ProjectTreeItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const [groupModal, setGroupModal] = useState<{
    open: boolean;
    mode: "create" | "rename" | "delete";
    group?: ProjectLayerTreeNode;
  }>({ open: false, mode: "create" });
  const [groupInfoDialog, setGroupInfoDialog] = useState<{ id: number; anchorEl: HTMLElement } | null>(null);

  const activeLayerId = useAppSelector((state) => state.layers.activeLayerId);
  const activeRightPanel = useAppSelector((state) => state.map.activeRightPanel);
  const selectedLayerIds = useAppSelector((state) => state.layers.selectedLayerIds || []);
  const selectedBundleId = useAppSelector((state) => state.layers.selectedBundleId);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  // The bundle the Explorer has open: marked in the tree (board 5), and no
  // layers are added meanwhile.
  const leaveExplorer = useExplorerLeave();
  const exploredBundleId = useAppSelector((state) =>
    state.explorer.active ? state.explorer.bundleId : null
  );
  const restoreGroupId = useAppSelector((state) => state.explorer.restoreGroupId);
  const {
    getLayerMoreMenuOptions,
    openMoreMenu,
    closeMoreMenu,
    moreMenuState,
    activeLayer: activeLayerMoreMenu,
  } = useLayerSettingsMoreMenu();

  const isEditMode = viewMode === "edit";

  // Combine layers and groups into tree nodes
  const treeData = useMemo(() => {
    const nodes: ProjectLayerTreeNode[] = [];

    // Add groups as tree nodes
    projectLayerGroups.forEach((group) => {
      nodes.push({
        id: group.id,
        type: "group",
        name: group.name,
        parent_id: group.parent_id,
        order: group.order ?? 0, // Provide default value for order
        extent: "", // Groups don't have extent, use empty string as default
        visible: group.visible,
        expanded: group.expanded,
        bundle_id: group.bundle_id, // Bundle-backed groups have locked membership
      });
    });

    // Add layers as tree nodes
    projectLayers.forEach((layer) => {
      nodes.push({
        id: layer.id,
        type: "layer",
        name: layer.name,
        parent_id: layer.layer_project_group_id,
        order: layer.order ?? 0, // Provide default value for order
        extent: layer.extent || "", // Provide default value for extent
        layer_id: layer.layer_id,
        layer_type: layer.type,
        geometry_type: layer.feature_layer_geometry_type,
        visible: layer.entry?.visible !== false,
        legend_expanded: layer.entry?.legend?.expanded !== false,
        style: layer.style?.document ?? null,
        query: layer.query,
        other_properties: layer.other_properties,
        // A catalog layer has no owner; the tree's node type says "unknown".
        user_id: layer.user_id ?? undefined,
        is_catalog: isCatalogLayer(layer),
        locked: layer.locked,
      });
    });

    return nodes.sort((a, b) => a.order - b.order);
  }, [projectLayers, projectLayerGroups]);

  /**
   * The live catalog version of every promoted layer's item, one request per
   * distinct id set. A layer promoted at version N whose item now carries a
   * newer version gets the "update available" caption below.
   */
  /** A catalog bundle's group carries one "update available" for all its layers. */
  const bundleGroups = useMemo(() => catalogBundleGroups(treeData), [treeData]);
  const catalogItemIds = useMemo(
    () =>
      Array.from(
        new Set(
          (projectLayers ?? [])
            // A bundle's layers are checked together, by their group.
            .filter(
              (layer) => !(layer.layer_project_group_id && bundleGroups.has(layer.layer_project_group_id))
            )
            .map((layer) => catalogItemSnapshot(layer).id)
            .filter((id): id is string => !!id)
        )
      ),
    [projectLayers, bundleGroups]
  );
  const { versions: liveCatalogVersions } = useCatalogItemVersions(catalogItemIds);

  const bundleDatasets = useMemo(
    () => Array.from(new Set(Array.from(bundleGroups.values()).map((bundle) => bundle.dataset))),
    [bundleGroups]
  );
  const { versions: liveBundleVersions } = useCatalogDatasetVersions(bundleDatasets);
  const outdatedBundles = useMemo(
    () => outdatedBundleGroups(bundleGroups, liveBundleVersions),
    [bundleGroups, liveBundleVersions]
  );

  /**
   * The one caption a layer row can carry: a catalog layer whose data is
   * still materializing (or failed to), or whose catalog item has moved on to
   * a newer version. Everything else stays caption-less.
   */
  /** The catalog has a newer version of this entry: a bundle group, or a layer outside one. */
  const isOutdatedCatalogEntry = useCallback(
    (node: ProjectLayerTreeNode): boolean => {
      if (node.type === "group") return outdatedBundles.has(node.id);
      if (node.parent_id && bundleGroups.has(node.parent_id)) return false;
      const snapshot = catalogItemSnapshot(node);
      const live = snapshot.id ? liveCatalogVersions[snapshot.id] : undefined;
      return !!snapshot.version && !!live && live !== snapshot.version;
    },
    [liveCatalogVersions, outdatedBundles, bundleGroups]
  );

  const catalogStatusLabel = useCallback(
    (node: ProjectLayerTreeNode): string | undefined => {
      if (node.type === "layer" && isCatalogLayerPending(node)) return t("catalog_layer_pending");
      if (node.type === "layer" && isCatalogLayerFailed(node)) return t("catalog_layer_failed");
      return isOutdatedCatalogEntry(node) ? t("catalog_layer_update_available") : undefined;
    },
    [t, isOutdatedCatalogEntry]
  );

  const openWorkflowId = useAppSelector((state) => state.workflow.selectedWorkflowId);
  /** Moves an outdated catalog entry to the new version, in place (the user decides). */
  /** Entries whose update is running: a second click waits for the first. */
  const updating = useRef(new Set<string>());
  const updateCatalog = useCallback(
    async (node: ProjectLayerTreeNode) => {
      const target = updatableCatalogEntry(node, isOutdatedCatalogEntry(node));
      const key = `${node.type}-${node.id}`;
      if (!target || !projectId || updating.current.has(key)) return;
      updating.current.add(key);
      try {
        await updateCatalogEntry(projectId, target);
        void followCatalogUpdateInWorkflow(projectId, {
          openWorkflowId: () => openWorkflowId,
          read: getWorkflow,
          requestReload: (id, revision) => dispatch(requestWorkflowReload({ id, revision })),
          refreshList: refreshWorkflowList,
        });
      } catch (error) {
        // The server says why (already on the newest version, another kind now, ...).
        toast.error(error instanceof Error ? error.message : t("error_updating_layer_tree"));
      } finally {
        updating.current.delete(key);
      }
      // The map's styles too: an untouched style may now be the new version's.
      await Promise.all([
        mutate(projectLayersKey(projectId)),
        mutate(projectLayerGroupsKey(projectId)),
        mutate(projectMapUrl(projectId)),
      ]);
    },
    [isOutdatedCatalogEntry, projectId, t, openWorkflowId, dispatch]
  );

  /**
   * While any catalog layer is materializing, poll the project layers so the
   * pending caption clears (and the map draws) without a reload. The job is
   * backend-enqueued and not in the user's job tray, so this is the signal.
   */
  const anyCatalogPending = useMemo(
    () => (projectLayers ?? []).some((layer) => isCatalogLayerPending(layer)),
    [projectLayers]
  );
  useEffect(() => {
    if (!anyCatalogPending || !projectId) return;
    const timer = setInterval(() => {
      void mutate(projectLayersKey(projectId));
    }, 4000);
    return () => clearInterval(timer);
  }, [anyCatalogPending, projectId]);

  useEffect(() => {
    if (treeData) {
      setItems((prevItems) => {
        const newItems = foldBundleTables(formatApiDataForDnd(treeData, catalogStatusLabel), t("tables"));
        if (prevItems.length === 0) return newItems;
        // For items that already existed, preserve their collapsed state.
        // Newly appearing layer items (e.g. inside a group that was just toggled visible)
        // are expanded so their legends are immediately visible.
        const prevById = new Map(prevItems.map((item) => [item.id, item]));
        return newItems.map((item) => {
          const prev = prevById.get(item.id);
          if (prev) {
            return { ...item, collapsed: prev.collapsed };
          }
          // New layer items: expand legend so attribute-based styling is shown
          if (!item.isGroup) {
            return { ...item, collapsed: false };
          }
          return item;
        });
      });
    }
  }, [treeData, catalogStatusLabel, t]);

  // What the tree highlights is what is actually open — a selected bundle
  // included, whose row is a group and so has no entry in `selectedLayerIds`.
  const treeSelectedIds = useMemo(
    () => selectedTreeItemIds(items, { selectedLayerIds, selectedBundleId }),
    [selectedLayerIds, selectedBundleId, items]
  );

  // --- Handlers ---

  const handleVisibilityToggle = useCallback(
    async (node: ProjectLayerTreeNode, e: React.MouseEvent) => {
      e.stopPropagation();
      const before = itemsRef.current;
      const visible = node.visible === false;

      // Shown at once; a hidden layer's legend closes with it.
      setItems(
        before.map((i) =>
          i.data.id === node.id && i.data.type === node.type
            ? { ...i, data: { ...i.data, visible }, collapsed: !visible }
            : i
        )
      );

      // Emit interaction events based on visibility toggle
      if (node.type === "layer") {
        dispatch(emitInteractionEvent({ type: "visibility_changed", sourceId: node.id, value: visible }));
      }
      // When turning a group ON, activate it (switch tab). Turning OFF is just hiding.
      if (node.type === "group" && visible) {
        dispatch(emitInteractionEvent({ type: "group_activated", sourceId: node.id }));
      }

      try {
        if (node.type === "layer") await onLayerStateChange?.(node.id, { visible });
        else await onGroupStateChange?.(node.id, { visible });
      } catch (err) {
        setItems(before);
        toast.error(t("error_updating_visibility"));
        console.error("Error in handleVisibilityToggle:", err);
      }
    },
    [dispatch, onLayerStateChange, onGroupStateChange, t]
  );

  // The Explorer has closed: show again the bundle it hid, unless the user
  // switched it on meanwhile.
  useEffect(() => {
    if (restoreGroupId === null) return;
    const item = itemsRef.current.find((i) => i.data.type === "group" && i.data.id === restoreGroupId);
    if (!item) return;
    dispatch(clearRestoreGroup());
    if (item.data.visible === false) void handleVisibilityToggle(item.data, SYNTHETIC_CLICK);
  }, [restoreGroupId, items, dispatch, handleVisibilityToggle]);

  const handleProperties = useCallback(
    (layer: ProjectLayer) => {
      dispatch(setSelectedLayers([layer.id]));
      dispatch(setActiveRightPanel(MapSidebarItemID.PROPERTIES));
    },
    [dispatch]
  );

  const handleStyle = useCallback(
    (layer: ProjectLayer) => {
      dispatch(setSelectedLayers([layer.id]));
      dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
    },
    [dispatch]
  );

  const handleDuplicate = useCallback(
    async (layer: ProjectLayer) => {
      try {
        if (onLayerDuplicate) {
          await onLayerDuplicate(layer.layer_id);
        }
      } catch (error) {
        toast.error(t("error_duplicating_layer"));
      }
    },
    [onLayerDuplicate, t]
  );

  const handleNodeClick = (compositeIds: string[]) => {
    // A Tables row has nothing to open: a click on it folds or unfolds it.
    const tablesRow = compositeIds.find((id) => id.startsWith(TABLES_PREFIX));
    if (tablesRow) {
      setItems((prev) => prev.map((i) => (i.id === tablesRow ? { ...i, collapsed: !i.collapsed } : i)));
      return;
    }
    const realIds = compositeIds
      .map((cId) => {
        const item = items.find((i) => i.id === cId);
        return item?.data?.id;
      })
      .filter((id) => id !== undefined);

    // Emit interaction event for group activation (works in all modes)
    if (realIds.length === 1) {
      const clickedItem = items.find((i) => i.id === compositeIds[0]);
      if (clickedItem?.data?.type === "group") {
        dispatch(emitInteractionEvent({ type: "group_activated", sourceId: realIds[0] }));
        // A bundle-backed group stands for the bundle itself, which has its own
        // metadata and can be filtered as a whole — so it opens a panel where a
        // plain group has nothing to show.
        const bundleId = clickedItem.data.bundle_id;
        if (isEditMode && bundleId) {
          dispatch(setSelectedBundle(bundleId));
          dispatch(setActiveRightPanel(MapSidebarItemID.PROPERTIES));
        }
        return;
      }
    }

    // In view mode, only emit interaction events — don't change selection or panels
    if (!isEditMode) return;

    dispatch(setSelectedLayers(realIds));

    // Sync data panel layer — if the panel is closed, this is a no-op.
    // While a feature-edit session is active the panel stays pinned to the
    // editing layer: plain tree selection must not hijack (or end) the
    // session — only explicitly opening another layer's table does.
    if (realIds.length === 1 && !editingLayerId) {
      dispatch(setDataPanelLayerId(realIds[0]));
    }

    if (realIds.length > 0) {
      // Get the first selected layer to determine default panel
      const firstSelectedItem = items.find((i) => {
        const node = i.data;
        return node && realIds.includes(node.id);
      });

      if (firstSelectedItem) {
        const node = firstSelectedItem.data;
        const layerType = node.layer_type;

        // Set default panel based on layer type
        if (layerType === "raster") {
          dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
        } else if (layerType === "table") {
          dispatch(setActiveRightPanel(MapSidebarItemID.FILTER));
        } else {
          // Vector layers default to Style
          dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
        }
      }
    } else {
      dispatch(setSelectedBundle(null));
      dispatch(setActiveRightPanel(undefined));
    }
  };

  const handleCreateGroup = () => {
    setGroupModal({ open: true, mode: "create" });
  };

  const handleGroupModalSubmit = async (data: { name?: string; groupId?: number }) => {
    try {
      if (groupModal.mode === "create" && data.name && onCreateGroup) {
        await onCreateGroup({ name: data.name });
      } else if (groupModal.mode === "rename" && onUpdateGroup) {
        await onUpdateGroup(data);
      } else if (groupModal.mode === "delete" && onDeleteGroup) {
        await onDeleteGroup(data);
      }

      setGroupModal({ open: false, mode: "create" });
    } catch (error) {
      throw error;
    }
  };

  // --- ZOOM TO ---
  /** The project layer a tree row stands for: the tree node carries too little of it (no data type, no address). */
  const zoomTargetOf = useCallback(
    (node: ProjectLayerTreeNode): ProjectLayer =>
      projectLayers.find((layer) => layer.id === node.id) ?? castNodeToProjectLayer(node),
    [projectLayers]
  );

  /** Layers whose area is being read for a zoom to, or could not be; asked again once the layers reload. */
  const [zoomStates, setZoomStates] = useState<Record<number, "pending" | "failed">>({});
  useEffect(() => setZoomStates((states) => (Object.keys(states).length ? {} : states)), [projectLayers]);

  const zoomTo = useCallback(
    async (node: ProjectLayerTreeNode) => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      if (node.type !== "layer") {
        if (node.extent) zoomToLayer(currentMap, node.extent);
        return;
      }
      setZoomStates((states) => ({ ...states, [node.id]: "pending" }));
      const zoomed = await zoomToProjectLayer(currentMap, zoomTargetOf(node));
      setZoomStates((states) => {
        const next = { ...states };
        if (zoomed) delete next[node.id];
        else next[node.id] = "failed";
        return next;
      });
      if (!zoomed) toast.info(t("zoom_to_extent_unknown"));
    },
    [mapRef, zoomTargetOf, t]
  );

  // --- ROW ACTIONS ---
  // Defined as a useCallback (not a nested component) so its reference stays stable
  // across re-renders that don't change relevant deps. A nested component definition
  // would get a new identity on every render, causing React to unmount/remount the
  // PopperMenu and reset its open state — closing the three-dots menu unexpectedly.
  const renderRowActions = useCallback(
    (item: ProjectTreeItem) => {
      const node = item.data as ProjectLayerTreeNode;
      const nodeVisibility = node.visible !== false;
      if (item.tablesOf !== undefined) return <CountPill count={item.tableCount ?? 0} />;

      // Prepare Menu Options
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let menuOptions: PopperMenuItem[] = [];
      if (node.type === "group") {
        menuOptions = [
          ...(item.isBundleGroup && ptBundleGroupIds.has(node.id) && mapMode === "data"
            ? [
                // The bundle open in the Explorer offers the way out instead.
                node.bundle_id && node.bundle_id === exploredBundleId
                  ? {
                      id: MapLayerActions.EXIT_EXPLORER,
                      label: t("explorer_exit"),
                      icon: ICON_NAME.SIGNOUT,
                    }
                  : {
                      id: MapLayerActions.OPEN_EXPLORER,
                      label: t("explorer"),
                      icon: ICON_NAME.BUS,
                      // The menu's leading entry, its icon on a tile (board 2).
                      featured: true,
                    },
              ]
            : []),
          ...(node.extent
            ? [
                {
                  id: MapLayerActions.ZOOM_TO,
                  label: t("zoom_to") || "Zoom To",
                  icon: ICON_NAME.ZOOM_IN,
                },
              ]
            : []),
          { id: MapLayerActions.RENAME, label: t("rename") || "Rename", icon: ICON_NAME.EDIT },
          {
            id: ContentActions.DELETE,
            // For a bundle group, delete removes the bundle from the project.
            label: item.isBundleGroup ? t("remove_bundle") || "Remove bundle" : t("delete") || "Delete",
            icon: ICON_NAME.TRASH,
            color: "error.main",
          },
        ];
      } else if (node.locked) {
        // D7: a locked row carries no style/data — the backend whitelist has
        // nothing the usual menu builder could act on — so the only action
        // offered is removing it from the project, gated exactly like every
        // other layer's DELETE below (view mode, bundle membership, project
        // role all still apply through the same filters).
        menuOptions = [
          {
            id: ContentActions.DELETE,
            label: t("delete") || "Delete",
            icon: ICON_NAME.TRASH,
            color: "error.main",
          },
        ];
      } else {
        menuOptions = getLayerMoreMenuOptions(
          (node.layer_type as "table" | "feature" | "raster") || "feature",
          !!node.query,
          !!node.is_catalog,
          false,
          // Catalog and size are handled by the filters below.
          canEditLayerFeatures({
            currentUserId: userProfile?.id,
            layerOwnerId: node.user_id,
            projectOwnerId,
            isProjectEditor: isEditMode,
          }),
          isEditMode
        );
      }

      // An outdated catalog entry offers its update, to project editors only.
      if (isEditMode && updatableCatalogEntry(node, isOutdatedCatalogEntry(node))) {
        menuOptions = [
          {
            id: MapLayerActions.UPDATE_CATALOG,
            label: t("catalog_update_to_new_version"),
            icon: ICON_NAME.REFRESH,
          },
          ...menuOptions,
        ];
      }

      // Bundle member layers can't be removed individually (remove the bundle).
      if (node.type === "layer" && item.dragDisabled) {
        menuOptions = menuOptions.filter((opt) => opt.id !== ContentActions.DELETE);
      }

      // A bundle member is editable only where its role's spec says so: editing
      // one drives the whole bundle's derived artifacts.
      if (
        node.type === "layer" &&
        node.layer_id &&
        isBundleMemberLayer(node.layer_id, bundleMemberGates) &&
        !isEditableBundleMember(node.layer_id, bundleMemberGates)
      ) {
        menuOptions = menuOptions.filter((opt) => opt.id !== MapLayerActions.EDIT_FEATURES);
      }

      // Filter menu options based on view mode
      if (viewMode === "view") {
        menuOptions = filterMenuForViewMode(menuOptions, allowedActions);
      }

      // Catalogue layers cannot be duplicated or have features edited
      if (node.is_catalog) {
        menuOptions = filterMenuForCatalogLayer(menuOptions);
      }

      // Edit features only available in data (map) mode
      if (mapMode !== "data") {
        menuOptions = menuOptions.filter((opt) => opt.id !== MapLayerActions.EDIT_FEATURES);
      }

      // Edit features only allowed for layers under 100MB
      if (node.type === "layer" && node.layer_id) {
        const layerSize = projectLayers.find((l) => l.layer_id === node.layer_id)?.size;
        if (layerSize && layerSize > MAX_EDITABLE_LAYER_SIZE) {
          menuOptions = menuOptions.filter((opt) => opt.id !== MapLayerActions.EDIT_FEATURES);
        }
      }

      // Filter menu options based on allowedActions
      if (allowedActions) {
        menuOptions = menuOptions.filter((opt) => {
          if (opt.id === MapLayerActions.STYLE && allowedActions.style === false) return false;
          if (opt.id === ContentActions.TABLE && allowedActions.viewData === false) return false;
          if (opt.id === MapLayerActions.PROPERTIES && allowedActions.properties === false) return false;
          if (opt.id === MapLayerActions.ZOOM_TO && allowedActions.zoomTo === false) return false;
          return true;
        });
      }

      // Filter download action based on downloadableLayers
      if (downloadableLayers && node.type === "layer") {
        menuOptions = menuOptions.filter((opt) => {
          if (opt.id === ContentActions.DOWNLOAD) {
            return downloadableLayers.includes(node.id);
          }
          return true;
        });
      }

      // Zoom to: gone where nothing could ever tell the layer's area (an XYZ tile template); off, saying why, while
      // the area is being read or after it could not be.
      if (node.type === "layer") {
        if (!canZoomTo(zoomTargetOf(node) as ExtentLayer)) {
          menuOptions = menuOptions.filter((opt) => opt.id !== MapLayerActions.ZOOM_TO);
        } else if (zoomStates[node.id]) {
          const tooltip = t(
            zoomStates[node.id] === "pending" ? "zoom_to_extent_reading" : "zoom_to_extent_unknown"
          );
          menuOptions = menuOptions.map((opt) =>
            opt.id === MapLayerActions.ZOOM_TO ? { ...opt, disabled: true, tooltip } : opt
          );
        }
      }

      const hasFilter = activeParts(node.query?.cql);
      const isFilterActive = activeLayerId === node.id && activeRightPanel === MapSidebarItemID.FILTER;

      return (
        <Stack direction="row" alignItems="center" spacing={1}>
          {/* Filter Badge - Only show in edit mode */}
          {isEditMode && node.type === "layer" && hasFilter > 0 && (
            <Tooltip
              title={isFilterActive ? t("hide_applied_filters") : t("show_applied_filters")}
              placement="top">
              <IconButton
                size="small"
                color={isFilterActive ? "primary" : "default"}
                // The saved filter's area lights up on the map while the badge is hovered.
                onMouseEnter={() => showSavedArea(BADGE_HOVER, node.query)}
                onMouseLeave={() => areaOutlineStore.clear(BADGE_HOVER)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isFilterActive) dispatch(setActiveRightPanel(undefined));
                  else {
                    if (node.id !== activeLayerId) dispatch(setSelectedLayers([node.id]));
                    dispatch(setActiveRightPanel(MapSidebarItemID.FILTER));
                  }
                }}
                sx={{ p: 0.5 }}>
                <Badge
                  badgeContent={hasFilter}
                  color="primary"
                  sx={{ "& .MuiBadge-badge": { fontSize: 9, height: 15, minWidth: 15 } }}>
                  <Icon htmlColor="inherit" iconName={ICON_NAME.FILTER} style={{ fontSize: "15px" }} />
                </Badge>
              </IconButton>
            </Tooltip>
          )}

          {/* Actions: direct buttons or compact three-dot menu */}
          {!hideActions &&
            menuOptions.length > 0 &&
            (moreOptionsStyle === "direct_actions" ? (
              <>
                {menuOptions.map(
                  (opt) =>
                    opt.icon && (
                      <Tooltip key={opt.id} title={opt.tooltip ?? opt.label} placement="top">
                        <span>
                          <IconButton
                            size="small"
                            disabled={opt.disabled}
                            sx={{ p: 0.25 }}
                            onClick={async (e) => {
                              e.stopPropagation();
                              const handleAction = async () => {
                                if (opt.id === MapLayerActions.ZOOM_TO) {
                                  await zoomTo(node);
                                } else if (opt.id === MapLayerActions.UPDATE_CATALOG) {
                                  await updateCatalog(node);
                                } else if (node.type === "layer") {
                                  const target = castNodeToProjectLayer(node);
                                  if (opt.id === MapLayerActions.PROPERTIES) handleProperties(target);
                                  else if (opt.id === MapLayerActions.STYLE) handleStyle(target);
                                  else if (opt.id === MapLayerActions.DUPLICATE) handleDuplicate(target);
                                  else if (opt.id === ContentActions.TABLE) {
                                    if (mapMode === "data") {
                                      dispatch(setDataPanelLayerId(target.id));
                                      dispatch(setIsDataPanelOpen(true));
                                    } else {
                                      openMoreMenu(opt, target);
                                    }
                                  } else openMoreMenu(opt, target);
                                }
                              };
                              await handleAction();
                            }}>
                            <Icon iconName={opt.icon} style={{ fontSize: "13px" }} htmlColor={opt.color} />
                          </IconButton>
                        </span>
                      </Tooltip>
                    )
                )}
              </>
            ) : (
              <MoreMenu
                menuItems={menuOptions}
                disablePortal={false}
                menuButton={
                  <Tooltip title={t("more_options")} placement="top">
                    <IconButton size="small" sx={{ px: 0.5 }}>
                      <Icon iconName={ICON_NAME.MORE_VERT} style={{ fontSize: "15px" }} />
                    </IconButton>
                  </Tooltip>
                }
                onSelect={async (menuItem: PopperMenuItem) => {
                  if (menuItem.id === MapLayerActions.ZOOM_TO) {
                    await zoomTo(node);
                    return;
                  }
                  if (menuItem.id === MapLayerActions.UPDATE_CATALOG) {
                    await updateCatalog(node);
                    return;
                  }
                  if (node.type === "layer") {
                    const target = castNodeToProjectLayer(node);
                    if (menuItem.id === MapLayerActions.PROPERTIES) {
                      handleProperties(target);
                    } else if (menuItem.id === MapLayerActions.STYLE) {
                      handleStyle(target);
                    } else if (menuItem.id === MapLayerActions.DUPLICATE) {
                      handleDuplicate(target);
                    } else if (menuItem.id === MapLayerActions.EDIT_FEATURES) {
                      startEditingGuard.requestStartEditing({
                        layerId: target.layer_id,
                        geometryType: target.feature_layer_geometry_type ?? null,
                        projectLayerId: target.id,
                      });
                    } else if (menuItem.id === ContentActions.TABLE) {
                      if (mapMode === "data") {
                        dispatch(setDataPanelLayerId(target.id));
                        dispatch(setIsDataPanelOpen(true));
                      } else {
                        openMoreMenu(menuItem, target);
                      }
                    } else {
                      openMoreMenu(menuItem, target);
                    }
                  } else {
                    if (menuItem.id === MapLayerActions.EXIT_EXPLORER) {
                      leaveExplorer(() => dispatch(closeExplorer()));
                    } else if (menuItem.id === MapLayerActions.OPEN_EXPLORER && node.bundle_id) {
                      const bundleId = node.bundle_id;
                      // Over another bundle's Explorer with unsaved changes:
                      // asked first, then opened.
                      leaveExplorer(() => {
                        dispatch(setIsDataPanelOpen(false));
                        dispatch(setActiveRightPanel(undefined));
                        // The Explorer draws the bundle itself: its own layers
                        // are switched off, as the row's eye would, and back on
                        // when the Explorer closes.
                        const wasVisible = node.visible !== false;
                        if (wasVisible) void handleVisibilityToggle(node, SYNTHETIC_CLICK);
                        dispatch(
                          openExplorer({
                            bundleId,
                            bundleName: node.name,
                            hiddenGroupId: wasVisible ? node.id : null,
                          })
                        );
                      });
                    } else if (menuItem.id === MapLayerActions.RENAME && node.type === "group") {
                      setGroupModal({ open: true, mode: "rename", group: node });
                    } else if (menuItem.id === ContentActions.DELETE && node.type === "group") {
                      setGroupModal({ open: true, mode: "delete", group: node });
                    } else {
                      const groupAsLayer = castNodeToProjectLayer(node);
                      openMoreMenu(menuItem, groupAsLayer);
                    }
                  }
                }}
              />
            ))}

          {/* Group info ⓘ button */}
          {node.type === "group" && groupInfo?.[String(node.id)] && (
            <Tooltip title={t("properties")} placement="top">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  setGroupInfoDialog({ id: node.id, anchorEl: e.currentTarget as HTMLElement });
                }}
                sx={{ p: 0.25 }}>
                <Icon iconName={ICON_NAME.CIRCLEINFO} style={{ fontSize: "15px" }} />
              </IconButton>
            </Tooltip>
          )}

          {/* Visibility toggle - very right when position is "right".
            A locked layer has no map entry to toggle, and never reaches
            the map anyway (see D7). */}
          {togglePosition !== "left" && !hideActions && node.layer_type !== "table" && !node.locked && (
            <VisibilityToggle
              toggleStyle={toggleStyle}
              visible={nodeVisibility}
              onToggle={(e) => handleVisibilityToggle(node, e)}
            />
          )}
        </Stack>
      );
    },
    [
      t,
      getLayerMoreMenuOptions,
      openMoreMenu,
      handleVisibilityToggle,
      leaveExplorer,
      handleProperties,
      handleStyle,
      handleDuplicate,
      setGroupModal,
      setGroupInfoDialog,
      mapRef,
      viewMode,
      hideActions,
      toggleStyle,
      togglePosition,
      moreOptionsStyle,
      allowedActions,
      downloadableLayers,
      projectLayers,
      isEditMode,
      groupInfo,
      mapMode,
      isOutdatedCatalogEntry,
      updateCatalog,
      userProfile,
      projectOwnerId,
      dispatch,
      activeLayerId,
      activeRightPanel,
      bundleMemberGates,
      zoomTargetOf,
      zoomTo,
      zoomStates,
      ptBundleGroupIds,
    ]
  );

  // --- ICONS & LEGEND ---
  // The zoom the rows' swatches and legends are read at: the map's while any row's legend changes with it, else a
  // fixed one (those legends are the same at every zoom), so a zoom does not rebuild every row.
  const treeZoom = useMemo(
    () =>
      items.some((item) => {
        const style = (item.data as ProjectLayerTreeNode | undefined)?.style;
        return isObject(style) && legendDependsOnZoom(style as JsonObject);
      })
        ? legendZoom
        : LEGEND_FIXED_ZOOM,
    [items, legendZoom]
  );

  const itemsWithIcons = useMemo(() => {
    return items.map((item) => {
      const node = item.data;
      const nodeVisibility = node.visible !== false;

      // 0. A bundle's Tables row
      if (item.tablesOf !== undefined) {
        return {
          ...item,
          icon: <TableLayerIcon />,
          isVisible: true,
          isSelectable: false,
        };
      }

      // 1. Group Icon
      if (node.type === "group") {
        const customIcon = groupIcons?.[`group_icon_${node.id}`];
        return {
          ...item,
          icon: customIcon?.url ? (
            <MaskedImageIcon
              imageUrl={customIcon.url}
              dimension="16px"
              applyMask={customIcon.source === "library"}
              imgColor={theme.palette.action.active}
            />
          ) : (
            <Icon
              // Bundle-backed groups get a distinct icon (a cube = a self-contained
              // package of layers) to signal locked membership.
              iconName={item.isBundleGroup ? ICON_NAME.CUBE : ICON_NAME.LAYERS}
              style={{ fontSize: "1rem", color: theme.palette.action.active }}
            />
          ),
          // The bundle the Explorer has open: its layers are switched off
          // because the Explorer draws it, so the row is not faded, and it
          // says so in its label — the actions stay where every row has them.
          isVisible: nodeVisibility || (!!node.bundle_id && node.bundle_id === exploredBundleId),
          ...(!!node.bundle_id &&
            node.bundle_id === exploredBundleId && {
              contentOverride: (
                <Stack direction="row" alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
                  {/* The icon in the tree's own slot (24 px, then a gap), so the
                      name lines up with every other row's. */}
                  <Box
                    sx={{
                      width: 24,
                      height: 24,
                      mr: 1,
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                    <Icon
                      iconName={ICON_NAME.CUBE}
                      style={{ fontSize: "1rem", color: theme.palette.action.active }}
                    />
                  </Box>
                  {/* The name takes the room, the chip keeps to the right edge. */}
                  <Typography variant="body2" noWrap title={node.name} sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                    {node.name}
                  </Typography>
                  <InExplorerChip />
                </Stack>
              ),
            }),
          // A plain group is only a container, so selecting it would open a
          // panel with nothing in it. A bundle-backed group stands for the
          // bundle, which has metadata of its own and can be filtered as a
          // whole — but only in edit mode, where that panel exists at all.
          isSelectable: !!item.isBundleGroup && isEditMode,
          legendContent: groupContent?.[node.id],
        };
      }

      // D7: a locked layer has no style for this user, so there is no
      // preview or legend to draw — show the lock icon + hint instead, and
      // refuse selection (there is no style panel to open).
      if (node.locked) {
        return {
          ...item,
          contentOverride: <LockedLayerRow name={node.name} />,
          icon: undefined,
          legendContent: undefined,
          isSelectable: false,
          isVisible: true,
          labelInfo: undefined,
        };
      }

      // The layer's icon, as every list of layers draws it.
      const icon = layerSwatchIcon(
        {
          type: node.layer_type,
          feature_layer_geometry_type: node.geometry_type,
          style: node.style ? { document: node.style } : null,
        },
        treeZoom
      );

      if (node.layer_type === "table") {
        return { ...item, icon, isVisible: nodeVisibility };
      }

      // The style says what the row shows (spec 7.2): its zoom range dims it in view mode, its legend options hide the
      // legend or add a caption, and the legend itself is the style's.
      const style = (node.style ?? null) as JsonObject | null;
      const legendOptions = style && isObject(style.legend) ? style.legend : undefined;
      let isZoomVisible = true;
      if (viewMode === "view" && currentZoom !== undefined && style) {
        const minZoom = typeof style.min_zoom === "number" ? style.min_zoom : 0;
        const maxZoom = typeof style.max_zoom === "number" ? style.max_zoom : 24;
        isZoomVisible = currentZoom >= minZoom && currentZoom <= maxZoom;
      }
      const isVisible = nodeVisibility && isZoomVisible;
      const shouldShowLegend =
        viewMode !== "view" || (style?.legend !== false && legendOptions?.show !== false);
      const geometry = geometryOf(node.geometry_type);
      const serviceLegendUrl = (node.other_properties as { legend_urls?: string[] } | null)?.legend_urls?.[0];
      // Whether the row has a legend to show: every class counts here, the legend itself lists those kept.
      const legend =
        style && isVisible && shouldShowLegend && !simpleLegendLayerIds?.includes(node.id)
          ? buildLegend(style, { geometry, zoom: treeZoom, serviceLegendUrl })
          : null;
      const caption =
        shouldShowLegend && typeof legendOptions?.caption === "string" ? legendOptions.caption : undefined;
      const time = timeOf(style);
      const layer = time && node.layer_id ? projectLayers.find((l) => l.id === node.id) : undefined;

      return {
        ...item,
        icon,
        footer:
          time && layer && isVisible && onLayerTimeChange ? (
            <LayerTimeSlider
              datasetId={layer.layer_id}
              time={time}
              value={layer.entry?.time?.value as TimeStep | undefined}
              version={layer.dataset_updated_at}
              onChange={(value, committed) => void onLayerTimeChange(node.id, value, committed)}
            />
          ) : undefined,
        legendContent:
          style && legend && (informative(legend) || titleOnly(legend)) ? (
            <TreeLayerLegend
              style={style}
              geometry={geometry}
              zoom={treeZoom}
              serviceLegendUrl={serviceLegendUrl}
              layer={legendLayerOf(node)}
              hideHeading={hideLegendHeading}
            />
          ) : undefined,
        isSelectable: true,
        isVisible,
        // The legend caption shares the row's one caption slot with the
        // catalog materialize status the item already carries — don't clobber.
        labelInfo: caption ?? item.labelInfo,
      };
    });
  }, [
    items,
    theme,
    currentZoom,
    treeZoom,
    viewMode,
    isEditMode,
    hideLegendHeading,
    groupIcons,
    simpleLegendLayerIds,
    projectLayers,
    onLayerTimeChange,
    exploredBundleId,
    groupContent,
  ]);

  const renderPrefix = useCallback(
    togglePosition === "left"
      ? (item: ProjectTreeItem) => {
          const node = item.data as ProjectLayerTreeNode;
          if (hideActions || node.layer_type === "table" || node.locked || item.tablesOf !== undefined)
            return null;
          const nodeVisibility = node.visible !== false;
          return (
            <Box onClick={(e) => e.stopPropagation()} sx={{ display: "flex", alignItems: "center" }}>
              <VisibilityToggle
                toggleStyle={toggleStyle}
                visible={nodeVisibility}
                compact
                onToggle={(e) => handleVisibilityToggle(node, e)}
              />
            </Box>
          );
        }
      : () => null,
    [togglePosition, hideActions, toggleStyle, handleVisibilityToggle]
  );

  // --- RENDER ---
  if (isLoading && items.length === 0) {
    return <Box sx={{ p: 2, color: "text.secondary" }}>{t("loading_layers")}</Box>;
  }

  if (!isLoading && items.length === 0) {
    return <EmptyLayerState projectId={projectId} isEditMode={isEditMode} />;
  }

  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "all",
      }}>
      {/* 1. Header */}
      {isEditMode && (
        <Box
          sx={{
            px: 2,
            py: 2,
            flexShrink: 0,
            borderBottom: items.length > 0 ? "1px solid" : "none",
            borderColor: "divider",
            zIndex: 1,
          }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="body1" fontWeight="bold">
              {t("layers")}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Tooltip title={t("create_group") || "Create Group"}>
                <IconButton
                  size="small"
                  onClick={handleCreateGroup}
                  sx={{ color: theme.palette.action.active }}>
                  <Icon iconName={ICON_NAME.LAYERS} />
                </IconButton>
              </Tooltip>
              <AddLayerButton projectId={projectId} disabled={!!exploredBundleId} />
            </Stack>
          </Stack>
        </Box>
      )}

      {/* 2. Modals - Show download/table modals in both edit and view mode */}
      <>
        {(moreMenuState?.id === ContentActions.DOWNLOAD || moreMenuState?.id === ContentActions.TABLE) &&
          activeLayerMoreMenu && (
            <ContentDialogWrapper
              content={activeLayerMoreMenu}
              action={moreMenuState.id as ContentActions}
              onClose={closeMoreMenu}
              onContentDelete={closeMoreMenu}
              type="layer"
            />
          )}
        {/* Edit-only modals */}
        {isEditMode && (
          <>
            {moreMenuState?.id === ContentActions.DELETE && activeLayerMoreMenu && (
              <ProjectLayerDeleteModal
                open={true}
                onClose={closeMoreMenu}
                projectLayer={activeLayerMoreMenu}
                onDelete={closeMoreMenu}
              />
            )}
            {moreMenuState?.id === MapLayerActions.RENAME && activeLayerMoreMenu && (
              <ProjectLayerRenameModal
                open={true}
                onClose={closeMoreMenu}
                projectLayer={activeLayerMoreMenu}
                onRename={closeMoreMenu}
              />
            )}
            {moreMenuState?.id === MapLayerActions.CHART && activeLayerMoreMenu && (
              <MapLayerChartModal
                open={true}
                onClose={closeMoreMenu}
                layer={activeLayerMoreMenu}
                projectId={projectId}
              />
            )}
            {groupModal.open && (
              <ProjectLayerGroupModal
                open={groupModal.open}
                onClose={() => setGroupModal({ open: false, mode: "create" })}
                mode={groupModal.mode}
                projectId={projectId}
                layerTree={treeData}
                existingGroup={groupModal.group}
                onSubmit={handleGroupModalSubmit}
              />
            )}
          </>
        )}
      </>

      {/* 3. Tree */}
      <Box sx={{ flexGrow: 1, overflowY: "auto", overflowX: "hidden", px: 1, pt: 1 }}>
        {headerContent}
        <DraggableTreeView
          items={itemsWithIcons}
          onItemsChange={(newItems) => {
            // Always update local state so expand/collapse arrows work in view mode.
            // Persist only in edit mode: legends as map state, order and groups by the tree PUT.
            const changes = treeChanges(itemsRef.current, newItems);
            setItems(newItems);
            if (!isEditMode) return;
            for (const [id, expanded] of changes.legends)
              void onLayerStateChange?.(id, { legend_expanded: expanded });
            if (changes.tree && onTreeUpdate) void onTreeUpdate(formatDndDataForApi(newItems));
          }}
          renderActions={renderRowActions}
          renderPrefix={togglePosition === "left" ? renderPrefix : undefined}
          enableSelection
          disableDrag={!isEditMode}
          selectedIds={treeSelectedIds}
          onSelect={handleNodeClick}
          onExternalDragStart={
            onLayerDragStart
              ? (event, item) => {
                  // Only allow dragging layers, not groups
                  if (item.data.type === "layer") {
                    const layer = castNodeToProjectLayer(item.data);
                    onLayerDragStart(event, layer);
                  }
                }
              : undefined
          }
          sx={{ width: "100%" }}
        />
      </Box>
      {groupInfoDialog !== null && groupInfo?.[String(groupInfoDialog.id)] && (
        <PopupContentRenderer
          open
          onClose={() => setGroupInfoDialog(null)}
          popup_type="dialog"
          placement="auto"
          anchorEl={groupInfoDialog.anchorEl}
          title={projectLayerGroups.find((g) => g.id === groupInfoDialog.id)?.name ?? ""}
          content={groupInfo[String(groupInfoDialog.id)]}
        />
      )}
      <ConfirmModal
        open={startEditingGuard.confirmOpen}
        title={t("stop_editing")}
        body={t("discard_edits_confirmation")}
        closeText={t("cancel")}
        confirmText={t("stop_editing")}
        onClose={startEditingGuard.cancel}
        onConfirm={startEditingGuard.confirm}
      />
    </Box>
  );
};
