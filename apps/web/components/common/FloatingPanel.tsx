import { Stack, type SxProps, type Theme, useTheme } from "@mui/material";
import { alpha } from "@mui/material";

import { MAP_PANEL_ATTR } from "@/lib/constants";

interface FloatingPanelProps {
  children: React.ReactNode;
  sx?: SxProps<Theme>;
  width?: number;
  minHeight?: string | number;
  maxHeight?: string;
  /** When true, panel fills available height enabling internal scrolling */
  fillHeight?: boolean;
}

export const FloatingPanel = ({
  children,
  sx,
  width = 300,
  // Clamped to the available height: a bare 400px floor wins over maxHeight and
  // overflows the clipping parent, cutting off whatever sits at the panel bottom.
  minHeight = "min(400px, 100%)",
  maxHeight = "auto",
  fillHeight = false,
}: FloatingPanelProps) => {
  const theme = useTheme();
  return (
    <Stack
      // Zoom to layer keeps a layer clear of the panels over the map.
      {...{ [MAP_PANEL_ATTR]: "" }}
      direction="column"
      sx={[
        {
          direction: "ltr",
          width: `${width}px`,
          minHeight: typeof minHeight === "number" ? `${minHeight}px` : minHeight,
          maxHeight,
          height: fillHeight ? "100%" : "auto",
          borderRadius: "1rem",
          backgroundColor: alpha(theme.palette.background.paper, 0.9),
          boxShadow: `rgba(0, 0, 0, 0.2) 0px 0px 10px`,
          backdropFilter: "blur(10px)",
          pointerEvents: "all",
          overflow: "hidden",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}>
      {children}
    </Stack>
  );
};
