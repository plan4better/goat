/**
 * How the Explorer shows its network arriving: one bar under the tabs for the
 * whole opening, and a card with its two steps — the server preparing the
 * snapshot, then the download into the browser — until the routes can be
 * listed; the timetables finish loading behind them.
 */
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Collapse,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type ExplorerFailure, retryable } from "@/lib/explorer/errors";

import { useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";

type StepState = "pending" | "active" | "done";

function StepMark({ state }: { state: StepState }) {
  const theme = useTheme();
  if (state === "done") {
    return (
      <Icon
        iconName={ICON_NAME.CIRCLECHECK}
        style={{ fontSize: 16 }}
        htmlColor={theme.palette.primary.main}
      />
    );
  }
  if (state === "active") return <CircularProgress size={14} thickness={5} />;
  return (
    <Box sx={{ width: 14, height: 14, borderRadius: "50%", border: 1.5, borderColor: "text.disabled" }} />
  );
}

function Step({ state, label, children }: { state: StepState; label: string; children?: ReactNode }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Box sx={{ width: 16, height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <StepMark state={state} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          fontWeight={state === "active" ? 600 : 400}
          color={state === "pending" ? "text.disabled" : "text.primary"}>
          {label}
        </Typography>
        {children}
      </Box>
    </Stack>
  );
}

/** The card's round emblem: the Explorer's icon, or a warning when it failed. */
function Emblem({ error }: { error?: boolean }) {
  const theme = useTheme();
  const color = error ? theme.palette.error.main : theme.palette.primary.main;
  return (
    <Box
      sx={{
        width: 44,
        flexShrink: 0,
        height: 44,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: alpha(color, 0.1),
      }}>
      <Icon
        iconName={error ? ICON_NAME.CIRCLEINFO : ICON_NAME.BUS}
        style={{ fontSize: 18 }}
        htmlColor={color}
      />
    </Box>
  );
}

function megabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(
    bytes / 1e6
  );
}

/** Why the network did not open, in a planner's words, and what to do; the
 * technical text folds away under Details for whoever needs to report it. */
function ExplorerErrorCard({ failure, onRetry }: { failure: ExplorerFailure; onRetry: () => void }) {
  const { t } = useTranslation("common");
  const bundleName = useAppSelector((s) => s.explorer.bundleName);
  const [showDetails, setShowDetails] = useState(false);
  return (
    <Box sx={{ px: 2.5, pt: 4, pb: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Emblem error />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body1" fontWeight="bold">
            {t(`explorer_error_${failure.kind}_title`)}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" noWrap>
            {bundleName}
          </Typography>
        </Box>
      </Stack>
      <Box sx={{ mt: 2.5, p: 2, borderRadius: 1.5, bgcolor: "action.hover" }}>
        <Typography variant="body2">{t(`explorer_error_${failure.kind}_hint`)}</Typography>
        <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 1.5 }}>
          {retryable(failure.kind) && (
            <Button
              size="small"
              variant="outlined"
              onClick={onRetry}
              startIcon={<Icon iconName={ICON_NAME.REFRESH} style={{ fontSize: 12 }} />}>
              {t("explorer_retry")}
            </Button>
          )}
          {/* A link, not a second button: the technical text is for reporting. */}
          <ButtonBase
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            sx={{ gap: 0.75, px: 0.5, borderRadius: 1, color: "text.secondary" }}>
            <Typography variant="caption">{t("explorer_error_details")}</Typography>
            <Icon
              iconName={showDetails ? ICON_NAME.CHEVRON_UP : ICON_NAME.CHEVRON_DOWN}
              style={{ fontSize: 10 }}
            />
          </ButtonBase>
        </Stack>
        <Collapse in={showDetails}>
          <Typography
            variant="caption"
            component="pre"
            color="text.secondary"
            sx={{
              mt: 1.5,
              mb: 0,
              p: 1,
              borderRadius: 1,
              bgcolor: "background.paper",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>
            {failure.detail}
          </Typography>
        </Collapse>
      </Box>
    </Box>
  );
}

/** Shown in place of the tab until the network can be listed, or when it failed. */
export function ExplorerLoadingCard() {
  const { t, i18n } = useTranslation("common");
  const { state, retry } = useExplorer();
  const bundleName = useAppSelector((s) => s.explorer.bundleName);

  if (state.status === "error") return <ExplorerErrorCard failure={state.error} onRetry={retry} />;

  const preparing = state.status === "preparing";
  const progress = state.status === "loading" ? state.progress : undefined;
  const percent = progress?.total ? (100 * progress.received) / progress.total : 0;

  return (
    <Box sx={{ px: 2.5, pt: 4, pb: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Emblem />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body1" fontWeight="bold" noWrap>
            {t("explorer_opening")}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" noWrap>
            {bundleName}
          </Typography>
        </Box>
        {progress && (
          <Typography
            color="primary"
            fontWeight="bold"
            sx={{ fontSize: 20, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {Math.floor(percent)} %
          </Typography>
        )}
      </Stack>
      <Stack spacing={1.75} sx={{ mt: 2.5, p: 2, borderRadius: 1.5, bgcolor: "action.hover" }}>
        <Step state={preparing ? "active" : "done"} label={t("explorer_step_prepare")}>
          {preparing && state.building && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
              {t("explorer_step_prepare_building")}
            </Typography>
          )}
        </Step>
        <Step state={preparing ? "pending" : "active"} label={t("explorer_step_download")}>
          {progress && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
              {t("explorer_step_download_of", {
                received: megabytes(progress.received, i18n.language),
                total: megabytes(progress.total, i18n.language),
              })}
            </Typography>
          )}
        </Step>
      </Stack>
    </Box>
  );
}

/** The whole opening in one bar, flush under the tabs: moving while the
 * data is prepared, which has no measure, then filling as it loads — through
 * the card and on behind the listed routes until the timetables are in. Laid
 * over the content, so nothing moves when it goes. */
export function ExplorerLoadingLine() {
  const { t } = useTranslation("common");
  const { state, complete, progress } = useExplorer();
  if (complete || state.status === "error") return null;
  return (
    <LinearProgress
      variant={progress === null ? "indeterminate" : "determinate"}
      value={100 * (progress ?? 0)}
      aria-label={t("explorer_opening")}
      sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, zIndex: 1 }}
    />
  );
}

/** "Loading timetables · 63 %": what a figure waiting on the stop times says. */
export function useTimetablesPending(): string | null {
  const { t } = useTranslation("common");
  const { complete, progress } = useExplorer();
  if (complete) return null;
  return t("explorer_loading_timetables", { percent: Math.round(100 * (progress ?? 0)) });
}
