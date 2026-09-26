"use client";

import Info from "@mui/icons-material/Info";
import { Box, Button, Chip, IconButton, Link, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import Divider from "@mui/material/Divider";
import { format, formatDistance, parseISO } from "date-fns";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { GOATLogoIconOnlyGreen } from "@p4b/ui/assets/svg/GOATLogoIconOnlyGreen";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useOrganization, useUserProfile } from "@/lib/api/users";
import { CONTACT_US_URL, DOCS_URL, WEBSITE_URL } from "@/lib/constants";
import { setSelectedLayers } from "@/lib/store/layer/slice";
import { setMapMode } from "@/lib/store/map/slice";
import { setActiveRightPanel } from "@/lib/store/map/slice";
import type { Project } from "@/lib/validations/project";

import { useAuthZ } from "@/hooks/auth/AuthZ";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import UserInfoMenu from "@/components/UserInfoMenu";
import EditableTypography from "@/components/common/EditableTypography";
import type { PopperMenuItem } from "@/components/common/PopperMenu";
import MoreMenu from "@/components/common/PopperMenu";
import SlidingToggle from "@/components/common/SlidingToggle";
import OnboardingTray from "@/components/header/OnboardingTray";
import StatusDot from "@/components/header/StatusDot";
import WhatsNewPopper from "@/components/header/WhatsNewPopper";
import JobsPopper from "@/components/jobs/JobsPopper";
import ContentDeleteModal from "@/components/modals/ContentDelete";
import Metadata from "@/components/modals/Metadata";
import ProjectShareDialog from "@/components/modals/content/ProjectShareDialog";
import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";

import { Toolbar } from "./Toolbar";

export type HeaderProps = {
  title?: string;
  showHambugerMenu?: boolean;
  onMenuIconClick?: () => void;
  height?: number;
  mapHeader?: boolean;
  project?: Project;
  viewOnly?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (key: string, value: any, refresh?: boolean) => void;
};

