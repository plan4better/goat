import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import { Divider, IconButton, Tooltip, useTheme } from "@mui/material";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Typography from "@mui/material/Typography";
import { alpha, styled } from "@mui/material/styles";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

// ----------------------------------------------------------------------
// 1. INTERFACES
// ----------------------------------------------------------------------
export interface BaseTreeItem {
  id: string;
  parentId?: string | null;
  label: string;
  collapsed?: boolean;
  isGroup?: boolean;
  icon?: React.ReactNode;
  legendContent?: React.ReactNode;
  isSelectable?: boolean;
  isVisible?: boolean; // Add this property for visibility styling
  labelInfo?: string; // Add missing property
  /** Replaces the icon + label (and the labelInfo caption) with a single
   *  custom node — e.g. a locked project layer's row, which has no
   *  geometry-preview icon to draw and shows its hint inline instead of as
   *  a caption. Leaves the prefix, expand chevron and actions unaffected. */
  contentOverride?: React.ReactNode;
  canExpand?: boolean; // Add missing property
  /** Item cannot be dragged (e.g. a bundle group's member layers). */
  dragDisabled?: boolean;
  /** Item cannot be a drop target (e.g. a bundle group and its members, so
   *  layers can't be dropped into a locked bundle group). */
  dropDisabled?: boolean;
  /** Group that is backed by a bundle (locked membership). */
  isBundleGroup?: boolean;
}

interface DraggableTreeViewProps<T extends BaseTreeItem> {
  items: T[];
  onItemsChange: (newItems: T[]) => void;
  renderActions?: (item: T) => React.ReactNode;
  renderPrefix?: (item: T) => React.ReactNode;
  enableSelection?: boolean;
  /** Disable drag & drop reordering while keeping selection/expand behavior (e.g. view-only trees) */
  disableDrag?: boolean;
  selectedIds?: string[];
  onSelect?: (ids: string[]) => void;
  /** Callback for HTML5 external drag start (e.g., to workflow canvas) */
  onExternalDragStart?: (event: React.DragEvent, item: T) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sx?: any;
}

// ----------------------------------------------------------------------
// 2. STYLED COMPONENTS
// ----------------------------------------------------------------------
const CustomTreeItemRoot = styled("div")(({ theme }) => ({
  color: theme.palette.text.secondary,
  position: "relative",
  userSelect: "none",
}));

const CustomTreeItemContent = styled("div", {
  shouldForwardProp: (prop) =>
    prop !== "enableSelection" && prop !== "isDragging" && prop !== "itemVisible" && prop !== "isSelectable",
})<{
  enableSelection?: boolean;
  isDragging?: boolean;
  itemVisible?: boolean;
  isSelectable?: boolean;
}>(({ theme, enableSelection, isDragging, itemVisible, isSelectable }) => ({
  color: theme.palette.text.secondary,
  borderRadius: 0,
  paddingRight: theme.spacing(0.5),
  fontWeight: theme.typography.fontWeightMedium,
  display: "flex",
  alignItems: "center",
  minHeight: 40,
  paddingTop: theme.spacing(0.5),
  paddingBottom: theme.spacing(0.5),
  border: "1px solid transparent",
  transition: "background-color 0.1s, opacity 0.2s",
  cursor: !enableSelection || isSelectable === false ? "default" : "pointer",
  pointerEvents: "all", // Ensure tree rows are clickable even when parent has pointerEvents: none

  // Apply visibility opacity only to the content part, not actions
  "& .tree-content-area": {
    opacity: itemVisible ? 1 : 0.5,
    transition: "opacity 0.2s",
  },

  ".dnd-drag-active &": {
    cursor: enableSelection ? "grabbing" : "default",
  },

  // 1. Show background on Mouse Hover (actions are always visible)
  "&:hover": {
    backgroundColor: theme.palette.action.hover,
  },

  ...(isDragging && {
    opacity: 0.5,
    backgroundColor: theme.palette.action.selected,
    cursor: "grabbing",
    "& .tree-row-actions": {
      opacity: 0.3, // Just dim them slightly when dragging
    },
  }),

  "&.selected": {
    backgroundColor: alpha(theme.palette.primary.main, 0.08),
    color: theme.palette.primary.main,
    "&:hover": {
      backgroundColor: alpha(theme.palette.primary.main, 0.12),
    },
  },
}));

