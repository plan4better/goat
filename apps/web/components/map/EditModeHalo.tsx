import { Box, alpha, useTheme } from "@mui/material";

import { useAppSelector } from "@/hooks/store/ContextHooks";

/**
 * A glow around the map while a layer is being edited.
 *
 * Edit mode changes what a click does, and the panel saying so is easy to lose
 * track of. Static rather than pulsing: an editing session is long, and motion
 * at the edge of vision competes with the map instead of informing.
 */
const EditModeHalo = () => {
  const theme = useTheme();
  const activeLayerId = useAppSelector((state) => state.featureEditor.activeLayerId);

  if (!activeLayerId) return null;

  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        pointerEvents: "none",
        // Widening blurs at decaying opacity, with no spread on any of them:
        // spread paints a solid band before the blur begins, which is what
        // makes a stacked glow look stepped. A hairline rule keeps the edge
        // defined so the whole thing reads as deliberate rather than as a
        // smudge.
        boxShadow: [
          `inset 0 0 0 1px ${alpha(theme.palette.primary.main, 0.6)}`,
          `inset 0 0 10px ${alpha(theme.palette.primary.main, 0.55)}`,
          `inset 0 0 28px ${alpha(theme.palette.primary.main, 0.42)}`,
          `inset 0 0 60px ${alpha(theme.palette.primary.main, 0.3)}`,
          `inset 0 0 120px ${alpha(theme.palette.primary.main, 0.16)}`,
        ].join(", "),
      }}
    />
  );
};

export default EditModeHalo;
