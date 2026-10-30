import { Stack } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { removeTemporaryFilter } from "@/lib/store/map/slice";
import { hasNestedSchemaPath } from "@/lib/utils/zod";
import type { BuilderWidgetSchema } from "@/lib/validations/project";
import type { LayerInformationSchema, LinksElementSchema, RichTextDataSchema, TabsContainerSchema } from "@/lib/validations/widget";
import { widgetSchemaMap } from "@/lib/validations/widget";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import {
  WidgetData,
  WidgetInfo,
  WidgetLayout,
  WidgetOptions,
  WidgetSetup,
  WidgetStyle,
} from "@/components/builder/widgets/common/WidgetCommonConfigs";
import RichTextConfig from "@/components/builder/widgets/data/RichTextConfig";
import LinksConfiguration from "@/components/builder/widgets/elements/LinksConfiguration";
import TabsWidgetConfig from "@/components/builder/widgets/elements/TabsWidgetConfig";
import LayersWidgetConfig from "@/components/builder/widgets/information/LayersWidgetConfig";

interface WidgetConfigurationProps {
  onChange: (widget: BuilderWidgetSchema) => void;
  samePanelWidgets: BuilderWidgetSchema[];
}

const WidgetConfiguration = ({ onChange, samePanelWidgets }: WidgetConfigurationProps) => {
  const dispatch = useAppDispatch();
  const selectedBuilderItem = useAppSelector((state) => state.map.selectedBuilderItem);
  const selectedBuilderItemRef = useRef(selectedBuilderItem);

  useEffect(() => {
    selectedBuilderItemRef.current = selectedBuilderItem;
  }, [selectedBuilderItem]);

  const existingFilter = useAppSelector((state) =>
    state.map.temporaryFilters.find((filter) => filter.id === selectedBuilderItem?.id)
  );

  const widgetConfig =
    selectedBuilderItem?.type === "widget" ? selectedBuilderItem.config : undefined;
  const schema = widgetConfig ? widgetSchemaMap[widgetConfig.type] : undefined;

  const handleConfigChange = useCallback(
    (config: never) => {
      const latestSelectedBuilderItem = selectedBuilderItemRef.current;
      if (!latestSelectedBuilderItem || latestSelectedBuilderItem.type !== "widget") {
        return;
      }

      if (existingFilter) {
        dispatch(removeTemporaryFilter(existingFilter.id));
      }

      onChange({
        ...latestSelectedBuilderItem,
        config,
      });
    },
    [dispatch, existingFilter, onChange]
  );

  // Handle full widget update (for tabs widget that needs to update tabWidgets)
  const handleWidgetChange = useCallback(
    (updatedWidget: BuilderWidgetSchema) => {
      if (existingFilter) {
        dispatch(removeTemporaryFilter(existingFilter.id));
      }
      onChange(updatedWidget);
    },
    [dispatch, existingFilter, onChange]
  );

  const hasDataConfig = useMemo(() => {
    if (!schema) return false;
    return hasNestedSchemaPath(schema, "setup.layer_project_id");
  }, [schema]);

  if (!widgetConfig || !schema) {
    return null;
  }

  // Special handling for links widget
  if (widgetConfig.type === "links") {
    return (
      <LinksConfiguration
        config={widgetConfig as LinksElementSchema}
        onChange={handleConfigChange}
      />
    );
  }

  // Special handling for rich_text widget
  if (widgetConfig.type === "rich_text") {
    return (
      <RichTextConfig
        config={widgetConfig as unknown as RichTextDataSchema}
        onChange={handleConfigChange}
      />
    );
  }

  // Special handling for tabs widget
  if (widgetConfig.type === "tabs") {
    return (
      <TabsWidgetConfig
        widget={selectedBuilderItem as BuilderWidgetSchema}
        config={widgetConfig as TabsContainerSchema}
        onChange={handleWidgetChange}
        samePanelWidgets={samePanelWidgets}
      />
    );
  }

  // Special handling for layers widget
  if (widgetConfig.type === "layers") {
    return (
      <LayersWidgetConfig
        config={widgetConfig as LayerInformationSchema}
        onChange={handleConfigChange}
      />
    );
  }

  return (
    <Stack direction="column" spacing={2} justifyContent="space-between">
      {/* key: remount per widget so the title/description editors never carry over text */}
      <WidgetInfo key={selectedBuilderItem?.id} config={widgetConfig} onChange={handleConfigChange} />
      {hasDataConfig && <WidgetData config={widgetConfig} onChange={handleConfigChange} />}
      <WidgetLayout config={widgetConfig} onChange={handleConfigChange} />
      <WidgetSetup config={widgetConfig} onChange={handleConfigChange} />
      <WidgetStyle config={widgetConfig} onChange={handleConfigChange} />
      <WidgetOptions config={widgetConfig} onChange={handleConfigChange} />
    </Stack>
  );
};

export default WidgetConfiguration;
