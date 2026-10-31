/* eslint-disable @typescript-eslint/no-explicit-any */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Box } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useMemo } from "react";

import { setSelectedBuilderItem } from "@/lib/store/map/slice";
import type { BuilderWidgetSchema, ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import type {
  WidgetChartConfig,
  WidgetDataConfig,
  WidgetElementConfig,
  WidgetInformationConfig,
} from "@/lib/validations/widget";
import { chartTypes, dataTypes, elementTypes, informationTypes } from "@/lib/validations/widget";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

/**
 * Check if a widget should be completely hidden in public view
 * (e.g. rich_text with hide_when_no_filter and no active cross-filters).
 */
function useWidgetHidden(widget: BuilderWidgetSchema, viewOnly?: boolean): boolean {
  const { temporaryFilters } = useAppSelector((state) => state.map);

  return useMemo(() => {
    if (!viewOnly) return false;
    const config = widget.config as any;
    if (!config?.options?.hide_when_no_filter) return false;

    // Get layer IDs from the widget's variables (rich_text) or setup
    const layerIds: number[] = [];
    if (config.setup?.variables) {
      for (const v of config.setup.variables) {
        if (v.layer_project_id) layerIds.push(v.layer_project_id);
      }
    } else if (config.setup?.layer_project_id) {
      layerIds.push(config.setup.layer_project_id);
    }

    if (layerIds.length === 0) return false;

    const hasFilter = temporaryFilters.some(
      (f) =>
        layerIds.includes(f.layer_id) ||
        f.additional_targets?.some((t: any) => layerIds.includes(t.layer_id))
    );

    return !hasFilter;
  }, [viewOnly, widget.config, temporaryFilters]);
}

import WidgetErrorBoundary from "@/components/builder/widgets/WidgetErrorBoundary";
import WidgetChart from "@/components/builder/widgets/chart/WidgetChart";
import WidgetData from "@/components/builder/widgets/data/WidgetData";
import WidgetElement from "@/components/builder/widgets/elements/WidgetElement";
import WidgetInformation from "@/components/builder/widgets/information/WidgetInformation";
import { ElementWrapper } from "@/components/common/ElementWrapper";

// Widgets carry 16px of padding (8px outer + 8px content), which is a lot of a
// phone's width and height. Halve it below `md` — the same breakpoint the
// public map page uses to switch to MobileProjectLayout, so this matches
// exactly when the bottom sheet is what's rendering these widgets.
const widgetPadding = (theme: Theme) => ({
  p: 1,
  [theme.breakpoints.down("md")]: { p: 0.5 },
});

interface WidgetWrapperProps {
  widget: BuilderWidgetSchema;
  projectLayers: ProjectLayer[];
  projectLayerGroups: ProjectLayerGroup[];
  viewOnly?: boolean;
  onWidgetDelete?: (widgetId: string) => void;
  onWidgetDuplicate?: (widgetId: string) => void;
  onSelectPanel?: () => void;
  onWidgetUpdate?: (updatedWidget: BuilderWidgetSchema) => void;
  panelWidgets?: BuilderWidgetSchema[];
}

interface DraggableWidgetContainerProps {
  children: React.ReactNode;
  widget: BuilderWidgetSchema;
  onWidgetDelete?: (widgetId: string) => void;
  onWidgetDuplicate?: (widgetId: string) => void;
  onSelectPanel?: () => void;
}

const DraggableWidgetContainer: React.FC<DraggableWidgetContainerProps> = ({
  children,
  widget,
  onWidgetDelete,
  onWidgetDuplicate,
  onSelectPanel,
}) => {
  const dispatch = useAppDispatch();
  const selectedWidget = useAppSelector((state) => state.map.selectedBuilderItem);

  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: widget.id,
    data: widget,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: `${transition}, border-color 0.2s ease-in-out`,
  };

  const isSelected = useMemo(() => {
    if (!selectedWidget || selectedWidget.type !== "widget") return false;
    if (selectedWidget.id === widget.id) return true;
    return false;
  }, [selectedWidget, widget.id]);

  return (
    <Box style={style} ref={setNodeRef}>
      <ElementWrapper
        isSelected={isSelected}
        onSelect={() => dispatch(setSelectedBuilderItem(widget))}
        onDelete={() => onWidgetDelete?.(widget.id)}
        onDuplicate={onWidgetDuplicate && (() => onWidgetDuplicate(widget.id))}
        onSelectParent={onSelectPanel}
        dragAttributes={attributes}
        dragListeners={listeners}
        showDragHandle={true}
        disableContentPointerEvents={true}>
        {children}
      </ElementWrapper>
    </Box>
  );
};

