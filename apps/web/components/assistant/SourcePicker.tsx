"use client";

import { Box, MenuItem, MenuList, Popover, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useProjects } from "@/lib/api/projects";
import type { SourceRef } from "@/lib/assistant/types";

import { accentSoft, accentText, mutedText } from "@/components/assistant/styles";
import ContentThumbnail from "@/components/dashboard/common/ContentThumbnail";
import SearchInput from "@/components/dashboard/common/SearchInput";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

export const SEARCH_DEBOUNCE_MS = 250;

export interface SourcePickerProps {
  anchorEl: HTMLElement | null;
  /** The text after the typed @, if the picker was opened by typing. */
  query: string;
  excludeProjectId?: string;
  onPick: (source: SourceRef) => void;
  onClose: () => void;
}

/**
 * Pick a project the user can open as a read-only source (spec §10). The
 * chrome is the header popovers' (12px radius, hairline border, lifted shadow)
 * and the search field is the dashboard's own. Arrow Down moves from the
 * field into the list, Enter in the field picks the first project.
 */
export default function SourcePicker({
  anchorEl,
  query,
  excludeProjectId,
  onPick,
  onClose,
}: SourcePickerProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const list = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(query);
  useEffect(() => setSearch(query), [query]);
  // One project request per pause in typing, not one per key.
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);
  const { projects, isLoading } = useProjects({ search: debounced || undefined, page: 1, size: 8 });
  const options = (projects?.items ?? []).filter((project) => project.id !== excludeProjectId);
  const pick = (project: { id: string; name: string }) =>
    onPick({ kind: "project", id: project.id, name: project.name });

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    } else if (event.key === "Enter" && options[0]) {
      event.preventDefault();
      pick(options[0]);
    }
  };

  return (
    <Popover
      open={!!anchorEl}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "top", horizontal: "left" }}
      transformOrigin={{ vertical: "bottom", horizontal: "left" }}
      // The popover focuses its paper when it opens; the search field is what typing is for.
      TransitionProps={{ onEntered: () => field.current?.focus() }}
      PaperProps={{
        sx: {
          // Never wider than the screen, so it stays inside the dock on a phone.
          width: "min(320px, calc(100vw - 32px))",
          mt: "-6px",
          borderRadius: "12px",
          border: `1px solid ${theme.palette.divider}`,
          boxShadow: surfaceShadows(theme).hover,
          overflow: "hidden",
        },
      }}>
      <Box sx={{ p: "10px", borderBottom: 1, borderColor: "divider" }}>
        <SearchInput
          ref={field}
          size="toolbar"
          fullWidth
          autoFocus
          value={search}
          onChange={setSearch}
          placeholder={t("assistant_source_search")}
          ariaLabel={t("assistant_source_search")}
          onKeyDown={onSearchKeyDown}
        />
      </Box>
      <Box sx={{ maxHeight: 280, overflowY: "auto", p: "6px" }}>
        {isLoading ? (
          <Stack gap="2px" aria-busy="true">
            {[0, 1, 2].map((row) => (
              <Stack key={row} direction="row" alignItems="center" gap="10px" sx={{ px: "8px", py: "6px" }}>
                <Skeleton variant="rounded" width={28} height={28} sx={{ borderRadius: "7px" }} />
                <Skeleton variant="text" sx={{ flex: 1, fontSize: 13 }} />
              </Stack>
            ))}
          </Stack>
        ) : options.length === 0 ? (
          <Stack alignItems="center" gap="6px" sx={{ px: "12px", py: "18px", color: mutedText }}>
            <Icon iconName={ICON_NAME.MAP} style={{ fontSize: 16, color: "inherit" }} />
            <Typography sx={{ fontSize: 12.5, color: "inherit", textAlign: "center" }}>
              {t("assistant_source_none")}
            </Typography>
          </Stack>
        ) : (
          <MenuList ref={list} disablePadding sx={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {options.map((project) => (
              <MenuItem
                key={project.id}
                onClick={() => pick(project)}
                sx={{
                  gap: "10px",
                  minHeight: 0,
                  px: "8px",
                  py: "6px",
                  borderRadius: "8px",
                  "&:hover": { bgcolor: "action.hover" },
                  // Arrow keys move the focus: the focused row takes the tint and an inset ring.
                  "&.Mui-focusVisible, &:focus-visible": {
                    bgcolor: accentSoft(theme),
                    boxShadow: `inset 0 0 0 2px ${accentText(theme)}`,
                  },
                }}>
                <ContentThumbnail
                  kind="project"
                  variant="mark"
                  height={28}
                  href={project.thumbnail_url || undefined}
                />
                <Typography
                  noWrap
                  title={project.name}
                  sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "text.primary" }}>
                  {project.name}
                </Typography>
              </MenuItem>
            ))}
          </MenuList>
        )}
      </Box>
    </Popover>
  );
}