const LeftIconContainer = styled("div")(({ theme }) => ({
  marginRight: theme.spacing(1),
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  flexShrink: 0,
  fontSize: "1.2rem",
  color: theme.palette.action.active,
}));

const ActionsContainer = styled("div")(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(0.5),
  opacity: 1, // Always visible
  pointerEvents: "auto", // Always interactive
  paddingLeft: theme.spacing(1),
}));

const InsertionLine = styled("div")(({ theme }) => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: 2,
  backgroundColor: theme.palette.primary.main,
  zIndex: 10,
  pointerEvents: "none",
}));

const EmptyPlaceholderBox = styled("div")(({ theme }) => ({
  height: 32,
  display: "flex",
  alignItems: "center",
  color: theme.palette.text.disabled,
  fontSize: "0.8rem",
  fontStyle: "italic",
  border: `1px dashed ${theme.palette.action.disabled}`,
  borderRadius: 4,
  margin: "4px 8px 4px 0",
  "&.is-over": {
    borderColor: theme.palette.primary.main,
    color: theme.palette.primary.main,
    backgroundColor: alpha(theme.palette.primary.main, 0.05),
  },
}));

// ----------------------------------------------------------------------
// 3. HELPER COMPONENTS
// ----------------------------------------------------------------------

const TruncatedLabel = ({ label }: { label: string }) => {
  const textRef = useRef<HTMLElement>(null);
  const [isTooltipEnabled, setIsTooltipEnabled] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setIsTooltipEnabled(
        el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [label]);

  return (
    <Tooltip title={label} disableHoverListener={!isTooltipEnabled} arrow placement="top" enterDelay={1000}>
      <Typography
        ref={textRef}
        variant="body2"
        sx={{
          fontWeight: "inherit",
          flexGrow: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflowWrap: "anywhere",
          minWidth: 0,
        }}>
        {label}
      </Typography>
    </Tooltip>
  );
};

const EmptyGroupPlaceholder = ({
  parentId,
  level,
  enableSelection,
  disableDrag,
}: {
  parentId: string;
  level: number;
  enableSelection?: boolean;
  disableDrag?: boolean;
}) => {
  const { t } = useTranslation("common");
  const { setNodeRef, isOver } = useDroppable({
    id: `placeholder-${parentId}`,
    data: { parentId: parentId },
    disabled: !enableSelection || disableDrag,
  });
  const indentStyle = { marginLeft: (level + 1) * 24 };

  if (!enableSelection || disableDrag) {
    return (
      <Typography
        variant="caption"
        sx={{
          marginLeft: (level + 1) * 12,
          display: "block",
          py: 0.5,
          color: "text.disabled",
          fontStyle: "italic",
        }}>
        ({t("no_items")})
      </Typography>
    );
  }
  return (
    <EmptyPlaceholderBox ref={setNodeRef} className={isOver ? "is-over" : ""} style={indentStyle}>
      <Typography variant="caption" sx={{ ml: 1 }}>
        {t("drag_items_here")}
      </Typography>
    </EmptyPlaceholderBox>
  );
};

// ----------------------------------------------------------------------
// 4. RECURSIVE ITEM COMPONENT
// ----------------------------------------------------------------------

