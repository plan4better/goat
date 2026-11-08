"use client";

import { Divider, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { privacyPolicyUrl } from "@/lib/constants";
import type { Project } from "@/lib/validations/project";

import type { PopperMenuItem } from "@/components/common/PopperMenu";
import MoreMenu from "@/components/common/PopperMenu";
import ProjectMenuButton from "@/components/header/ProjectMenuButton";
import ContentDeleteModal from "@/components/modals/ContentDelete";
import Metadata from "@/components/modals/Metadata";
import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";

/**
 * The map header's project menu (the logo with its chevron) and the dialogs it
 * opens. Only the map view shows it, so the shared dashboard header loads it
 * with next/dynamic and the other pages never load react-map-gl, the Markdown
 * editor or the project dialogs (Settings load, L6).
 */
export default function ProjectMenu({
  project,
  viewOnly,
  isLoggedIn,
  onProjectUpdate,
}: {
  project?: Project;
  viewOnly?: boolean;
  isLoggedIn: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (key: string, value: any, refresh?: boolean) => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation(["common"]);
  const { map } = useMap();
  const lng = i18n.language === "de" ? "/de" : "";
  const [isEditingProjectMetadata, setIsEditingProjectMetadata] = useState(false);
  const [showDeleteProjectDialog, setShowDeleteProjectDialog] = useState(false);
  const [showSaveTemplateDialog, setShowSaveTemplateDialog] = useState(false);

  const mapMenuItems: PopperMenuItem[] = useMemo(() => {
    const editorMenuItems: PopperMenuItem[] = [
      {
        id: "home",
        icon: ICON_NAME.HOUSE,
        label: t("common:home"),
        group: "basic",
        onClick: () => {
          window.location.href = "/home";
        },
      },
      {
        id: "edit_metadata",
        icon: ICON_NAME.EDIT,
        label: t("common:edit_metadata"),
        group: "project",
        onClick: () => {
          setIsEditingProjectMetadata(true);
        },
      },
      {
        id: "save_project_as_template",
        icon: ICON_NAME.SAVE,
        label: t("common:save_project_as_template"),
        group: "project",
        onClick: () => {
          setShowSaveTemplateDialog(true);
        },
      },
      {
        id: "delete_project",
        icon: ICON_NAME.TRASH,
        label: t("common:delete_project"),
        group: "project",
        color: theme.palette.error.main,
        onClick: () => {
          setShowDeleteProjectDialog(true);
        },
      },
      {
        id: "lock_map_view",
        icon: project?.max_extent ? ICON_NAME.UNLOCK : ICON_NAME.LOCK,
        label: project?.max_extent ? t("common:unlock_map_view") : t("common:lock_map_view"),
        group: "map",
        onClick: async () => {
          if (map) {
            if (project?.max_extent) {
              await onProjectUpdate?.("max_extent", null);
            } else {
              const bounds = map.getBounds()?.toArray().flat();
              await onProjectUpdate?.("max_extent", bounds);
            }
          }
        },
      },
    ];

    const publicMenuItems: PopperMenuItem[] = [
      {
        id: "login",
        icon: ICON_NAME.USER,
        label: t("common:login"),
        group: "login",
        onClick: () => {
          window.location.href = "/auth/login";
        },
      },
    ];
    const privacyUrl = privacyPolicyUrl(lng ? "de" : "en");
    const commonMenuItems: PopperMenuItem[] = [];
    if (privacyUrl) {
      commonMenuItems.push({
        id: "privacy_policy",
        icon: ICON_NAME.COOKIES,
        label: t("common:privacy_policy"),
        group: "privacy",
        onClick: () => {
          window.open(privacyUrl, "_blank");
        },
      });
    }

    const homeItem = editorMenuItems[0]; // reuse the already-defined "home" item

    if (!viewOnly) {
      return [...editorMenuItems, ...commonMenuItems];
    } else if (isLoggedIn) {
      return [homeItem, ...commonMenuItems];
    } else {
      return [...publicMenuItems, ...commonMenuItems];
    }
  }, [t, theme.palette.error.main, project?.max_extent, viewOnly, isLoggedIn, map, onProjectUpdate, lng]);

  return (
    <>
      {showDeleteProjectDialog && project && (
        <ContentDeleteModal
          onDelete={() => {
            setShowDeleteProjectDialog(false);
            window.location.href = "/home";
          }}
          content={project}
          open={showDeleteProjectDialog}
          onClose={() => setShowDeleteProjectDialog(false)}
          type="project"
        />
      )}
      {project && isEditingProjectMetadata && (
        <Metadata
          open={isEditingProjectMetadata}
          onClose={() => setIsEditingProjectMetadata(false)}
          type="project"
          content={project}
        />
      )}
      {project && showSaveTemplateDialog && (
        <SaveTemplateDialog
          source={{ kind: "project", project_id: project.id }}
          defaultName={project.name}
          defaultThumbnailUrl={project.thumbnail_url}
          onClose={() => setShowSaveTemplateDialog(false)}
          onSaved={() => setShowSaveTemplateDialog(false)}
        />
      )}
      <MoreMenu menuItems={mapMenuItems} disablePortal={false} menuButton={<ProjectMenuButton />} />
      <Divider orientation="vertical" flexItem />
    </>
  );
}
