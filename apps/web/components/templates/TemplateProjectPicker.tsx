"use client";

import { Box, ButtonBase, Chip, Skeleton, Typography, alpha, useTheme } from "@mui/material";
import { formatDistance } from "date-fns";
import { useTranslation } from "react-i18next";

import { useDateFnsLocale } from "@/i18n/utils";

import { spaceDisplayName } from "@/lib/utils/content";
import type { ContentItem, Space } from "@/lib/validations/content";

import { canAddToProject } from "@/hooks/templates/useUseTemplate";

import { DialogSearchField } from "@/components/modals/content/ContentDialogChrome";

export interface TemplateProjectPickerProps {
  /** The caller's projects, last opened first. */
  projects: ContentItem[];
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  spaces: Space[];
  disabled?: boolean;
}

const ROW_HEIGHT = 46;

/** The "Add to a project" half of the Use template dialog's location step:
 * a search field over the caller's projects and one radio row per project.
 * The first row is the one opened last and is marked so; a project the
 * caller can only view cannot take the payload and is shown greyed. */
const TemplateProjectPicker = ({
  projects,
  loading,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  spaces,
  disabled,
}: TemplateProjectPickerProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();
  const ago = (iso: string) =>
    formatDistance(new Date(iso), new Date(), { addSuffix: true, locale: dateLocale });
  const searching = search.trim().length > 0;

  return (
    <Box sx={{ display: "grid", gap: "10px" }}>
      <DialogSearchField
        value={search}
        onChange={onSearchChange}
        placeholder={t("search_projects")}
        clearLabel={t("clear")}
      />
      <Box
        role="radiogroup"
        aria-label={t("project")}
        sx={{ display: "grid", gap: "4px", maxHeight: ROW_HEIGHT * 5, overflowY: "auto" }}>
        {loading && projects.length === 0 && (
          <>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} variant="rounded" height={ROW_HEIGHT} sx={{ borderRadius: "10px" }} />
            ))}
          </>
        )}
        {!loading && projects.length === 0 && (
          <Typography
            sx={{
              padding: "18px",
              textAlign: "center",
              fontSize: 13,
              color: "text.secondary",
              border: `1px dashed ${theme.palette.divider}`,
              borderRadius: "10px",
            }}>
            {searching ? t("no_projects_found") : t("no_projects_yet")}
          </Typography>
        )}
        {projects.map((project, index) => {
          const on = project.id === selectedId;
          const editable = canAddToProject(project);
          return (
            <ButtonBase
              key={project.id}
              role="radio"
              aria-checked={on}
              aria-label={project.name}
              disabled={disabled || !editable}
              onClick={() => onSelect(project.id)}
              sx={{
                display: "grid",
                gridTemplateColumns: "18px 44px minmax(0, 1fr) auto",
                gap: "10px",
                alignItems: "center",
                width: "100%",
                textAlign: "left",
                padding: "7px 10px",
                borderRadius: "10px",
                border: `1px solid ${on ? theme.palette.primary.main : "transparent"}`,
                backgroundColor: on ? alpha(theme.palette.primary.main, 0.12) : "transparent",
                opacity: editable ? 1 : 0.55,
                "&:hover": { backgroundColor: on ? undefined : theme.palette.action.hover },
              }}>
              <Box
                aria-hidden
                sx={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: `2px solid ${on ? theme.palette.primary.main : theme.palette.text.disabled}`,
                  display: "grid",
                  placeItems: "center",
                  "&::after": on
                    ? {
                        content: '""',
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        backgroundColor: theme.palette.primary.main,
                      }
                    : undefined,
                }}
              />
              <Box
                aria-hidden
                sx={{
                  width: 44,
                  height: 30,
                  borderRadius: "5px",
                  backgroundColor: alpha(theme.palette.text.primary, 0.08),
                  backgroundImage: project.thumbnail_url ? `url(${project.thumbnail_url})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: 13, fontWeight: 700 }}>
                  {project.name}
                </Typography>
                <Typography noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                  {spaceDisplayName(
                    spaces.find((space) => space.id === project.space_id),
                    t
                  )}
                </Typography>
              </Box>
              <Box sx={{ textAlign: "right" }}>
                {!editable ? (
                  <Chip
                    label={t("view_only")}
                    size="small"
                    sx={{ height: 18, fontSize: 10.5, fontWeight: 800 }}
                  />
                ) : (
                  index === 0 &&
                  !searching && (
                    <Chip
                      label={t("last_opened")}
                      size="small"
                      color="primary"
                      sx={{ height: 18, fontSize: 10.5, fontWeight: 800, mb: "2px" }}
                    />
                  )
                )}
                <Typography
                  sx={{ fontSize: 11.5, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                  {ago(project.updated_at)}
                </Typography>
              </Box>
            </ButtonBase>
          );
        })}
      </Box>
    </Box>
  );
};

export default TemplateProjectPicker;
