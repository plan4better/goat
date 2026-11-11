"use client";

import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Dialog,
  FormControlLabel,
  Skeleton,
  Stack,
  Typography,
  alpha,
  darken,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { previewTransfer, refreshContentFeed, transferContent } from "@/lib/api/content";
import type { ContentItem, Space, TransferPreview, TransferResult } from "@/lib/validations/content";
import { spaceIconFor } from "@/lib/utils/content";

import {
  ContentDialogHeader,
  DialogGroupLabel,
  contentDialogPaperSx,
  warningFill,
  warningInk,
} from "@/components/modals/content/ContentDialogChrome";

interface TransferDialogProps {
  items: ContentItem[];
  spaces: Space[];
  /** Preselects the "To" target — set when the dialog was opened by
   * dropping items on a space in the panel. Left unset when opened from
   * the Share dialog's Teams tab, where the first team space is picked. */
  presetTargetId?: string;
  onClose: () => void;
  /** Called once `transferContent` has actually succeeded, before
   * `onClose` — the page uses it to clear the selection, the way
   * `MoveDialog`'s `onMoved` does. The caller does not navigate on this
   * callback: the user stays in the space they were browsing. */
  onTransferred: (result: TransferResult, target: Space) => void;
}

/** A target space's display name — an organization always reads as
 * "Organization" (never its own literal name), matching the "To" grid and
 * `ShareDialog`'s `lives_in_space` convention for the org kind. */
const targetLabel = (space: Space, t: (key: string) => string): string =>
  space.kind === "organization" ? t("organization") : space.name;

/**
 * The promote-only transfer-ownership dialog (spec D3): pick a team or
 * organization space to hand 1..n personally-owned items to, preview the
 * consequences (access change, dropped personal shares, datasets used
 * elsewhere, trashed subtree, name collisions), choose which owned
 * datasets go along, and submit. Reached from the Share dialog's Teams tab
 * ("Transfer ownership") and from dragging items onto another space in the
 * spaces panel.
 */
