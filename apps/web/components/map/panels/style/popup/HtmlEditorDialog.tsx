import { Box, Stack, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import dynamic from "next/dynamic";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { PopupProperties } from "@/lib/validations/layer";

import useLayerFields from "@/hooks/map/CommonHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { PopupContent, PopupHeader } from "@/components/map/popover/MapFeaturePopover";
import type { LayerField } from "@/components/map/popover/formatFeatureProperties";
import { PopupHtmlStyles } from "@/components/map/popover/popupStyles";
import { useSampleFeature } from "@/components/map/popover/sampleFeature";

import { PopupAppearanceSettings } from "./PopupAppearanceSettings";

const HtmlModeEditor = dynamic(() => import("./HtmlModeEditor").then((m) => m.HtmlModeEditor), {
  ssr: false,
});

interface Props {
  open: boolean;
  layerId: string;
  layerName: string;
  layerIcon?: ReactNode;
  popup: PopupProperties;
  onChange: (patch: Partial<PopupProperties>) => void;
  onClose: () => void;
  /** The fields to offer in place of the layer's (a raster file's cell has its own). */
  fields?: LayerField[];
}

export function HtmlEditorDialog({
  open,
  layerId,
  layerName,
  layerIcon,
  popup,
  onChange,
  onClose,
  fields,
}: Props) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { layerFields } = useLayerFields(layerId);
  const { feature } = useSampleFeature(layerId, open);

  // Local draft so Cancel discards. Seeded from the live popup each open.
  const [draftHtml, setDraftHtml] = useState(popup.html);

  const previewPopup: PopupProperties = { ...popup, html: draftHtml };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      icon={ICON_NAME.CODE}
      title={t("popup_html_editor_title")}
      maxWidth={1200}
      // The three panes are sized against the frame, not their content, so the
      // paper states the height and the body fills whatever the header and the
      // footer leave of it.
      paperSx={{ height: { xs: "100%", sm: "82vh" } }}
      bleed
      // overflow hidden so the dialog itself never scrolls — only the
      // CodeMirror editor scrolls internally (preview + settings panes fit).
      bodySx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("save")}
          onPrimary={() => {
            onChange({ html: draftHtml });
            onClose();
          }}
        />
      }>
      <Stack direction="row" sx={{ flex: 1, minHeight: 0, width: "100%" }}>
        {/* Left — editor (the only scrollable region) */}
        <Box
          sx={{
            width: "38%",
            borderRight: `1px solid ${theme.palette.divider}`,
            p: 3,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>
          <HtmlModeEditor
            value={draftHtml}
            onChange={setDraftHtml}
            fields={fields ?? (layerFields as LayerField[])}
          />
        </Box>

        {/* Center — preview canvas */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
            px: 4,
            py: 3,
            overflow: "hidden",
            // Subtle neutral canvas so the white popup card reads as a
            // floating element, the way it does over the map.
            bgcolor: (th) =>
              th.palette.mode === "light" ? th.palette.grey[100] : alpha(th.palette.common.white, 0.04),
          }}>
          {/* Desktop/Mobile preview toggle hidden until a real mobile popup
                render target exists (mobile bottom sheet is a deferred phase).
                Preview is pinned to the desktop width. */}
          <Box
            className="goat-feature-popup"
            sx={{
              width: popup.width ?? 360,
              // Cap to the preview pane so a tall popup scrolls inside its
              // own card (via PopupContent) instead of clipping.
              maxHeight: popup.max_height ? `${popup.max_height}px` : "100%",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              bgcolor: "background.paper",
              borderRadius: 2.5,
              boxShadow: theme.shadows[6],
              overflow: "hidden",
            }}>
            <PopupHtmlStyles />
            {/* Render the same header chrome as the real popup so the
                  preview reflects the Header setting (standard/compact/none). */}
            {popup.header !== "none" && (
              <PopupHeader
                layerName={layerName}
                layerIcon={layerIcon}
                onClose={() => {}}
                compact={popup.header === "compact"}
              />
            )}
            {feature ? (
              <PopupContent layerId={layerId} popup={previewPopup} properties={feature.properties} />
            ) : (
              <Typography variant="caption" sx={{ p: 2, display: "block" }} color="text.secondary">
                {t("loading")}
              </Typography>
            )}
          </Box>
        </Box>

        {/* Right — settings */}
        <Box
          sx={{
            width: "26%",
            borderLeft: `1px solid ${theme.palette.divider}`,
            px: 3,
            py: 3,
            overflow: "hidden",
          }}>
          <PopupAppearanceSettings popup={popup} onChange={onChange} />
        </Box>
      </Stack>
    </AppDialog>
  );
}
