"use client";

/**
 * Shared styled components for workflow canvas nodes.
 * Used by ToolNode, ExportNode, and other node types to ensure
 * consistent visual appearance across the workflow canvas.
 */
import { Box, GlobalStyles, IconButton, Stack } from "@mui/material";
import { keyframes, lighten, styled } from "@mui/material/styles";
import { Handle } from "@xyflow/react";

// Keyframe animation for border angle (animates CSS custom property)
export const borderAngleRunning = keyframes`
  from {
    --border-angle: 0deg;
  }
  to {
    --border-angle: 360deg;
  }
`;

// Global styles to register @property for --border-angle
export const BorderAnglePropertyStyles = () => (
  <GlobalStyles
    styles={`
      @property --border-angle {
        syntax: "<angle>";
        inherits: true;
        initial-value: 0deg;
      }
    `}
  />
);

// Global styles for animated edge - keyframes don't work in inline styles
export const AnimatedEdgeStyles = () => (
  <GlobalStyles
    styles={{
      "@keyframes dashFlow": {
        "0%": { strokeDashoffset: 24 },
        "100%": { strokeDashoffset: 0 },
      },
      ".react-flow__edge-path.animated-running": {
        animation: "dashFlow 0.5s linear infinite",
      },
    }}
  />
);

export const NodeContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "selected",
})<{ selected?: boolean }>(({ theme, selected }) => ({
  padding: theme.spacing(1.5),
  borderRadius: theme.shape.borderRadius,
  backgroundColor: theme.palette.background.paper,
  border: `2px solid ${selected ? theme.palette.primary.main : theme.palette.divider}`,
  boxShadow: selected
    ? `0 0 0 4px ${theme.palette.primary.main}40, 0 2px 8px rgba(0, 0, 0, 0.1)`
    : "0 2px 8px rgba(0, 0, 0, 0.08)",
  minWidth: 220,
  maxWidth: 360,
  transition: "all 0.2s ease",
  position: "relative",
  "&:hover": {
    boxShadow: selected
      ? `0 0 0 4px ${theme.palette.primary.main}40, 0 2px 8px rgba(0, 0, 0, 0.12)`
      : "0 2px 8px rgba(0, 0, 0, 0.12)",
  },
}));

export const NodeHeader = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(1),
}));

// Icon wrapper with status-based styling
export const NodeIconWrapper = styled(Box, {
  shouldForwardProp: (prop) => prop !== "status",
})<{ status?: "pending" | "running" | "completed" | "failed" | "skipped" }>(({ theme, status }) => {
  const isDark = theme.palette.mode === "dark";
  
  // Default colors (adapt to theme)
  let color1 = isDark ? "#FAFAFA" : "#666666";
  let color2 = "#999999";
  let color3 = "#BDBDBD";
  let color4 = "#E3E3E3";
  let color5 = isDark ? "#666666" : "#FAFAFA";

  // Success state colors (solid tints to avoid alpha compounding with fillOpacity in SVGs)
  if (status === "completed") {
    color1 = theme.palette.primary.main;
    color2 = lighten(theme.palette.primary.main, 0.4);
    color3 = lighten(theme.palette.primary.main, 0.6);
    color4 = lighten(theme.palette.primary.main, 0.88);
    color5 = lighten(theme.palette.primary.main, 0.92);
  } else if (status === "failed") {
    color1 = theme.palette.error.main;
    color2 = lighten(theme.palette.error.main, 0.4);
    color3 = lighten(theme.palette.error.main, 0.6);
    color4 = lighten(theme.palette.error.main, 0.88);
    color5 = lighten(theme.palette.error.main, 0.92);
  }

  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    minWidth: 40,
    borderRadius: theme.shape.borderRadius,
    position: "relative",
    "--icon-color-1": color1,
    "--icon-color-2": color2,
    "--icon-color-3": color3,
    "--icon-color-4": color4,
    "--icon-color-5": color5,
    // Animated conic-gradient border when running
    ...(status === "running" &&
      ({
        "--border-angle": "0deg",
        background: `linear-gradient(${theme.palette.background.paper}, ${theme.palette.background.paper}) padding-box, conic-gradient(from var(--border-angle), ${theme.palette.warning.main} 50%, ${theme.palette.divider} 50%) border-box`,
        borderColor: "transparent",
        borderStyle: "solid",
        borderWidth: "2px",
        animation: `${borderAngleRunning} 2s linear infinite`,
      } as const)),
    // Static styles for other states
    ...(status !== "running" && {
      border: `1px solid ${
        status === "completed"
          ? theme.palette.primary.main
          : status === "failed"
            ? theme.palette.error.main
            : theme.palette.divider
      }`,
      backgroundColor: "transparent",
    }),
  };
});

// Small badge on icon corner (completed checkmark, failed cross, or skipped block)
export const IconStatusBadge = styled(Box, {
  shouldForwardProp: (prop) => prop !== "status",
})<{ status?: "completed" | "failed" | "skipped" }>(({ theme, status }) => ({
  position: "absolute",
  top: -6,
  right: -6,
  width: 18,
  height: 18,
  borderRadius: "50%",
  backgroundColor:
    status === "failed"
      ? theme.palette.error.main
      : status === "skipped"
        ? theme.palette.grey[500]
        : theme.palette.primary.main,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: theme.palette.common.white,
  zIndex: 2,
  border: `2px solid ${theme.palette.background.paper}`,
}));

// Animated border wrapper for running state
export const AnimatedBorderWrapper = styled(Box, {
  shouldForwardProp: (prop) => prop !== "isRunning",
})<{ isRunning?: boolean }>(({ theme: _theme, isRunning: _isRunning }) => ({
  position: "relative",
  width: 40,
  height: 40,
  minWidth: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
}));

export const StyledHandle = styled(Handle, {
  shouldForwardProp: (prop) => prop !== "selected",
})<{ selected?: boolean }>(({ theme, selected }) => ({
  width: 12,
  height: 12,
  backgroundColor: selected ? theme.palette.primary.main : theme.palette.grey[500],
  border: `2px solid ${theme.palette.background.paper}`,
  // An input the workflow check found unconnected. The node sets the
  // attribute; React Flow's Handle passes it on to its element.
  '&[data-issue="true"]': {
    boxShadow: `0 0 0 2px ${theme.palette.warning.main}`,
  },
}));

// Tinted background section for parameters below the header
export const NodeParamsSection = styled(Box)(({ theme }) => ({
  backgroundColor: theme.palette.mode === "dark"
    ? "rgba(255, 255, 255, 0.03)"
    : "rgba(0, 0, 0, 0.025)",
  margin: theme.spacing(1.5, -1.5, -1.5, -1.5),
  padding: theme.spacing(1, 1.5, 1.5, 1.5),
  borderTop: `1px solid ${theme.palette.divider}`,
  borderRadius: `0 0 ${theme.shape.borderRadius - 1}px ${theme.shape.borderRadius - 1}px`,
}));

export const ToolbarContainer = styled(Stack)(({ theme }) => ({
  backgroundColor: theme.palette.background.paper,
  borderRadius: theme.shape.borderRadius * 2,
  padding: theme.spacing(1),
  gap: theme.spacing(0.5),
  flexDirection: "row",
  alignItems: "center",
  boxShadow: theme.shadows[4],
  border: `1px solid ${theme.palette.divider}`,
}));

export const ToolbarButton = styled(IconButton)(({ theme }) => ({
  width: 36,
  height: 36,
  "&:hover": {
    backgroundColor: theme.palette.action.hover,
  },
}));
