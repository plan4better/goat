import { Box, Button, CircularProgress, IconButton, Tooltip, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { setMode } from "@/lib/store/featureEditor/slice";
import type { FeatureEditMode } from "@/lib/store/featureEditor/types";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";
import { DATA_PANEL_HEIGHT_CONSUMER_ATTR, DATA_PANEL_HEIGHT_VAR } from "@/components/map/panels/DataPanel";

// --- Styled components matching workflow CanvasToolbar style ---

const ToolbarContainer = styled(Box)(({ theme }) => ({
  position: "absolute",
  // Clear of the edit-mode halo, which is brightest against the viewport edge.
  bottom: `calc(var(${DATA_PANEL_HEIGHT_VAR}, 0px) + ${theme.spacing(8)})`,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(1.5),
  zIndex: 10,
}));

const ToolGroup = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.spacing(0.5),
  padding: theme.spacing(0.5),
  backgroundColor: theme.palette.background.paper,
  borderRadius: 28,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
  border: `1px solid ${theme.palette.divider}`,
}));

const ToolButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== "active",
})<{ active?: boolean }>(({ theme, active }) => ({
  width: 40,
  height: 40,
  backgroundColor: active ? theme.palette.primary.main : "transparent",
  color: active ? theme.palette.primary.contrastText : theme.palette.text.primary,
  "&:hover": {
    backgroundColor: active ? theme.palette.primary.dark : theme.palette.action.hover,
  },
  "&.Mui-disabled": {
    color: theme.palette.text.disabled,
  },
}));

const ToolDivider = styled(Box)(({ theme }) => ({
  width: 1,
  height: 24,
  backgroundColor: theme.palette.divider,
  margin: theme.spacing(0, 0.5),
}));

const ActionButton = styled(Button)(({ theme }) => ({
  height: 40,
  paddingLeft: theme.spacing(2),
  paddingRight: theme.spacing(2.5),
  borderRadius: 20,
  fontWeight: 600,
  textTransform: "none" as const,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  "& .MuiButton-startIcon": {
    marginRight: theme.spacing(0.5),
  },
  "&.Mui-disabled": {
    backgroundColor: theme.palette.action.disabledBackground,
    color: theme.palette.text.disabled,
  },
}));

// --- Component ---

interface FeatureEditToolbarProps {
  onSave: () => void;
  onDiscard: () => void;
  onStopEditing: () => void;
  onUndo: () => void;
  onRedo: () => void;
  hasUndo: boolean;
  hasRedo: boolean;
}

const FeatureEditToolbar: React.FC<FeatureEditToolbarProps> = ({
  onSave,
  onDiscard,
  onStopEditing,
  onUndo,
  onRedo,
  hasUndo,
  hasRedo,
}) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { activeLayerId, geometryType, mode, pendingFeatures, isSaving } = useAppSelector(
    (state) => state.featureEditor
  );

  if (!activeLayerId) return null;

  const isTableLayer = !geometryType;
  const pendingCount = Object.values(pendingFeatures).filter((f) => f.committed).length;

  const handleModeChange = (newMode: FeatureEditMode) => {
    dispatch(setMode(newMode));
  };

  return (
    <ToolbarContainer {...{ [DATA_PANEL_HEIGHT_CONSUMER_ATTR]: "" }}>
      {/* Draw tools — hidden for table layers */}
      <ToolGroup>
        {!isTableLayer ? (
          <>
            <Tooltip title={t("select_mode")} placement="top">
              <ToolButton active={mode === "select"} onClick={() => handleModeChange("select")}>
                <Icon iconName={ICON_NAME.ARROW_POINTER} style={{ fontSize: 18 }} />
              </ToolButton>
            </Tooltip>

            <Tooltip title={t("add_feature")} placement="top">
              <ToolButton active={mode === "draw"} onClick={() => handleModeChange("draw")}>
                <Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 18 }} />
              </ToolButton>
            </Tooltip>

            <ToolDivider />
          </>
        ) : (
          <>
            <Tooltip title={t("add_row", { defaultValue: "Add row" })} placement="top">
              <ToolButton active={mode === "draw"} onClick={() => handleModeChange("draw")}>
                <Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 18 }} />
              </ToolButton>
            </Tooltip>

            <ToolDivider />
          </>
        )}

        {/* Undo/Redo */}
        <Tooltip title={t("undo")} placement="top">
          <span>
            <ToolButton disabled={!hasUndo} onClick={onUndo}>
              <Icon iconName={ICON_NAME.UNDO} style={{ fontSize: 16 }} />
            </ToolButton>
          </span>
        </Tooltip>

        <Tooltip title={t("redo")} placement="top">
          <span>
            <ToolButton disabled={!hasRedo} onClick={onRedo}>
              <Icon iconName={ICON_NAME.REDO} style={{ fontSize: 16 }} />
            </ToolButton>
          </span>
        </Tooltip>

        <ToolDivider />

        {/* Pending count */}
        {pendingCount > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }} noWrap>
            {t("pending_features_count", { count: pendingCount })}
          </Typography>
        )}

        {/* Stop editing */}
        <Tooltip title={t("stop_editing")} placement="top">
          <ToolButton onClick={onStopEditing}>
            <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 16 }} />
          </ToolButton>
        </Tooltip>
      </ToolGroup>

      {/* Save / Discard actions */}
      <ActionButton
        variant="contained"
        color="primary"
        disableElevation
        disabled={pendingCount === 0 || isSaving}
        startIcon={isSaving ? <CircularProgress size={14} /> : undefined}
        onClick={onSave}>
        {t("save_edits")}
      </ActionButton>

      {pendingCount > 0 && (
        <ActionButton
          variant="contained"
          color="error"
          disableElevation
          disabled={isSaving}
          onClick={onDiscard}>
          {t("discard_edits")}
        </ActionButton>
      )}
    </ToolbarContainer>
  );
};

export default FeatureEditToolbar;