export default function Header(props: HeaderProps) {
  const theme = useTheme();
  const { map } = useMap();
  const { t, i18n } = useTranslation(["common"]);
  const { onMenuIconClick, showHambugerMenu, height = 52, title, project, onProjectUpdate, viewOnly } = props;
  const { organization } = useOrganization();
  const { isOrgAdmin } = useAuthZ();
  const { userProfile } = useUserProfile();
  const isLoggedIn = !!userProfile;
  const dateLocale = useDateFnsLocale();
  const lng = i18n.language === "de" ? "/de" : "";
  const dispatch = useAppDispatch();

  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [isEditingProjectMetadata, setIsEditingProjectMetadata] = useState(false);
  const [showDeleteProjectDialog, setShowDeleteProjectDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showSaveTemplateDialog, setShowSaveTemplateDialog] = useState(false);
  const mapMode = useAppSelector((state) => state.map.mapMode);

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
    const commonMenuItems = [
      {
        id: "report_issue",
        icon: ICON_NAME.BUG,
        label: t("common:report_an_issue"),
        group: "help",
        onClick: () => {
          window.open("mailto:info@plan4better.de?subject=GOAT%20Support%20Request");
        },
      },
      {
        id: "privacy_policy",
        icon: ICON_NAME.COOKIES,
        label: t("common:privacy_policy"),
        group: "privacy",
        onClick: () => {
          window.open(`${WEBSITE_URL}${lng}/about-us/privacy`, "_blank");
        },
      },
    ];

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

      {project && props.mapHeader && showShareDialog && (
        <ProjectShareDialog project={project} onClose={() => setShowShareDialog(false)} />
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

      <Toolbar
        showHambugerMenu={showHambugerMenu}
        onMenuIconClick={onMenuIconClick}
        height={height}
        LeftToolbarChild={
          <>
            {!props.mapHeader && (
              <Link
                href="/home"
                style={{
                  width: "32px",
                  height: "32px",
                  cursor: "pointer",
                }}>
                <Box
                  sx={{
                    transition: "transform 0.2s ease-in-out",
                    "&:hover": {
                      transform: "scale(1.1)",
                    },
                  }}>
                  <GOATLogoIconOnlyGreen style={{ width: "32px", height: "32px", cursor: "pointer" }} />
                </Box>
              </Link>
            )}
            {props.mapHeader && (
              <>
                <MoreMenu
                  menuItems={mapMenuItems}
                  disablePortal={false}
                  menuButton={
                    <Button
                      color="secondary"
                      endIcon={
                        <Icon
                          iconName={ICON_NAME.CHEVRON_DOWN}
                          style={{ fontSize: "14px", color: "inherit" }}
                        />
                      }
                      sx={{
                        textTransform: "none",
                        borderRadius: 1,
                        ml: -2,
                        my: 4,
                        "&:hover": {
                          color: theme.palette.primary.main,
                        },
                      }}
                      size="small"
                      variant="text">
                      <GOATLogoIconOnlyGreen style={{ width: "32px", height: "32px", cursor: "pointer" }} />
                    </Button>
                  }
                />

                <Divider orientation="vertical" flexItem />
              </>
            )}
            <EditableTypography
              variant="body1"
              fontWeight="bold"
              value={title || project?.name}
              readOnly={!props.mapHeader || !!title || viewOnly}
              isEditing={isEditingProjectName}
              onBlur={async (value) => {
                setIsEditingProjectName(false);
                if (value === project?.name || !project) return;
                await onProjectUpdate?.("name", value);
              }}
            />
            {props.mapHeader && <Divider orientation="vertical" flexItem />}
            {project?.updated_at && (
              <Typography variant="caption" noWrap>
                {`${t("common:last_saved")}: ${format(parseISO(project.updated_at), "hh:mma dd/MM/yyyy")
                  .replace("PM", " PM")
                  .replace("AM", " AM")}`}
              </Typography>
            )}
            {project?.tags &&
              project?.tags.map((tag) => (
                <Chip
                  variant="outlined"
                  label={tag}
                  key={tag}
                  sx={{
                    mx: theme.spacing(1),
                  }}
                />
              ))}
          </>
        }
        CenterToolbarChild={
          <>
            {props.mapHeader && !viewOnly && (
              <SlidingToggle
                options={[
                  { label: t("common:map"), value: "data" },
                  { label: t("common:workflows"), value: "workflows" },
                  { label: t("common:reports"), value: "reports" },
                  { label: t("common:builder"), value: "builder" },
                ]}
                activeOption={mapMode}
                onToggle={(value: "data" | "builder" | "reports" | "workflows") => {
                  dispatch(setSelectedLayers([]));
                  dispatch(setActiveRightPanel(undefined));
                  dispatch(setMapMode(value));
                }}
              />
            )}
          </>
        }
        RightToolbarChild={
          <>
            {!props.viewOnly && (
              <Stack direction="row" spacing={2} justifyContent="center" alignItems="center">
                {organization && organization.on_trial && isOrgAdmin && (
                  <Chip
                    icon={<Info />}
                    variant="outlined"
                    color="warning"
                    size="small"
                    label={
                      <Trans
                        i18nKey="common:your_trial_will_end_in"
                        values={{
                          expire_date: formatDistance(new Date(organization.plan_renewal_date), new Date(), {
                            locale: dateLocale,
                          }),
                        }}
                      />
                    }
                    sx={{
                      "& .MuiChip-label": {
                        fontWeight: "bold",
                        fontStyle: "normal",
                      },
                    }}
                    onClick={() => {
                      window.open(CONTACT_US_URL, "_blank");
                    }}
                  />
                )}
                {props.mapHeader && (
                  <>
                    <Divider orientation="vertical" flexItem />
                    <Stack sx={{ px: 4 }} spacing={2} direction="row">
                      <Button
                        startIcon={
                          <Icon iconName={ICON_NAME.GLOBE} style={{ fontSize: 16, color: "inherit" }} />
                        }
                        onClick={() => setShowShareDialog(true)}
                        variant="contained"
                        size="small">
                        <Typography variant="body2" color="inherit" fontWeight="bold">
                          {t("common:share")}
                        </Typography>
                      </Button>
                    </Stack>
                    <Divider orientation="vertical" flexItem />
                  </>
                )}

                {!props.mapHeader && <OnboardingTray />}
                {!props.mapHeader && <StatusDot />}
                {!props.mapHeader && <WhatsNewPopper />}
                <Tooltip title={t("common:open_documentation")}>
                  <IconButton
                    size="small"
                    onClick={() => {
                      window.open(`${DOCS_URL}${lng}`, "_blank");
                    }}>
                    <Icon iconName={ICON_NAME.BOOK} fontSize="inherit" />
                  </IconButton>
                </Tooltip>
                <JobsPopper />
                <Divider orientation="vertical" flexItem />
                <UserInfoMenu />
              </Stack>
            )}
            {props.viewOnly && isLoggedIn && (
              <Stack direction="row" spacing={2} justifyContent="center" alignItems="center">
                <Divider orientation="vertical" flexItem />
                <UserInfoMenu />
              </Stack>
            )}
          </>
        }
      />
    </>
  );
}
