"use client";

import { Box, Chip, Fab, Skeleton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { formatDistance } from "date-fns";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { layoutPageDescription } from "@/lib/templates/previewGeometry";
import { THUMBNAIL_ACCEPT, thumbnailFileRejection } from "@/lib/templates/thumbnailFile";
import type { TemplatePreviewDescriptor, TemplateRead } from "@/lib/validations/template";

import ContentThumbnail from "@/components/dashboard/common/ContentThumbnail";
import MarkdownProse from "@/components/dashboard/common/MarkdownProse";
import { DialogGroupLabel } from "@/components/modals/content/ContentDialogChrome";
import TemplateDefaultThumbnail, {
  hasTemplateDefaultThumbnail,
} from "@/components/templates/TemplateDefaultThumbnail";
import TemplatePreviewFallback from "@/components/templates/TemplatePreviewFallback";
import TemplateTag from "@/components/templates/TemplateTag";

interface TemplatePreviewPanelProps {
  template: TemplateRead;
  /** The shelf the template came from, tagged above its name. */
  sourceLabel?: string;
  /** The structure to draw while there is no picture yet — given by the save
   * dialog, which builds it from the config being saved. A read-only host
   * leaves it off: a saved template with no picture shows the template mark,
   * not a reconstruction of its payload. */
  descriptor?: TemplatePreviewDescriptor | null;
  /** The name is a stand-in for one the author has not typed yet, so it
   * reads muted rather than as the template's own. */
  namePlaceholder?: boolean;
  /** Given by the save dialog, which is where the thumbnail is chosen: the
   * picture then carries its own hover actions. Every read-only host leaves
   * this off and the box is a picture alone. */
  thumbnailActions?: TemplateThumbnailActions;
  /** The thumbnail is still being made — the save dialog generates a
   * workflow snapshot while the author fills the form in. The box holds its
   * place with a skeleton rather than showing a scaffold that a picture is
   * about to replace. */
  thumbnailLoading?: boolean;
}

export interface TemplateThumbnailActions {
  /** Handed a picked file that passed the type and size checks. */
  onUpload: (file: File) => void;
  /** Given only while a picked picture is standing in for another one — the
   * "Reset to generated" action is what puts that back. */
  onReset?: () => void;
}

/** The two actions a chosen thumbnail carries, on the picture itself: the
 * pattern the builder's image widget uses (`components/builder/widgets/
 * elements/Image.tsx`) — small round buttons that fade in over the image on
 * hover, and on focus so a keyboard reaches them. */
const ThumbnailActionButtons = ({ onUpload, onReset }: TemplateThumbnailActions) => {
  const { t } = useTranslation("common");
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
        ref={inputRef}
        data-testid="thumbnail-upload-input"
        type="file"
        accept={THUMBNAIL_ACCEPT}
        aria-label={t("upload_image")}
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // The same file picked twice in a row has to fire again.
          event.target.value = "";
          if (!file) return;
          const rejection = thumbnailFileRejection(file);
          if (rejection) {
            toast.error(t(rejection.key, rejection.values));
            return;
          }
          onUpload(file);
        }}
      />
      <Stack direction="row" spacing={1}>
        <Tooltip title={t("upload_image")} arrow placement="top">
          <span>
            <Fab
              size="small"
              color="primary"
              aria-label={t("upload_image")}
              onClick={() => inputRef.current?.click()}>
              <Icon iconName={ICON_NAME.UPLOAD} htmlColor="inherit" style={{ fontSize: 15 }} />
            </Fab>
          </span>
        </Tooltip>
        {onReset && (
          <Tooltip title={t("reset_to_generated")} arrow placement="top">
            <span>
              <Fab size="small" aria-label={t("reset_to_generated")} onClick={onReset}>
                <Icon iconName={ICON_NAME.REFRESH} htmlColor="inherit" style={{ fontSize: 15 }} />
              </Fab>
            </span>
          </Tooltip>
        )}
      </Stack>
    </>
  );
};

/** The declared inputs a template asks for when it is used, one row each. */
const TemplateInputsList = ({ template }: { template: TemplateRead }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {(template.inputs ?? []).map((input) => (
        <Box key={input.key} sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {input.from_catalog && (
            <Tooltip title={t("sample_data")} placement="top" disableInteractive>
              <Box sx={{ display: "inline-flex" }}>
                <Icon
                  iconName={ICON_NAME.DATABASE}
                  style={{ fontSize: 13 }}
                  htmlColor={theme.palette.text.secondary}
                />
              </Box>
            </Tooltip>
          )}
          <Typography component="span" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 13 }}>
            {input.label}
          </Typography>
          <Chip
            label={t(input.mode === "ship" ? "ship_dataset" : "ask_on_use")}
            size="small"
            sx={{ height: 20, fontSize: 11, flexShrink: 0 }}
          />
        </Box>
      ))}
    </Box>
  );
};