const WidgetWrapper: React.FC<WidgetWrapperProps> = ({
  widget,
  projectLayers,
  projectLayerGroups,
  viewOnly,
  onWidgetDelete,
  onWidgetDuplicate,
  onSelectPanel,
  onWidgetUpdate,
  panelWidgets,
}) => {
  const isHidden = useWidgetHidden(widget, viewOnly);
  const configKey = useMemo(() => JSON.stringify(widget.config ?? null), [widget.config]);

  // Completely remove the widget from the layout in public view
  if (isHidden) return null;

  const isFullHeight = widget.config?.type === "rich_text" || widget.config?.type === "text" || widget.config?.type === "tabs" || widget.config?.type === "table";
  const widgetContent = (
    <Box sx={(theme) => ({ ...widgetPadding(theme), height: isFullHeight ? "100%" : undefined })}>
      {widget.config?.type && informationTypes.options.includes(widget.config?.type as any) && (
        <WidgetInformation
          widgetId={widget.id}
          config={widget.config as WidgetInformationConfig}
          projectLayers={projectLayers}
          projectLayerGroups={projectLayerGroups}
          viewOnly={viewOnly}
        />
      )}
      {widget.config?.type && dataTypes.options.includes(widget.config?.type as any) && (
        <WidgetData
          id={widget.id}
          config={widget.config as WidgetDataConfig}
          projectLayers={projectLayers}
          viewOnly={viewOnly}
          onConfigChange={(nextConfig) => {
            onWidgetUpdate?.({ ...widget, config: nextConfig });
          }}
        />
      )}
      {widget.config?.type && chartTypes.options.includes(widget.config?.type as any) && (
        <WidgetChart config={widget.config as WidgetChartConfig} viewOnly={viewOnly} />
      )}
      {widget.config?.type && elementTypes.options.includes(widget.config?.type as any) && (
        <WidgetElement
          widget={widget}
          config={widget.config as WidgetElementConfig}
          viewOnly={viewOnly}
          projectLayers={projectLayers}
          projectLayerGroups={projectLayerGroups}
          panelWidgets={panelWidgets}
          onWidgetUpdate={(newConfig) => {
            onWidgetUpdate?.({ ...widget, config: newConfig });
          }}
          onNestedWidgetUpdate={(updatedWidget) => {
            onWidgetUpdate?.(updatedWidget);
          }}
        />
      )}
    </Box>
  );

  // A published dashboard leaves out a widget that fails to render; the editor
  // keeps its frame, so it can still be selected, fixed or deleted.
  return viewOnly ? (
    <WidgetErrorBoundary widgetId={widget.id} resetKey={configKey} showNotice={false}>
      <Box sx={(theme) => ({ width: "100%", ...widgetPadding(theme), pointerEvents: "all" })}>
        {widgetContent}
      </Box>
    </WidgetErrorBoundary>
  ) : (
    <DraggableWidgetContainer
      widget={widget}
      onWidgetDelete={onWidgetDelete}
      onWidgetDuplicate={onWidgetDuplicate}
      onSelectPanel={onSelectPanel}>
      <WidgetErrorBoundary widgetId={widget.id} resetKey={configKey} showNotice>
        {widgetContent}
      </WidgetErrorBoundary>
    </DraggableWidgetContainer>
  );
};

export default WidgetWrapper;