const RecursiveTreeItemInner = <T extends BaseTreeItem>({
  item,
  allData,
  level,
  onCollapse,
  renderActions,
  renderPrefix,
  isOverlay,
  enableSelection,
  disableDrag,
  selectedIds,
  onSelect,
  onExternalDragStart,
}: {
  item: T;
  allData: T[];
  level: number;
  onCollapse: (id: string) => void;
  renderActions?: (item: T) => React.ReactNode;
  renderPrefix?: (item: T) => React.ReactNode;
  isOverlay?: boolean;
  enableSelection?: boolean;
  disableDrag?: boolean;
  selectedIds: string[];
  onSelect?: (ids: string[]) => void;
  onExternalDragStart?: (event: React.DragEvent, item: T) => void;
}) => {
  const children = allData.filter((i) => i.parentId === item.id);
  const isSelected = selectedIds.includes(item.id);
  const isDragDisabled = !enableSelection || disableDrag || isOverlay || !!item.dragDisabled;
  // A bundle group's members reject drops so nothing can be moved into the
  // group; the group's own row stays droppable so it can be reordered.
  const isDropDisabled = isDragDisabled || !!item.dropDisabled;

  const hasLegend = !!item.legendContent;
  const isExpanded = !item.collapsed;

  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: item.id,
    disabled: isDragDisabled,
    data: item,
  });
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: item.id,
    disabled: isDropDisabled,
    data: item,
  });

  const setNodeRef = (node: HTMLElement | null) => {
    setDraggableRef(node);
    setDroppableRef(node);
  };

  // Deselect item when it becomes non-selectable
  useEffect(() => {
    if (item.isSelectable === false && isSelected && onSelect) {
      onSelect(selectedIds.filter((id) => id !== item.id));
    }
  }, [item.isSelectable, isSelected, selectedIds, onSelect, item.id]);

  const handleRowClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // For groups: always notify onSelect so interaction events can fire,
    // even when the group itself isn't "selectable" for highlight purposes
    if (item.isGroup && onSelect) {
      onSelect([item.id]);
      return;
    }

    // Check if item is selectable
    if (!enableSelection || !onSelect || item.isSelectable === false) return;

    if (e.ctrlKey || e.metaKey) {
      isSelected ? onSelect(selectedIds.filter((id) => id !== item.id)) : onSelect([...selectedIds, item.id]);
    } else {
      onSelect([item.id]);
    }
  };

  const handleCollapseToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCollapse(item.id);
  };

  const baseIndent = level * 24;

  // Determine what icon to show on the left
  let LeftIconContent: React.ReactNode = item.icon;

  // For layers with legend content, show clickable arrow
  if (!item.isGroup && hasLegend) {
    LeftIconContent = (
      <KeyboardArrowRightIcon
        sx={{
          transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 0.2s",
          cursor: "pointer",
        }}
        onClick={handleCollapseToggle}
      />
    );
  }

  const isVisible = item.isVisible ?? true; // Default to visible if not specified

  // Handle external drag start (for workflow canvas)
  const handleExternalDragStart = (event: React.DragEvent) => {
    if (onExternalDragStart && !item.isGroup) {
      onExternalDragStart(event, item);
    }
  };

  // dnd-kit's PointerSensor captures pointerdown and preventDefaults, which
  // stops the browser from initiating an HTML5 drag. When the consumer wants
  // HTML5 external drag (e.g., dragging a layer onto the workflow canvas),
  // skip the dnd-kit listeners on this row so the native drag can fire.
  const useExternalDrag = !!onExternalDragStart && !item.isGroup;

  return (
    <Box sx={{ width: "100%" }}>
      <CustomTreeItemRoot
        ref={!isOverlay ? setNodeRef : null}
        {...(!isOverlay && !useExternalDrag ? listeners : {})}
        {...(!isOverlay && !useExternalDrag ? attributes : {})}
        style={{
          touchAction: useExternalDrag || isDragDisabled ? "auto" : "none",
          paddingBottom: isOverlay ? 0 : undefined,
        }}
        draggable={useExternalDrag}
        onDragStart={handleExternalDragStart}>
        <CustomTreeItemContent
          onClick={handleRowClick}
          enableSelection={enableSelection}
          isDragging={isDragging}
          isSelectable={item.isSelectable}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          itemVisible={(item as any).data?.visibility ?? true} // Pass visibility from node data
          className={`tree-item ${isSelected ? "selected" : ""}`}
          sx={{
            opacity: isVisible ? 1 : 0.5, // Apply opacity based on visibility
            flexDirection: "column", // Stack main row and caption vertically
            alignItems: "stretch", // Stretch to full width
            cursor: onExternalDragStart && !item.isGroup ? "grab" : undefined,
          }}>
          {/* Main content row */}
          <Box
            className="tree-content-area"
            sx={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
            <Box sx={{ ml: `${baseIndent}px` }} />
            {renderPrefix && <Box onClick={(e) => e.stopPropagation()}>{renderPrefix(item)}</Box>}
            {item.contentOverride ? (
              <Box sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>
                {item.contentOverride}
              </Box>
            ) : (
              <>
                <LeftIconContainer>{LeftIconContent}</LeftIconContainer>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <TruncatedLabel label={item.label} />
                </Box>
              </>
            )}

            {/* Actions container - always fully visible */}
            <ActionsContainer className="tree-row-actions">
              {/* Show collapse button for groups that can expand */}
              {item.isGroup && item.canExpand !== false && (
                <IconButton
                  size="small"
                  onClick={handleCollapseToggle}
                  sx={{
                    p: 0.5,
                    mr: 0.5,
                    transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s",
                  }}>
                  <ExpandMoreIcon fontSize="inherit" />
                </IconButton>
              )}

              {renderActions && <Box onClick={(e) => e.stopPropagation()}>{renderActions(item)}</Box>}
            </ActionsContainer>
          </Box>

          {/* Caption row - part of the same tree item */}
          {item.labelInfo && !item.contentOverride && (
            <Box
              sx={{
                ml: `${baseIndent + 28}px`, // Align with label text (indent + icon container width + margin)
                mr: 2,
                pb: 0.5,
              }}>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}>
                {item.labelInfo}
              </Typography>
            </Box>
          )}
        </CustomTreeItemContent>
        {isOver && !isDragging && !isOverlay && <InsertionLine sx={{ ml: `${baseIndent}px` }} />}
      </CustomTreeItemRoot>

      {/* Add divider between rows */}
      {!isOverlay && (
        <Divider
          sx={{
            my: 0,
            opacity: 0.5,
          }}
        />
      )}

      {/* EXPANSION */}
      {isExpanded && !isOverlay && item.canExpand !== false && (
        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          <Box>
            {/* For groups: show children */}
            {item.isGroup && (
              <>
                {children.map((child) => (
                  <MemoizedRecursiveTreeItem
                    key={child.id}
                    item={child}
                    allData={allData}
                    level={level + 1}
                    onCollapse={onCollapse}
                    renderActions={renderActions}
                    renderPrefix={renderPrefix}
                    selectedIds={selectedIds}
                    onSelect={onSelect}
                    enableSelection={enableSelection}
                    disableDrag={disableDrag}
                    onExternalDragStart={onExternalDragStart}
                  />
                ))}
                {children.length === 0 && (
                  <EmptyGroupPlaceholder
                    parentId={item.id}
                    level={level}
                    enableSelection={enableSelection}
                    disableDrag={disableDrag}
                  />
                )}
              </>
            )}

            {/* For layers: show legend content if available */}
            {!item.isGroup && hasLegend && (
              <Box
                sx={{
                  paddingLeft: `${baseIndent + 28}px`,
                  paddingRight: 1,
                  paddingBottom: 1,
                  paddingTop: 0.5,
                }}>
                {item.legendContent}
              </Box>
            )}
          </Box>
        </Collapse>
      )}
    </Box>
  );
};

