import ChevronRight from "@mui/icons-material/ChevronRight";
import Close from "@mui/icons-material/Close";
import { Badge, Box, Button, Divider, IconButton, Stack, Typography } from "@mui/material";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { InteractionRule } from "@/lib/validations/interaction";
import type { BuilderPanelSchema, ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import type { TabsContainerSchema } from "@/lib/validations/widget";

import type { SelectorItem } from "@/types/map/common";

import CollapsibleConfigCard from "@/components/builder/widgets/common/CollapsibleConfigCard";
import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import Selector from "@/components/map/panels/common/Selector";
import SwitchRow from "@/components/map/panels/common/SwitchRow";

// ---------------------------------------------------------------------------
// Helper: find all tabs widgets across all panels
// ---------------------------------------------------------------------------

interface TabsWidgetInfo {
  widgetId: string;
  title: string;
  tabs: { id: string; name: string }[];
}

function findTabsWidgets(panels: BuilderPanelSchema[]): TabsWidgetInfo[] {
  const result: TabsWidgetInfo[] = [];
  for (const panel of panels) {
    for (const widget of panel.widgets ?? []) {
      if (widget.config?.type === "tabs") {
        const tabsConfig = widget.config as TabsContainerSchema;
        result.push({
          widgetId: widget.id,
          title: tabsConfig.setup?.title || widget.id,
          tabs: tabsConfig.tabs ?? [],
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: get summary string for collapsed card
// ---------------------------------------------------------------------------

function getRuleSummary(
  rule: InteractionRule,
  tabsWidgets: TabsWidgetInfo[],
  t: (key: string) => string
): string {
  if (rule.trigger.type === "group_activated") {
    const count = rule.mapping.length;
    const widget = tabsWidgets.find((w) => w.widgetId === rule.action.targetWidgetId);
    const widgetTitle = widget?.title ?? "";
    return `${count} ${t("mappings")}${widgetTitle ? ` → ${widgetTitle}` : ""}`;
  }
  return `${rule.mapping.length} ${t("target_layers").toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// GroupToTabRuleForm
// ---------------------------------------------------------------------------

interface GroupToTabRuleFormProps {
  rule: InteractionRule;
  tabsWidgets: TabsWidgetInfo[];
  projectLayerGroups: ProjectLayerGroup[];
  onChange: (updated: InteractionRule) => void;
}

const GroupToTabRuleForm: React.FC<GroupToTabRuleFormProps> = ({
  rule,
  tabsWidgets,
  projectLayerGroups,
  onChange,
}) => {
  const { t } = useTranslation("common");

  const widgetItems: SelectorItem[] = tabsWidgets.map((w) => ({
    value: w.widgetId,
    label: `${t("tabs")} — ${w.title}`,
  }));

  const selectedWidget = widgetItems.find((w) => w.value === rule.action.targetWidgetId);

  const selectedTabsWidget = tabsWidgets.find((w) => w.widgetId === rule.action.targetWidgetId);
  const tabItems: SelectorItem[] = (selectedTabsWidget?.tabs ?? []).map((tab) => ({
    value: tab.id,
    label: tab.name,
  }));

  const groupItems: SelectorItem[] = projectLayerGroups.map((g) => ({
    value: g.id,
    label: g.name,
  }));

  const handleWidgetChange = (item: SelectorItem[] | SelectorItem | undefined) => {
    const widgetId = !Array.isArray(item) && item ? String(item.value) : undefined;
    onChange({
      ...rule,
      action: { ...rule.action, targetWidgetId: widgetId, tabId: undefined },
    });
  };

  const handleAddMapping = () => {
    onChange({
      ...rule,
      mapping: [...rule.mapping, { sourceId: 0, actionParams: {} }],
    });
  };

  const handleRemoveMapping = (index: number) => {
    const next = rule.mapping.filter((_, i) => i !== index);
    onChange({ ...rule, mapping: next });
  };

  const handleGroupChange = (index: number, item: SelectorItem[] | SelectorItem | undefined) => {
    const groupId = !Array.isArray(item) && item ? Number(item.value) : 0;
    const next = rule.mapping.map((m, i) => (i === index ? { ...m, sourceId: groupId } : m));
    onChange({ ...rule, mapping: next });
  };

  const handleTabChange = (index: number, item: SelectorItem[] | SelectorItem | undefined) => {
    const tabId = !Array.isArray(item) && item ? String(item.value) : "";
    const next = rule.mapping.map((m, i) => (i === index ? { ...m, actionParams: { tabId } } : m));
    onChange({ ...rule, mapping: next });
  };

  return (
    <Stack spacing={2}>
      <Selector
        label={`${t("target_widget")} (${t("tabs")})`}
        placeholder={t("select")}
        items={widgetItems}
        selectedItems={selectedWidget}
        setSelectedItems={handleWidgetChange}
      />

      {rule.action.targetWidgetId && (
        <>
          {/* Mapping header */}
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight="bold">
                {t("layer_group")}
              </Typography>
            </Box>
            <Box sx={{ width: 24 }} />
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight="bold">
                {t("tab")}
              </Typography>
            </Box>
            <Box sx={{ width: 28 }} />
          </Stack>

          {/* Mapping rows */}
          {rule.mapping.map((mapping, index) => {
            const selectedGroup = groupItems.find((g) => g.value === mapping.sourceId) ?? undefined;
            const currentTabId = mapping.actionParams?.tabId;
            const selectedTab = tabItems.find((tab) => tab.value === currentTabId) ?? undefined;

            return (
              <Stack key={index} direction="row" alignItems="center" spacing={1}>
                <Box sx={{ flex: 1 }}>
                  <Selector
                    placeholder={t("select")}
                    items={groupItems}
                    selectedItems={selectedGroup}
                    setSelectedItems={(item) => handleGroupChange(index, item)}
                  />
                </Box>
                <Typography color="text.disabled" sx={{ width: 24, textAlign: "center" }}>
                  →
                </Typography>
                <Box sx={{ flex: 1 }}>
                  <Selector
                    placeholder={t("select")}
                    items={tabItems}
                    selectedItems={selectedTab}
                    setSelectedItems={(item) => handleTabChange(index, item)}
                  />
                </Box>
                <IconButton size="small" onClick={() => handleRemoveMapping(index)} sx={{ width: 28 }}>
                  <Close fontSize="small" />
                </IconButton>
              </Stack>
            );
          })}

          <Button
            size="small"
            variant="text"
            onClick={handleAddMapping}
            sx={{ alignSelf: "flex-start", textTransform: "none" }}>
            + {t("add_mapping")}
          </Button>
        </>
      )}
    </Stack>
  );
};

// ---------------------------------------------------------------------------
// VisibilitySyncRuleForm
// ---------------------------------------------------------------------------

interface VisibilitySyncRuleFormProps {
  rule: InteractionRule;
  projectLayers: ProjectLayer[];
  onChange: (updated: InteractionRule) => void;
}

const VisibilitySyncRuleForm: React.FC<VisibilitySyncRuleFormProps> = ({ rule, projectLayers, onChange }) => {
  const { t } = useTranslation("common");

  const allLayerItems: SelectorItem[] = projectLayers
    .filter((l) => l.type !== "table")
    .map((l) => ({
      value: l.id,
      label: l.name,
    }));

  const sourceLayerId = rule.trigger.sourceId;
  const selectedSource = allLayerItems.find((l) => l.value === sourceLayerId) ?? undefined;

  const targetLayerItems = allLayerItems.filter((l) => l.value !== sourceLayerId);

  const handleSourceChange = (item: SelectorItem[] | SelectorItem | undefined) => {
    const layerId = !Array.isArray(item) && item ? Number(item.value) : undefined;
    onChange({
      ...rule,
      trigger: { ...rule.trigger, sourceId: layerId },
      mapping: [],
    });
  };

  const handleAddTarget = () => {
    onChange({
      ...rule,
      mapping: [...rule.mapping, { sourceId: 0, actionParams: {} }],
    });
  };

  const handleRemoveTarget = (index: number) => {
    const next = rule.mapping.filter((_, i) => i !== index);
    onChange({ ...rule, mapping: next });
  };

  const handleTargetChange = (index: number, item: SelectorItem[] | SelectorItem | undefined) => {
    const layerId = !Array.isArray(item) && item ? Number(item.value) : 0;
    const next = rule.mapping.map((m, i) => (i === index ? { ...m, sourceId: layerId } : m));
    onChange({ ...rule, mapping: next });
  };

  return (
    <Stack spacing={2}>
      <Selector
        label={t("source_layer")}
        placeholder={t("select")}
        items={allLayerItems}
        selectedItems={selectedSource}
        setSelectedItems={handleSourceChange}
      />

      {sourceLayerId && (
        <>
          {/* Target header */}
          <Typography variant="caption" color="text.secondary" fontWeight="bold">
            {t("target_layers")}
          </Typography>

          {/* Target rows */}
          {rule.mapping.map((mapping, index) => {
            const selectedTarget = targetLayerItems.find((l) => l.value === mapping.sourceId) ?? undefined;

            return (
              <Stack key={index} direction="row" alignItems="center" spacing={1}>
                <Box sx={{ flex: 1 }}>
                  <Selector
                    placeholder={t("select")}
                    items={targetLayerItems}
                    selectedItems={selectedTarget}
                    setSelectedItems={(item) => handleTargetChange(index, item)}
                  />
                </Box>
                <IconButton size="small" onClick={() => handleRemoveTarget(index)}>
                  <Close fontSize="small" />
                </IconButton>
              </Stack>
            );
          })}

          <Button
            size="small"
            variant="text"
            onClick={handleAddTarget}
            sx={{ alignSelf: "flex-start", textTransform: "none" }}>
            + {t("add_target_layer")}
          </Button>
        </>
      )}
    </Stack>
  );
};

// ---------------------------------------------------------------------------
// InteractionsModal
// ---------------------------------------------------------------------------

interface InteractionsModalProps {
  open: boolean;
  onClose: () => void;
  interactions: InteractionRule[];
  onChange: (interactions: InteractionRule[]) => void;
  panels: BuilderPanelSchema[];
  projectLayers: ProjectLayer[];
  projectLayerGroups: ProjectLayerGroup[];
}

const triggerTypeOptions = (t: (key: string) => string): SelectorItem[] => [
  { value: "group_activated", label: t("group_activated") },
  { value: "visibility_changed", label: t("visibility_changed") },
];

const InteractionsModal: React.FC<InteractionsModalProps> = ({
  open,
  onClose,
  interactions,
  onChange,
  panels,
  projectLayers,
  projectLayerGroups,
}) => {
  const { t } = useTranslation("common");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const tabsWidgets = findTabsWidgets(panels);

  const handleToggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const handleRemove = (id: string) => {
    onChange(interactions.filter((r) => r.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const handleRuleChange = (updated: InteractionRule) => {
    onChange(interactions.map((r) => (r.id === updated.id ? updated : r)));
  };

  const handleAddInteraction = () => {
    const newRule: InteractionRule = {
      id: v4(),
      name: "",
      enabled: true,
      trigger: { type: "group_activated" },
      action: { type: "switch_tab" },
      mapping: [],
    };
    onChange([...interactions, newRule]);
    setExpandedId(newRule.id);
  };

  const handleTriggerTypeChange = (
    rule: InteractionRule,
    item: SelectorItem[] | SelectorItem | undefined
  ) => {
    const value = !Array.isArray(item) && item ? String(item.value) : "group_activated";
    const triggerType = value as InteractionRule["trigger"]["type"];
    const actionType: InteractionRule["action"]["type"] =
      triggerType === "group_activated" ? "switch_tab" : "sync_visibility";
    handleRuleChange({
      ...rule,
      trigger: { type: triggerType },
      action: { type: actionType },
      mapping: [],
    });
  };

  const triggerItems = triggerTypeOptions(t);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      icon={ICON_NAME.LINK}
      title={t("interactions")}
      maxWidth={600}
      footer={<AppDialogFooter primaryLabel={t("add_interaction")} onPrimary={handleAddInteraction} />}>
      {interactions.length === 0 ? (
        <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ py: 6 }}>
          <Icon iconName={ICON_NAME.LINK} fontSize="large" htmlColor="action" />
          <Typography variant="body1" fontWeight="bold">
            {t("no_interactions_yet")}
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ maxWidth: 320 }}>
            {t("no_interactions_description")}
          </Typography>
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          {interactions.map((rule) => {
            const isExpanded = expandedId === rule.id;
            const selectedTrigger = triggerItems.find((item) => item.value === rule.trigger.type);
            const summary = getRuleSummary(rule, tabsWidgets, t);

            return (
              <CollapsibleConfigCard
                key={rule.id}
                title={selectedTrigger?.label ?? rule.trigger.type}
                summary={summary}
                expanded={isExpanded}
                onToggle={() => handleToggle(rule.id)}
                onRemove={() => handleRemove(rule.id)}
                canRemove>
                <Stack spacing={2}>
                  {/* Enable / disable switch */}
                  <SwitchRow
                    label={t("interaction_enabled")}
                    checked={rule.enabled}
                    onChange={(checked) => handleRuleChange({ ...rule, enabled: checked })}
                  />

                  <Divider />

                  {/* Trigger type selector */}
                  <Selector
                    label={t("when")}
                    items={triggerItems}
                    selectedItems={selectedTrigger}
                    setSelectedItems={(item) => handleTriggerTypeChange(rule, item)}
                  />

                  {/* Conditional form */}
                  {rule.trigger.type === "group_activated" ? (
                    <GroupToTabRuleForm
                      rule={rule}
                      tabsWidgets={tabsWidgets}
                      projectLayerGroups={projectLayerGroups}
                      onChange={handleRuleChange}
                    />
                  ) : (
                    <VisibilitySyncRuleForm
                      rule={rule}
                      projectLayers={projectLayers}
                      onChange={handleRuleChange}
                    />
                  )}
                </Stack>
              </CollapsibleConfigCard>
            );
          })}
        </Stack>
      )}
    </AppDialog>
  );
};

export default InteractionsModal;

// ---------------------------------------------------------------------------
// InteractionsEntryButton
// ---------------------------------------------------------------------------

interface InteractionsEntryButtonProps {
  interactionCount: number;
  onClick: () => void;
}

export const InteractionsEntryButton: React.FC<InteractionsEntryButtonProps> = ({
  interactionCount,
  onClick,
}) => {
  const { t } = useTranslation("common");

  return (
    <Box
      onClick={onClick}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderRadius: 1,
        border: "1px solid",
        borderColor: "divider",
        "&:hover": { backgroundColor: "action.hover" },
      }}>
      <Icon iconName={ICON_NAME.LINK} fontSize="small" />

      <Box sx={{ flex: 1 }}>
        <Typography variant="body2" fontWeight="bold">
          {t("manage_interactions")}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("link_layers_and_widgets")}
        </Typography>
      </Box>

      <Badge badgeContent={interactionCount} color="primary" showZero={false}>
        <ChevronRight fontSize="small" />
      </Badge>
    </Box>
  );
};
