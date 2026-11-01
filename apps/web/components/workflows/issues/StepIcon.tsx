"use client";

import CallSplitIcon from "@mui/icons-material/CallSplit";
import SettingsIcon from "@mui/icons-material/Settings";
import React from "react";

import { TOOL_ICON_NAME, toolIconMap } from "@p4b/ui/assets/svg/ToolIcons";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { WorkflowNode } from "@/lib/validations/workflow";

const GEOMETRY_ICON: Record<string, ICON_NAME> = {
  point: ICON_NAME.POINT_FEATURE,
  line: ICON_NAME.LINE_FEATURE,
  polygon: ICON_NAME.POLYGON_FEATURE,
};

interface StepIconProps {
  /** The step, or undefined when it is no longer on the canvas. */
  node: WorkflowNode | undefined;
  size?: number;
}

/** A step's icon as its node on the canvas shows it (ToolNode, DatasetNode, ExportNode, IfNode). */
const StepIcon: React.FC<StepIconProps> = ({ node, size = 18 }) => {
  const sx = { fontSize: size };
  if (!node) return <SettingsIcon sx={sx} />;
  const { data } = node;
  switch (data.type) {
    case "tool": {
      const ToolIcon = toolIconMap[data.processId as TOOL_ICON_NAME];
      return ToolIcon ? <ToolIcon sx={sx} /> : <SettingsIcon sx={sx} />;
    }
    case "export": {
      const ExportIcon = toolIconMap[TOOL_ICON_NAME.EXPORT_DATASET];
      return <ExportIcon sx={sx} />;
    }
    case "if":
      return <CallSplitIcon sx={sx} />;
    case "dataset":
      return <Icon iconName={GEOMETRY_ICON[data.geometryType ?? ""] ?? ICON_NAME.TABLE} sx={sx} />;
    default:
      return <SettingsIcon sx={sx} />;
  }
};

export default StepIcon;
