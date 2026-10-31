"use client";

import { Box, Button, Stack, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { catalogHref } from "@/lib/assistant/catalog";
import { plain } from "@/lib/assistant/chips";
import {
  dropProposalUndoers,
  getActiveSurfaceOwner,
  hasProposalUndo,
  markProposal,
  setProposalUndo,
  takeProposalUndo,
  useActiveSurface,
  useDockState,
} from "@/lib/assistant/store";
import { canApply } from "@/lib/assistant/surface";
import type { Proposal } from "@/lib/assistant/types";

import { useDockActions } from "@/components/assistant/DockActions";
import {
  CARD_RADIUS,
  accentSoft,
  accentText,
  eyebrowSx,
  mutedText,
  neutralPillSx,
  pillButtonSx,
} from "@/components/assistant/styles";

export interface ProposalCardProps {
  proposal: Proposal;
  partId: string;
  conversationId: string;
  /** The project the conversation is bound to; null while unbound. */
  conversationProjectId: string | null;
  readOnly: boolean;
  /** The newest proposal of the conversation: the only one previewed. */
  isLatest: boolean;
}

/**
 * A generic proposal card (spec §10): title, tag, the target it applies to,
 * summary rows, and actions. Apply is the page's own (its surface adapter); a
 * page that cannot apply it offers to open the target instead.
 */
export default function ProposalCard({
  proposal,
  partId,
  conversationId,
  conversationProjectId,
  readOnly,
  isLatest,
}: ProposalCardProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const surface = useActiveSurface();
  const dock = useDockState();
  const actions = useDockActions();
  const [working, setWorking] = useState(false);
  const state = dock.proposals[partId];
  const applicable = !readOnly && canApply(proposal, surface);

  useEffect(() => {
    if (!applicable || !isLatest || state || !surface?.preview) return;
    surface.preview(proposal);
    return () => surface.clearPreview?.();
  }, [applicable, isLatest, state, surface, proposal]);

  const apply = async () => {
    if (!surface?.apply) return;
    // The page that applies is the one that may undo: read its owner before
    // the await, because the user can leave the page while the apply runs.
    const owner = getActiveSurfaceOwner();
    setWorking(true);
    try {
      const undo = await surface.apply(proposal);
      // One Undo per page: an older one would restore the page from before this apply.
      if (owner) dropProposalUndoers(owner);
      if (owner && typeof undo === "function") setProposalUndo(partId, undo, owner);
      markProposal(partId, "applied");
    } catch {
      toast.error(t("assistant_proposal_apply_failed"));
    } finally {
      setWorking(false);
    }
  };

  const undo = () => {
    // The undoer is taken first, so a second click cannot run it again. If it
    // throws, the page may be half restored: the card stays "applied" without
    // an Undo button and says so, like a failed apply.
    try {
      takeProposalUndo(partId)?.();
      markProposal(partId, null);
    } catch {
      toast.error(t("assistant_proposal_apply_failed"));
      // The undoer is gone from the store; publish the state again so the card re-renders without Undo.
      markProposal(partId, "applied");
    }
  };

  const projectTarget = proposal.target?.project_id ?? null;
  const targetLine = proposal.target
    ? t(
        "assistant_proposal_applies_to",
        plain({ name: proposal.target.name || t("assistant_proposal_row_project") })
      )
    : t("assistant_proposal_applies_to_catalog");
  const tagKey =
    proposal.kind === "map.view"
      ? "assistant_proposal_tag_map_view"
      : "assistant_proposal_tag_catalog_filters";
  const applyKey =
    proposal.kind === "map.view" ? "assistant_proposal_apply_map" : "assistant_proposal_apply_page";

  const neutral = neutralPillSx(theme);
  let footer: ReactNode = null;
  if (state === "applied") {
    footer = (
      <Stack
        direction="row"
        alignItems="center"
        gap="10px"
        role="status"
        sx={{
          px: "12px",
          py: "8px",
          borderRadius: "10px",
          bgcolor: accentSoft(theme),
          border: 1,
          borderColor: alpha(theme.palette.primary.main, 0.4),
        }}>
        <Box
          sx={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            flexShrink: 0,
            bgcolor: "primary.main",
            color: "primary.contrastText",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
          <Icon iconName={ICON_NAME.CHECK} style={{ fontSize: 9, color: "inherit" }} />
        </Box>
        <Typography sx={{ flex: 1, fontSize: 13, fontWeight: 700, color: accentText(theme) }}>
          {t("assistant_proposal_applied")}
        </Typography>
        {
          // Undo writes into the page that applied it: only while that page can still
          // apply this proposal (surface and target project; a project page that
          // switches mode or project keeps its owner and undoers, so this hides Undo).
          applicable && hasProposalUndo(partId) && (
            <Button
              size="small"
              variant="text"
              onClick={undo}
              startIcon={<Icon iconName={ICON_NAME.UNDO} style={{ fontSize: 11, color: "inherit" }} />}
              sx={{
                ...pillButtonSx,
                "&&": { ...pillButtonSx["&&"], px: "10px", py: "3px" },
                color: accentText(theme),
                "& .MuiButton-startIcon": { mr: "5px" },
              }}>
              {t("undo")}
            </Button>
          )
        }
      </Stack>
    );
  } else if (state === "discarded") {
    footer = (
      <Typography sx={{ fontSize: 12, color: mutedText }}>{t("assistant_proposal_discarded")}</Typography>
    );
  } else if (applicable) {
    footer = (
      <Stack direction="row" gap="8px" alignItems="center">
        {/* No hint while applying: a disabled button shows no tooltip. */}
        <Tooltip title={working ? "" : t("assistant_proposal_apply_hint")} describeChild>
          <Button
            variant="contained"
            size="small"
            disabled={working}
            onClick={() => void apply()}
            sx={{ ...pillButtonSx, "&&": { ...pillButtonSx["&&"], px: "18px" } }}>
            {t(applyKey)}
          </Button>
        </Tooltip>
        <Button
          variant="outlined"
          color="inherit"
          size="small"
          onClick={() => {
            surface?.clearPreview?.();
            markProposal(partId, "discarded");
          }}
          sx={neutral}>
          {t("discard")}
        </Button>
      </Stack>
    );
  } else if (proposal.kind === "catalog.filters") {
    // Catalog filters apply on the catalog page, whatever project they name.
    const href = catalogHref(proposal.payload);
    footer = (
      <Button
        variant="outlined"
        color="inherit"
        size="small"
        onClick={() => actions.openCatalog(href)}
        sx={neutral}>
        {t("assistant_proposal_open_in_catalog")}
      </Button>
    );
  } else if (projectTarget) {
    footer = (
      <Button
        variant="outlined"
        color="inherit"
        size="small"
        sx={neutral}
        onClick={() =>
          void actions.openInProject(projectTarget, {
            partId,
            bindConversationId: conversationProjectId ? undefined : conversationId,
            projectName: proposal.target?.name || null,
          })
        }>
        {t("assistant_proposal_open_in_project")}
      </Button>
    );
  }

  return (
    <Box
      data-part-id={partId}
      sx={{
        border: "1.5px solid",
        borderColor: alpha(theme.palette.primary.main, 0.6),
        borderRadius: CARD_RADIUS,
        overflow: "hidden",
      }}>
      <Stack
        direction="row"
        alignItems="center"
        gap="8px"
        sx={{ px: "12px", py: "10px", bgcolor: accentSoft(theme) }}>
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: accentText(theme) }}>
          {proposal.title}
        </Typography>
        <Typography component="span" sx={{ ...eyebrowSx, flexShrink: 0, color: accentText(theme) }}>
          {t(tagKey)}
        </Typography>
      </Stack>
      <Box sx={{ px: "12px", pt: "10px", pb: "12px" }}>
        <Typography sx={{ fontSize: 12, color: mutedText, mb: "4px" }}>{targetLine}</Typography>
        {proposal.rows
          .filter((row) => row.k !== "project")
          .map((row) => (
            <Stack key={row.k} direction="row" gap="10px" sx={{ py: "5px" }}>
              <Typography sx={{ ...eyebrowSx, width: 84, flexShrink: 0, pt: "2px", color: mutedText }}>
                {t(`assistant_proposal_row_${row.k}`, { defaultValue: row.k })}
              </Typography>
              <Typography
                sx={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: "text.primary",
                  overflowWrap: "anywhere",
                }}>
                {row.v}
              </Typography>
            </Stack>
          ))}
        {footer && <Box sx={{ mt: "10px", pt: "11px", borderTop: 1, borderColor: "divider" }}>{footer}</Box>}
      </Box>
    </Box>
  );
}