const TransferDialog = ({ items, spaces, presetTargetId, onClose, onTransferred }: TransferDialogProps) => {
  const { t } = useTranslation("common");
  // Named by its title, as every AppDialog is.
  const titleId = useId();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("md"));

  const personalSpace = spaces.find((s) => s.kind === "personal");
  // D3: every item must be owned and live in the caller's own personal
  // space — the page and the Share dialog both gate on this before opening
  // the dialog; this is the dialog's own guard against a stale/forced open.
  const eligible =
    items.length > 0 &&
    !!personalSpace &&
    items.every((item) => item.my_role === "owner" && item.space_id === personalSpace.id);

  const targetSpaces = spaces.filter((s) => s.kind !== "personal");
  const teamSpaces = targetSpaces.filter((s) => s.kind === "team");

  const [targetId, setTargetId] = useState<string | undefined>(
    presetTargetId ?? teamSpaces[0]?.id ?? targetSpaces[0]?.id
  );
  const [preview, setPreview] = useState<TransferPreview | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(false);
  // The raw rejection message, when it has one; `""` means the rejection
  // carried no usable message, so the render falls back to a translated
  // generic one — kept separate from `submitError` since a failed preview
  // and a failed submit are shown at different points in the dialog.
  const [previewErrorMessage, setPreviewErrorMessage] = useState<string | undefined>(undefined);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [leaveShortcut, setLeaveShortcut] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  // `onClose` is read through a ref so a new function identity from the
  // parent on every render doesn't re-fire the effect below (which would
  // re-request the preview on every unrelated parent re-render).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // No item to transfer, no personal-space owner match, or no eligible
    // target space to transfer into — nothing this dialog can offer.
    if (!eligible || targetSpaces.length === 0) {
      onCloseRef.current();
      return;
    }
    if (!targetId) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreview(undefined);
    setPreviewErrorMessage(undefined);
    previewTransfer({ items: items.map(({ type, id }) => ({ type, id })), target_space_id: targetId })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setPreviewErrorMessage(undefined);
        setTicked(new Set(result.datasets.filter((dataset) => dataset.owned).map((dataset) => dataset.id)));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreview(undefined);
        setPreviewErrorMessage(error instanceof Error && error.message ? error.message : "");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eligible, targetSpaces.length, targetId, items]);

  if (!eligible || targetSpaces.length === 0 || !targetId) return null;

  const target = spaces.find((s) => s.id === targetId);
  if (!target) return null;

  const toggleDataset = (id: string) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!preview) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const result = await transferContent({
        items: items.map(({ type, id }) => ({ type, id })),
        target_space_id: target.id,
        dataset_ids: Array.from(ticked),
        leave_shortcut: leaveShortcut,
      });
      toast.success(t("transfer_success", { name: targetLabel(target, t) }));
      refreshContentFeed();
      onTransferred(result, target);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const primaryName = items[0]?.name ?? "";
  const more = items.length > 1 ? ` +${items.length - 1}` : "";
  const whatCount = items.length + (preview?.folders_in_subtrees ?? 0);
  const hasCollisions = (preview?.name_collisions.length ?? 0) > 0;
  const submitDisabled = previewLoading || !preview || submitting || hasCollisions;

  const targetName = targetLabel(target, t);
  // Every consequence the preview reports, as one icon+sentence list — the
  // amber block below renders them in order.
  const whatHappens: { icon: ICON_NAME; text: string; warning?: boolean }[] = preview
    ? [
        {
          icon: ICON_NAME.CROWN,
          text:
            target.kind === "organization"
              ? t("transfer_line_org", { name: targetName, what: t("n_items", { count: whatCount }) })
              : t("transfer_line_team", { name: targetName, what: t("n_items", { count: whatCount }) }),
        },
        ...(preview.grants_to_drop > 0
          ? [{ icon: ICON_NAME.SHARE, text: t("transfer_line_grants", { count: preview.grants_to_drop }) }]
          : []),
        ...(preview.datasets.some((dataset) => dataset.used_elsewhere)
          ? [{ icon: ICON_NAME.DATABASE, text: t("transfer_line_used_elsewhere") }]
          : []),
        ...(preview.trashed_in_subtrees > 0
          ? [{ icon: ICON_NAME.TRASH, text: t("transfer_line_trashed", { count: preview.trashed_in_subtrees }) }]
          : []),
        ...preview.warnings.map((warning) => ({ icon: ICON_NAME.INFO, text: warning, warning: true })),
      ]
    : [];

  return (
    <Dialog
      open
      onClose={onClose}
      aria-labelledby={titleId}
      fullScreen={fullScreen}
      PaperProps={{ sx: contentDialogPaperSx(540, fullScreen) }}>
      <ContentDialogHeader
        titleId={titleId}
        icon={ICON_NAME.CROWN}
        tone="warning"
        title={t("transfer_title", { name: primaryName, more })}
        subline={
          <Typography component="div" sx={{ fontSize: 12.5, color: "text.secondary" }}>
            {t("transfer_subtitle", { name: targetName })}
          </Typography>
        }
        onClose={onClose}
        closeLabel={t("close")}
        divider
      />

      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", padding: "2px 22px 16px" }}>
        <DialogGroupLabel first>{t("transfer_to_field")}</DialogGroupLabel>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "8px" }}>
          {targetSpaces.map((space) => {
            const on = space.id === targetId;
            return (
              <ButtonBase
                key={space.id}
                onClick={() => setTargetId(space.id)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: "9px",
                  padding: "9px 11px",
                  borderRadius: "10px",
                  textAlign: "left",
                  border: `1.5px solid ${on ? theme.palette.primary.main : theme.palette.divider}`,
                  backgroundColor: on ? alpha(theme.palette.primary.main, 0.12) : theme.palette.background.paper,
                }}>
                <Icon
                  iconName={spaceIconFor(space)}
                  style={{ fontSize: 15, color: on ? theme.palette.primary.main : theme.palette.text.secondary }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    component="div"
                    noWrap
                    sx={{ fontSize: 13, fontWeight: 700, color: on ? "primary.main" : "text.primary" }}>
                    {targetLabel(space, t)}
                  </Typography>
                  {/* The organization card's title already reads
                      "Organization"; only a team needs its kind spelled out. */}
                  {space.kind === "team" && (
                    <Typography component="div" noWrap sx={{ fontSize: 11, color: "text.secondary" }}>
                      {t("team")}
                    </Typography>
                  )}
                </Box>
              </ButtonBase>
            );
          })}
        </Box>

        {previewLoading && !preview && (
          <Stack spacing={1} sx={{ mt: 2 }}>
            <Skeleton variant="rectangular" height={20} />
            <Skeleton variant="rectangular" height={20} />
          </Stack>
        )}

        {previewErrorMessage !== undefined && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {previewErrorMessage || t("transfer_preview_failed")}
          </Alert>
        )}

        {preview && (
          <>
            <DialogGroupLabel>{t("what_happens")}</DialogGroupLabel>
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: "7px",
                padding: "11px 13px",
                borderRadius: "10px",
                backgroundColor: alpha(theme.palette.warning.main, 0.07),
                border: `1px solid ${alpha(theme.palette.warning.main, 0.25)}`,
              }}>
              {whatHappens.map((line) => (
                <Box key={line.text} sx={{ display: "flex", alignItems: "flex-start", gap: "9px" }}>
                  <Icon
                    iconName={line.icon}
                    style={{
                      fontSize: 13,
                      marginTop: 2,
                      color: line.warning ? warningInk(theme) : theme.palette.text.secondary,
                    }}
                  />
                  <Typography
                    component="span"
                    sx={{
                      fontSize: 12.8,
                      lineHeight: 1.45,
                      color: line.warning ? warningInk(theme) : theme.palette.text.primary,
                    }}>
                    {line.text}
                  </Typography>
                </Box>
              ))}
            </Box>
          </>
        )}

        {hasCollisions && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {preview?.name_collisions.map((name) => <div key={name}>{t("transfer_name_collision", { name })}</div>)}
          </Alert>
        )}

        {submitError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {submitError}
          </Alert>
        )}

        {preview && preview.datasets.length > 0 && (
          <>
            <DialogGroupLabel>{t("datasets_project_uses")}</DialogGroupLabel>
            <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: "10px", overflow: "hidden" }}>
              {preview.datasets.map((dataset, index) => {
                const takes = dataset.owned && ticked.has(dataset.id);
                return (
                  <Box
                    key={dataset.id}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "7px 12px",
                      opacity: dataset.owned ? 1 : 0.75,
                      borderTop: index > 0 ? `1px solid ${theme.palette.divider}` : undefined,
                    }}>
                    <Checkbox
                      size="small"
                      checked={takes}
                      disabled={!dataset.owned}
                      onChange={() => toggleDataset(dataset.id)}
                      inputProps={{ "aria-label": dataset.name }}
                      sx={{ padding: 0 }}
                    />
                    <Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 14, color: theme.palette.text.secondary }} />
                    <Typography component="span" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
                      {dataset.name}
                    </Typography>
                    <Typography
                      component="span"
                      sx={{ fontSize: 11.5, whiteSpace: "nowrap", color: takes ? "primary.main" : "text.disabled" }}>
                      {dataset.owned ? (takes ? t("moves_to", { name: targetName }) : t("stays_yours")) : t("stays")}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
            <Typography sx={{ marginTop: "6px", fontSize: 11.5, color: "text.disabled", lineHeight: 1.45 }}>
              {t("ticked_datasets_note", { name: targetName })}
            </Typography>
          </>
        )}

        <FormControlLabel
          sx={{ marginTop: "14px", "& .MuiFormControlLabel-label": { fontSize: 13 } }}
          control={
            <Checkbox
              size="small"
              checked={leaveShortcut}
              onChange={(_event, checked) => setLeaveShortcut(checked)}
            />
          }
          label={t("leave_shortcut")}
        />
      </Box>

      <Box
        sx={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: "10px",
          padding: "13px 18px",
          borderTop: `1px solid ${theme.palette.divider}`,
          flexShrink: 0,
        }}>
        <Button variant="text" onClick={onClose} sx={{ color: "text.secondary", fontSize: 14, fontWeight: 600, textTransform: "none" }}>
          {t("cancel")}
        </Button>
        <LoadingButton
          variant="contained"
          color="warning"
          loading={submitting}
          disabled={submitDisabled}
          onClick={handleSubmit}
          startIcon={<Icon iconName={ICON_NAME.CROWN} style={{ fontSize: 14 }} />}
          sx={{
            borderRadius: "999px",
            padding: "10px 22px",
            fontSize: 14,
            fontWeight: 700,
            textTransform: "none",
            whiteSpace: "nowrap",
            backgroundColor: warningFill(theme),
            "&:hover": { backgroundColor: darken(theme.palette.warning.main, 0.42) },
          }}>
          {t("transfer_to", { name: targetName })}
        </LoadingButton>
      </Box>
    </Dialog>
  );
};

export default TransferDialog;