// Memoized version to prevent unnecessary re-renders
// Only re-render if the item's own properties change, not when siblings change
const MemoizedRecursiveTreeItem = React.memo(RecursiveTreeItemInner, (prevProps, nextProps) => {
  // Check if the item itself changed
  if (prevProps.item !== nextProps.item) return false;
  // Check if level changed
  if (prevProps.level !== nextProps.level) return false;
  // Check if selection state changed for this item
  const prevSelected = prevProps.selectedIds.includes(prevProps.item.id);
  const nextSelected = nextProps.selectedIds.includes(nextProps.item.id);
  if (prevSelected !== nextSelected) return false;
  // Check if enableSelection changed
  if (prevProps.enableSelection !== nextProps.enableSelection) return false;
  // Check if disableDrag changed
  if (prevProps.disableDrag !== nextProps.disableDrag) return false;
  // Check if renderActions or renderPrefix changed (e.g. toggle style/position changed)
  if (prevProps.renderActions !== nextProps.renderActions) return false;
  if (prevProps.renderPrefix !== nextProps.renderPrefix) return false;
  // Check if this item's children changed (for groups)
  if (prevProps.item.isGroup) {
    const prevChildren = prevProps.allData.filter((i) => i.parentId === prevProps.item.id);
    const nextChildren = nextProps.allData.filter((i) => i.parentId === nextProps.item.id);
    if (prevChildren.length !== nextChildren.length) return false;
    for (let i = 0; i < prevChildren.length; i++) {
      if (prevChildren[i] !== nextChildren[i]) return false;
    }
  }
  // Props are equal, don't re-render
  return true;
}) as typeof RecursiveTreeItemInner;

