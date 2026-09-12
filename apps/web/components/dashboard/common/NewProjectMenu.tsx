"use client";

import type { ButtonProps } from "@mui/material";
import { Box, Button, ListItemIcon, Menu, MenuItem, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mutate } from "swr";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { refreshContentFeed } from "@/lib/api/content";
import { createProject } from "@/lib/api/projects";
import { USERS_API_BASE_URL } from "@/lib/api/users";
import type { Project } from "@/lib/validations/project";

import NameDialog from "@/components/dashboard/common/NameDialog";
import ProjectImportModal from "@/components/modals/ProjectImport";

/** What a project starts life with, until the builder saves its own: the
 * default artwork every new project carries, and a Munich-centred view. */
const NEW_PROJECT_THUMBNAIL = "https://assets.plan4better.de/img/goat_new_project_artwork.png";
const NEW_PROJECT_VIEW_STATE = {
  latitude: 48.1502132,
  longitude: 11.5696284,
  zoom: 12,
  min_zoom: 0,
  max_zoom: 20,
  bearing: 0,
  pitch: 0,
};

/** Same SWR key `useOnboardingFacts` (lib/api/onboarding.ts) reads, revalidated
 * here so the checklist and the header tray reflect a project that has just
 * been created without waiting for their own poll. */
const revalidateOnboardingFacts = () => mutate(`${USERS_API_BASE_URL}/me/onboarding`);

/** The two ways to start a project. Templates start from the "Start from a
 * template" band and the template browser instead, where the use flow
 * itself asks whether to add to a project or create one. */
export type NewProjectIntent = "blank" | "import";

export interface NewProjectItem {
  key: NewProjectIntent;
  labelKey: string;
  icon: ICON_NAME;
  /** Labels an entry whose click opens a dialog asking for a file, rather
   * than creating something on the spot. */
}

/** The one list every "New project" surface renders — Home's hero button and
 * Content's "Add new" menu — so both offer the same starts in the same
 * order. */
/** Paper styling shared by the dashboard's action dropdowns ("New project",
 * Content's "Add new"): a breath of space under the trigger and a width that
 * does not hug the labels. */
export const DASHBOARD_MENU_SLOT_PROPS = {
  paper: { sx: { mt: 1, minWidth: 240, borderRadius: "10px" } },
} as const;

export const NEW_PROJECT_ITEMS: NewProjectItem[] = [
  { key: "blank", labelKey: "blank_project", icon: ICON_NAME.MAP },
  { key: "import", labelKey: "import_project", icon: ICON_NAME.UPLOAD },
];

/** Where a new project should land. A blank project files straight into
 * `folderId`; an import only pre-selects the folder field. */
export interface NewProjectLocation {
  spaceId?: string;
  folderId?: string;
}

interface NewProjectFlowsProps {
  /** Which flow is open, `null` for none — owned by the caller so the same
   * dialogs can be driven from a hero button or a menu entry. */
  intent: NewProjectIntent | null;
  onClose: () => void;
  location: NewProjectLocation;
  /** Fired with the project the flow produced, after the feed has been
   * refreshed and before this component navigates. */
  onCreated?: (projectId: string) => void;
}

/**
 * The dialogs behind the project starts, in one place: a name-only blank
 * project and the project-archive import. Every start ends in the builder,
 * so this component owns the navigation; callers only say which one is open
 * and where the result should live.
 */
export const NewProjectFlows = ({ intent, onClose, location, onCreated }: NewProjectFlowsProps) => {
  const { t } = useTranslation("common");
  const router = useRouter();

  return (
    <>
      {intent === "blank" && (
        <NameDialog
          title={t("new_project")}
          icon={ICON_NAME.MAP}
          placeholder={t("project_name_placeholder")}
          cta={t("create_project")}
          onClose={onClose}
          // A blank project files into `folderId`; until the caller knows it
          // (Home resolves the personal home folder from a request) the
          // create would be refused by the server.
          ready={!!location.folderId}
          onSubmit={async (name) => {
            let project: Project;
            try {
              project = await createProject({
                name,
                description: "",
                folder_id: location.folderId,
                thumbnail_url: NEW_PROJECT_THUMBNAIL,
                initial_view_state: NEW_PROJECT_VIEW_STATE,
              });
            } catch {
              throw new Error(t("error_creating_project"));
            }
            refreshContentFeed();
            void revalidateOnboardingFacts();
            onClose();
            onCreated?.(project.id);
            // A new project has nothing to show in the feed — it opens
            // straight into the builder.
            router.push(`/map/${project.id}`);
          }}
        />
      )}

      {/* A fresh instance per open, so the folder being browsed now seeds the
       * folder field — the modal reads `defaultFolderId` once, at mount. */}
      {intent === "import" && (
        <ProjectImportModal
          open
          defaultFolderId={location.folderId}
          onClose={onClose}
          onImportStarted={refreshContentFeed}
        />
      )}
    </>
  );
};

interface NewProjectButtonProps {
  location: NewProjectLocation;
  size?: ButtonProps["size"];
  fullWidth?: boolean;
}

/**
 * "New project" as one button with a menu: the three starts sit behind a
 * chevron instead of competing for room as separate quick actions.
 */
export const NewProjectButton = ({ location, size, fullWidth }: NewProjectButtonProps) => {
  const { t } = useTranslation("common");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [intent, setIntent] = useState<NewProjectIntent | null>(null);

  return (
    <>
      <Button
        ref={buttonRef}
        variant="contained"
        size={size}
        fullWidth={fullWidth}
        startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14 }} />}
        endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 12 }} />}
        onClick={() => setMenuOpen(true)}
        sx={{
          borderRadius: "999px",
          textTransform: "none",
          fontWeight: 600,
          px: "18px",
          boxShadow: "none",
          "&:hover": { boxShadow: "none" },
        }}>
        {t("new_project")}
      </Button>

      <Menu
        anchorEl={buttonRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        slotProps={DASHBOARD_MENU_SLOT_PROPS}>
        {NEW_PROJECT_ITEMS.map((item) => (
          // A direct `MenuItem` child of `Menu`: `MenuList` clones its own
          // children to drive arrow-key navigation and typeahead, so a
          // wrapper element in between would take those away.
          <MenuItem
            key={item.key}
            onClick={() => {
              setMenuOpen(false);
              setIntent(item.key);
            }}>
            <ListItemIcon sx={{ minWidth: 30 }}>
              <Icon iconName={item.icon} style={{ fontSize: 15 }} />
            </ListItemIcon>
            <Box>
              <Typography variant="body2">{t(item.labelKey)}</Typography>
            </Box>
          </MenuItem>
        ))}
      </Menu>

      <NewProjectFlows intent={intent} onClose={() => setIntent(null)} location={location} />
    </>
  );
};