/** A template's categories, each in the colour its name hashes to. */
const TemplateCategoryChips = ({ categories }: { categories: string[] }) => (
  <Box sx={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
    {categories.map((category) => (
      <TemplateTag key={category} label={category} tone="category" />
    ))}
  </Box>
);

/** T7's preview panel: what the picked template is, what it will ask for,
 * and a drawing of its payload. It carries neither header nor actions — the
 * host's dialog names the template and offers "Use template", so the panel
 * is only the column between them: `TemplatePreviewDialog` (the Home band,
 * the Content feed, the Catalog tab), the browser dialog's right column, and
 * the save dialog's live preview. v1 skips the why/how/who/what-it-creates
 * sections the prototype sketches: the description is one markdown field,
 * not the four the prototype splits it into. */
const TemplatePreviewPanel = ({
  template,
  sourceLabel,
  descriptor,
  namePlaceholder,
  thumbnailActions,
  thumbnailLoading,
}: TemplatePreviewPanelProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();

  const authorName = template.created_by?.name ?? t("source_goat");
  const categories = template.categories ?? [];
  const inputs = template.inputs ?? [];
  /** The page a layout template prints on — the size and orientation as a
   * tag beside its kind, the millimetres under the picture. */
  const page = layoutPageDescription(template, t);

  /** The picture itself: the template's thumbnail, a skeleton while one is
   * being made, the drawn structure where the host handed one over, else the
   * default its payload kind draws — the same one its card shows. */
  const thumbnailBox = thumbnailLoading ? (
    <Skeleton
      data-testid="template-preview-thumbnail-loading"
      variant="rectangular"
      sx={{
        width: "100%",
        aspectRatio: "16 / 9",
        maxHeight: 420,
        borderRadius: "10px",
      }}
    />
  ) : template.thumbnail_url ? (
    <Box
      sx={{
        width: "100%",
        aspectRatio: "16 / 9",
        maxHeight: 420,
        borderRadius: "10px",
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
        // A preview shows the whole picture: an uploaded image is letterboxed
        // inside a margin rather than cropped to the frame the way a tile is.
        padding: "12px",
        backgroundColor: theme.palette.action.hover,
        // The thumbnail fills the padded box, which is what sets the height.
        "& > div": { borderRadius: 0, width: "100%", height: "100%", backgroundColor: "transparent" },
      }}>
      <ContentThumbnail kind="template" href={template.thumbnail_url} variant="card" fit="contain" />
    </Box>
  ) : descriptor !== undefined ? (
    <TemplatePreviewFallback descriptor={descriptor} payloadKind={template.payload_kind} />
  ) : hasTemplateDefaultThumbnail(template.payload_kind) ? (
    <TemplateDefaultThumbnail payloadKind={template.payload_kind} page={page} variant="panel" />
  ) : (
    <Box
      sx={{
        width: "100%",
        aspectRatio: "16 / 9",
        maxHeight: 420,
        borderRadius: "10px",
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
        "& > div": { borderRadius: 0, width: "100%", height: "100%" },
      }}>
      <ContentThumbnail kind="template" variant="card" />
    </Box>
  );

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "22px" }}>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", mb: "6px" }}>
        {(template.kinds ?? []).map((kind) => (
          <TemplateTag key={kind} label={t(`template_kind_${kind}`)} tone="kind" />
        ))}
        {page && <TemplateTag label={page.label} />}
        {sourceLabel && <TemplateTag label={sourceLabel} />}
      </Box>
      <Typography
        component="div"
        sx={{
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: "-0.3px",
          lineHeight: 1.2,
          color: namePlaceholder ? "text.disabled" : undefined,
        }}>
        {template.name}
      </Typography>
      <Typography
        component="div"
        sx={{ fontSize: 12.5, color: theme.palette.text.secondary, mt: "4px", mb: "14px" }}>
        {`${t("by_author", { name: authorName })} · ${formatDistance(
          new Date(template.updated_at),
          new Date(),
          { addSuffix: true, locale: dateLocale }
        )}`}
      </Typography>

      {thumbnailActions ? (
        <Box
          data-testid="template-preview-thumbnail"
          sx={{
            position: "relative",
            borderRadius: "10px",
            overflow: "hidden",
            "&:hover .overlay, &:focus-within .overlay": { opacity: 1 },
            "&:hover .action-buttons, &:focus-within .action-buttons": {
              opacity: 1,
              transform: "translateY(0)",
            },
          }}>
          {thumbnailBox}
          <Box
            className="overlay"
            sx={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.25)",
              opacity: 0,
              transition: "opacity 0.3s ease",
              pointerEvents: "none",
            }}
          />
          <Box
            className="action-buttons"
            sx={{
              position: "absolute",
              top: 8,
              left: 8,
              opacity: 0,
              transform: "translateY(-10px)",
              transition: "all 0.3s ease",
            }}>
            <ThumbnailActionButtons {...thumbnailActions} />
          </Box>
        </Box>
      ) : (
        thumbnailBox
      )}

      {page && (
        <Typography
          component="div"
          data-testid="template-preview-page-size"
          sx={{ fontSize: 11.5, color: theme.palette.text.secondary, mt: "6px" }}>
          {t("page_dimensions_mm", { width: page.width, height: page.height })}
        </Typography>
      )}

      {template.description && (
        <Box sx={{ mt: "16px" }}>
          <MarkdownProse>{template.description}</MarkdownProse>
        </Box>
      )}

      {inputs.length > 0 && (
        <Box sx={{ mt: "18px" }}>
          <DialogGroupLabel first>{t("template_inputs")}</DialogGroupLabel>
          <TemplateInputsList template={template} />
        </Box>
      )}

      {categories.length > 0 && (
        <Box sx={{ mt: "18px" }}>
          <DialogGroupLabel first>{t("categories")}</DialogGroupLabel>
          <TemplateCategoryChips categories={categories} />
        </Box>
      )}
    </Box>
  );
};

export default TemplatePreviewPanel;