export function DraggableTreeView<T extends BaseTreeItem>(props: DraggableTreeViewProps<T>) {
  const {
    items,
    onItemsChange,
    renderActions,
    renderPrefix,
    selectedIds = [],
    onSelect,
    enableSelection = false,
    disableDrag = false,
    onExternalDragStart,
    sx,
  } = props;
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const rootItems = useMemo(() => items.filter((i) => i.parentId === null), [items]);

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!enableSelection || disableDrag || !over) return;
    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);
    // Never move a layer into a bundle-backed group (locked membership).
    const isBundleGroupId = (pid?: string | null) =>
      items.some((i) => i.id === pid && i.isBundleGroup);
    const activeItemEarly = items.find((i) => i.id === activeIdStr);
    if (activeItemEarly?.dragDisabled) return;
    if (overIdStr.startsWith("placeholder-")) {
      const targetParentId = overIdStr.replace("placeholder-", "");
      if (isBundleGroupId(targetParentId)) return;
      const oldIndex = items.findIndex((i) => i.id === activeIdStr);
      if (oldIndex > -1) {
        const newItems = [...items];
        newItems[oldIndex] = { ...newItems[oldIndex], parentId: targetParentId };
        onItemsChange(newItems);
      }
      return;
    }
    if (activeIdStr !== overIdStr) {
      const activeItem = items.find((i) => i.id === activeIdStr);
      const overItem = items.find((i) => i.id === overIdStr);
      if (activeItem && overItem) {
        // Dropping would adopt the target's parent; block if that parent is a
        // locked bundle group.
        if (isBundleGroupId(overItem.parentId)) return;
        const oldIndex = items.findIndex((i) => i.id === activeIdStr);
        const targetIndex = items.findIndex((i) => i.id === overIdStr);
        // The row always lands directly above the target, which is what the
        // insertion line shows. Moving down, arrayMove would otherwise put it
        // below — the target shifts up past it — so the index gives way by one.
        const insertIndex = oldIndex < targetIndex ? targetIndex - 1 : targetIndex;
        const newItems = [...items];
        newItems[oldIndex] = { ...newItems[oldIndex], parentId: overItem.parentId };
        onItemsChange(arrayMove(newItems, oldIndex, insertIndex));
      }
    }
  };

  const handleCollapse = (id: string) => {
    // Allow collapse for both groups and layers with legends
    onItemsChange(items.map((i) => (i.id === id ? { ...i, collapsed: !i.collapsed } : i)));
  };

  const activeItem = activeId ? items.find((i) => i.id === activeId) : null;

  // The overlay is a copy of the row, so it needs the row's indent: rendered
  // at level 0 it starts one nesting level to the left of what the cursor
  // grabbed, which reads as the drag lagging behind the pointer.
  const theme = useTheme();
  // Resolved after mount: there is no document during SSR.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setPortalTarget(document.body), []);

  const activeLevel = React.useMemo(() => {
    let level = 0;
    let parentId = activeItem?.parentId ?? null;
    while (parentId) {
      level += 1;
      parentId = items.find((i) => i.id === parentId)?.parentId ?? null;
    }
    return level;
  }, [activeItem, items]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}>
      <Box sx={{ flexGrow: 1, ...sx }} className={activeId ? "dnd-drag-active" : ""}>
        {rootItems.map((item) => (
          <MemoizedRecursiveTreeItem
            key={item.id}
            item={item}
            allData={items}
            level={0}
            onCollapse={handleCollapse}
            renderActions={renderActions}
            renderPrefix={renderPrefix}
            selectedIds={selectedIds}
            onSelect={onSelect}
            enableSelection={enableSelection}
            disableDrag={disableDrag}
            onExternalDragStart={onExternalDragStart}
          />
        ))}
      </Box>
      {/* Portaled to the body: the overlay is `position: fixed` with the
          dragged row's viewport coordinates, and the floating panel this tree
          lives in has a `backdrop-filter`, which makes it the containing block
          for fixed descendants. Left inside it, the overlay is offset by the
          panel's own distance from the top of the window. */}
      {portalTarget
        ? createPortal(
            <DragOverlay dropAnimation={null} zIndex={theme.zIndex.drawer + 2}>
              {activeItem ? (
                <RecursiveTreeItemInner
                  item={{ ...activeItem, collapsed: true }}
                  allData={[]}
                  level={activeLevel}
                  onCollapse={() => {}}
                  renderActions={renderActions}
                  renderPrefix={renderPrefix}
                  isOverlay
                  selectedIds={selectedIds}
                  enableSelection={true}
                />
              ) : null}
            </DragOverlay>,
            portalTarget
          )
        : null}
    </DndContext>
  );
}
