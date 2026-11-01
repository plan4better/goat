import { Box, ClickAwayListener, Fade, Paper, Popper, Tooltip, Typography } from "@mui/material";
import type { PopperPlacementType, TooltipProps } from "@mui/material";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { stripMediaUrls } from "@/lib/utils/mediaEmbed";
import type { PopupPlacement, PopupSize, PopupType } from "@/lib/validations/widget";

import { popupMarkdownComponents } from "@/components/builder/widgets/common/markdownComponents";
import AppDialog from "@/components/common/AppDialog";

export type { PopupPlacement, PopupSize, PopupType };

interface PopupContentRendererProps {
  open: boolean;
  onClose: () => void;
  popup_type: PopupType;
  placement: PopupPlacement;
  anchorEl: HTMLElement | null;
  title?: string;
  content: string;
  /** Optional URL rendered as a "Learn more" link. Only shown for popover type. */
  url?: string;
  /** Visual size preset. Maps to pixel widths for tooltip/popover and to the dialog's paper width. */
  size?: PopupSize;
}

/** Pixel widths for tooltip and popover types. */
const POPOVER_MAX_WIDTH: Record<PopupSize, number> = {
  sm: 220,
  md: 320,
  lg: 480,
};

/** Keeps tooltip and popover within the viewport; longer content scrolls. */
const POPOVER_MAX_HEIGHT = "calc(100vh - 32px)";

/** Paper widths for the dialog type, matching MUI's xs/sm/md breakpoints. */
const DIALOG_MAX_WIDTH: Record<PopupSize, number> = {
  sm: 444,
  md: 600,
  lg: 900,
};

/**
 * Strip markdown syntax for tooltip rendering (plain text only).
 */
function stripMarkdown(input: string): string {
  return stripMediaUrls(
    input
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`#>~-]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const dialogMarkdownStyles = {
  "& p": { mb: 1.5, lineHeight: 1.7 },
  "& p:last-child": { mb: 0 },
  "& h1, & h2, & h3": { mt: 2, mb: 1, fontWeight: 700 },
  "& h1:first-of-type, & h2:first-of-type, & h3:first-of-type": { mt: 0 },
  "& h1": { fontSize: "1.1rem" },
  "& h2": { fontSize: "1rem" },
  "& h3": { fontSize: "0.9rem" },
  "& strong": { fontWeight: 700 },
  "& a": { color: "primary.main" },
  "& ul, & ol": { pl: 2.5, mb: 1.5 },
  "& li": { mb: 0.5 },
} as const;

const PopupContentRenderer = ({
  open,
  onClose,
  popup_type,
  placement,
  anchorEl,
  title,
  content,
  url,
  size = "md",
}: PopupContentRendererProps) => {
  const { t } = useTranslation("common");
  const popoverMaxWidth = POPOVER_MAX_WIDTH[size];
  const dialogMaxWidth = DIALOG_MAX_WIDTH[size];
  // Tooltip and popover are shown via `open` prop (not hover) and don't have
  // a focus-trapped close affordance like Dialog, so wire Escape manually.
  useEffect(() => {
    if (!open || popup_type === "dialog") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, popup_type, onClose]);

  if (!open) return null;

  if (popup_type === "tooltip") {
    // MUI Tooltip's `placement` directly accepts "top"/"bottom"/"left"/"right";
    // for "auto" it doesn't expose a value, so we let Popper.js's flip modifier
    // handle it via a custom modifier list.
    const tooltipPlacement: TooltipProps["placement"] = placement === "auto" ? "top" : placement;
    if (!anchorEl) return null;
    return (
      <ClickAwayListener onClickAway={onClose}>
        <Tooltip
          open
          title={stripMarkdown(content)}
          placement={tooltipPlacement}
          arrow
          slotProps={{
            tooltip: {
              sx: {
                maxWidth: popoverMaxWidth,
                maxHeight: POPOVER_MAX_HEIGHT,
                overflowY: "auto",
                fontSize: 12,
                lineHeight: 1.5,
              },
            },
            popper: {
              anchorEl,
              modifiers: [
                { name: "flip", enabled: placement === "auto" },
                { name: "preventOverflow", options: { altAxis: true, padding: 8 } },
              ],
            },
          }}>
          <span style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0 }} />
        </Tooltip>
      </ClickAwayListener>
    );
  }

  if (popup_type === "popover") {
    if (!anchorEl) return null;
    // Use Popper directly — it auto-flips when there's not enough room and
    // prevents overflow on the cross-axis. Plain MUI Popover with anchorOrigin
    // / transformOrigin only clamps to the viewport edge, which produces the
    // "stuck to the left" effect when the anchor is near the screen edge.
    const popperPlacement: PopperPlacementType = placement === "auto" ? "bottom" : placement;
    return (
      <Popper
        open
        anchorEl={anchorEl}
        placement={popperPlacement}
        transition
        modifiers={[
          { name: "flip", enabled: true },
          { name: "preventOverflow", options: { altAxis: true, padding: 8 } },
          { name: "offset", options: { offset: [0, 8] } },
        ]}
        sx={{ zIndex: 1300 }}>
        {({ TransitionProps }) => (
          <Fade {...TransitionProps} timeout={150}>
            <Paper
              elevation={6}
              sx={{
                p: 2,
                maxWidth: popoverMaxWidth,
                maxHeight: POPOVER_MAX_HEIGHT,
                overflowY: "auto",
                bgcolor: "background.paper",
                borderRadius: 1,
              }}>
              <ClickAwayListener onClickAway={onClose}>
                <Box>
                  {title && (
                    <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                      {title}
                    </Typography>
                  )}
                  <Box sx={{ ...dialogMarkdownStyles, "& p": { mb: 0.5, lineHeight: 1.5 } }}>
                    <ReactMarkdown components={popupMarkdownComponents}>{content}</ReactMarkdown>
                  </Box>
                  {url && (
                    <Typography
                      component="a"
                      variant="body2"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{
                        mt: 1,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 0.3,
                        color: "primary.main",
                        textDecoration: "none",
                        fontSize: 13,
                      }}>
                      {t("learn_more")}
                      <Box component="span" sx={{ fontSize: 10 }}>
                        ↗
                      </Box>
                    </Typography>
                  )}
                </Box>
              </ClickAwayListener>
            </Paper>
          </Fade>
        )}
      </Popper>
    );
  }

  // popup_type === "dialog"
  return (
    <AppDialog open onClose={onClose} icon={ICON_NAME.INFO} title={title ?? ""} maxWidth={dialogMaxWidth}>
      <Box sx={dialogMarkdownStyles}>
        <ReactMarkdown components={popupMarkdownComponents}>{content}</ReactMarkdown>
      </Box>
    </AppDialog>
  );
};

export default PopupContentRenderer;
