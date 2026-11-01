"use client";

import { Box, ButtonBase, Popover, Skeleton, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useContent, useSpaces } from "@/lib/api/content";
import { spaceDisplayName } from "@/lib/utils/content";
import type { ContentItem } from "@/lib/validations/content";

import { canAddToProject } from "@/hooks/templates/useUseTemplate";

import { focusRing } from "@/components/assistant/styles";
import { DialogSearchField } from "@/components/modals/content/ContentDialogChrome";

/** How many recent projects the menu lists. */
const RECENT = 6;

/**
 * "Add to project…" on a card shown outside an editable project: the user's
 * recently opened projects they may edit, with a search over all of them.
 * Picking one is the confirmation; the card adds right away.
 */
export default function ProjectPickerMenu({
  anchor,
  onClose,
  onPick,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (project: ContentItem) => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [search, setSearch] = useState("");
  const { spaces } = useSpaces();
  const { page, isLoading } = useContent(
    anchor
      ? {
          view: "recent",
          types: "project",
          order_by: "last_opened_at",
          search: search.trim() || undefined,
          // Some may be view only: ask for more than are shown.
          size: RECENT * 3,
        }
      : null
  );
  const projects = (page?.items ?? []).filter(canAddToProject).slice(0, RECENT);
  return (
    <Popover
      open={!!anchor}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{ paper: { sx: { width: 300, p: "10px", borderRadius: "12px" } } }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, mb: "8px" }}>
        {t("assistant_item_add_to_project_choose")}
      </Typography>
      <DialogSearchField
        value={search}
        onChange={setSearch}
        placeholder={t("search_projects")}
        clearLabel={t("clear")}
      />
      <Stack gap="2px" sx={{ mt: "8px", maxHeight: 280, overflowY: "auto" }}>
        {isLoading &&
          projects.length === 0 &&
          [0, 1, 2].map((index) => (
            <Skeleton key={index} variant="rounded" height={40} sx={{ borderRadius: "8px" }} />
          ))}
        {!isLoading && projects.length === 0 && (
          <Typography sx={{ p: "12px", textAlign: "center", fontSize: 12.5, color: "text.secondary" }}>
            {search.trim() ? t("no_projects_found") : t("no_projects_yet")}
          </Typography>
        )}
        {projects.map((project) => (
          <ButtonBase
            key={project.id}
            onClick={() => onPick(project)}
            sx={{
              fontFamily: "inherit",
              display: "flex",
              justifyContent: "flex-start",
              gap: "10px",
              p: "6px",
              borderRadius: "8px",
              textAlign: "left",
              "&:hover": { bgcolor: "action.hover" },
              ...focusRing(theme),
            }}>
            <Box
              aria-hidden
              sx={{
                width: 40,
                height: 28,
                flexShrink: 0,
                borderRadius: "5px",
                backgroundColor: alpha(theme.palette.text.primary, 0.08),
                backgroundImage: project.thumbnail_url ? `url(${project.thumbnail_url})` : undefined,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
            />
            <Box sx={{ minWidth: 0 }}>
              <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>
                {project.name}
              </Typography>
              <Typography noWrap sx={{ fontSize: 11, color: "text.secondary" }}>
                {spaceDisplayName(
                  spaces.find((space) => space.id === project.space_id),
                  t
                )}
              </Typography>
            </Box>
          </ButtonBase>
        ))}
      </Stack>
    </Popover>
  );
}
