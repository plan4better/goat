"use client";

import { Box, Skeleton } from "@mui/material";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { TemplateRead } from "@/lib/validations/template";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import TemplatePreviewPanel from "@/components/templates/TemplatePreviewPanel";

interface TemplatePreviewDialogProps {
  open: boolean;
  /** Undefined until the host's template read lands — the body is a skeleton
   * and "Use template" is refused while there is nothing to preview. */
  template: TemplateRead | undefined;
  /** The read is in flight, which keeps "Use template" refused even where a
   * template is already on screen. */
  loading?: boolean;
  onClose: () => void;
  onUse: () => void;
  /** The shelf the template came from, tagged above its name. */
  sourceLabel?: string;
}

/** The body while the template itself is still loading: the preview's own
 * shape — a title line, a byline, and the 16:9 block the thumbnail fills. */
const PreviewSkeleton = () => (
  <Box sx={{ padding: "22px" }}>
    <Skeleton variant="text" width="60%" sx={{ fontSize: 20 }} />
    <Skeleton variant="text" width="35%" sx={{ fontSize: 12.5, mb: "14px" }} />
    <Skeleton variant="rectangular" height={200} sx={{ borderRadius: "10px" }} />
  </Box>
);

/**
 * The one dialog a template previews in, wherever it is opened from: the
 * Home band, the Content feed and the Catalog's Templates tab all mount
 * this, so a template reads the same in all three. The preview itself is
 * `TemplatePreviewPanel`, which carries neither header nor actions — this
 * shell's own header names the template and its footer offers "Use
 * template", which hands back to the host's `UseTemplateFlow`. The picture
 * the preview draws comes from the template's own public `preview`
 * descriptor, so nothing else has to be read here.
 */
const TemplatePreviewDialog = ({
  open,
  template,
  loading,
  onClose,
  onUse,
  sourceLabel,
}: TemplatePreviewDialogProps) => {
  const { t } = useTranslation("common");
  // "Use template" hands over to the host's flow dialog in the same click;
  // this one then leaves without its fade so the two never overlap.
  const handedOff = useRef(false);
  if (open) handedOff.current = false;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      transitionDuration={handedOff.current ? { enter: 0, exit: 0 } : undefined}
      icon={ICON_NAME.CLONE}
      title={template?.name ?? t("template")}
      maxWidth={760}
      fullScreenBelow="md"
      bleed
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("use_template")}
          onPrimary={() => {
            handedOff.current = true;
            onUse();
          }}
          primaryDisabled={!template || loading}
        />
      }>
      {template ? (
        <TemplatePreviewPanel template={template} sourceLabel={sourceLabel} />
      ) : (
        <PreviewSkeleton />
      )}
    </AppDialog>
  );
};

export default TemplatePreviewDialog;
