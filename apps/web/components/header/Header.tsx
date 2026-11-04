"use client";

import Info from "@mui/icons-material/Info";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import Divider from "@mui/material/Divider";
import { visuallyHidden } from "@mui/utils";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { GOATLogoIconOnlyGreen } from "@p4b/ui/assets/svg/GOATLogoIconOnlyGreen";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useFeatures, useOrganization, useUserProfile } from "@/lib/api/users";
import { useDockState } from "@/lib/assistant/store";
import { CONTACT_URL, privacyPolicyUrl } from "@/lib/constants";
import { setSelectedLayers } from "@/lib/store/layer/slice";
import { setMapMode } from "@/lib/store/map/slice";
import { setActiveRightPanel } from "@/lib/store/map/slice";
import { parseApiDate } from "@/lib/utils/credits";
import type { Project } from "@/lib/validations/project";

import { useAuthZ } from "@/hooks/auth/AuthZ";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import UserInfoMenu from "@/components/UserInfoMenu";
import AskAiButton from "@/components/assistant/AskAiButton";
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
import SupportMenu from "@/components/support/SupportMenu";
import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";

import { TOOLBAR_HEIGHT, Toolbar } from "./Toolbar";

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
  /** false: no Ask AI (the dashboard builder's preview, below the project header that has one). */
  askAi?: boolean;
};

export default function Header(props: HeaderProps) {
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down("md"));
  const belowXl = useMediaQuery(theme.breakpoints.down("xl"));
  // The docked dock takes width from the page (below md it opens full screen): the project
  // header's right-hand buttons show their icons alone, so they stay clear of the mode toggle.
  const dock = useDockState();
  const dockDocked = dock.enabled && dock.open && !dock.expanded && !isSmallScreen;
  const compactProjectActions = !!props.mapHeader && dockDocked;
  // Labelled as on Home where there is room; the icon alone on small screens, and in a project
  // header (with its centred mode toggle) beside the docked dock or in a window narrower than xl.
  const compactAskAi = isSmallScreen || (!!props.mapHeader && (dockDocked || belowXl));
  const askAi = props.askAi !== false && <AskAiButton compact={compactAskAi} />;
  const { map } = useMap();
  const { t, i18n } = useTranslation(["common"]);
  const {
    onMenuIconClick,
    showHambugerMenu,
    height = TOOLBAR_HEIGHT,
    title,
    project,
    onProjectUpdate,
    viewOnly,
  } = props;
  const { organization } = useOrganization();
  // trials exist only where billing is on (SaaS); a self-hosted install never shows the chip
  const { features } = useFeatures();
  const { isOrgAdmin } = useAuthZ();
  const { userProfile } = useUserProfile();
  const isLoggedIn = !!userProfile;
  const dateLocale = useDateFnsLocale();
  /** The trial notice in exact days (an extension shows at once); the compact header names it on its icon. */
  const trialEndsLabel = (renewal: string) => {
    const days = differenceInCalendarDays(parseApiDate(renewal), new Date());
    if (days < 0) return t("trial_expired");
    return days > 0 ? t("trial_days_left", { count: days }) : t("trial_ends_today");
  };
  const lng = i18n.language === "de" ? "/de" : "";
  const lastSaved = project?.updated_at
    ? `${t("common:last_saved")}: ${format(parseISO(project.updated_at), "Pp", { locale: dateLocale })}`
    : null;
  // Beside the docked dock the last save is the title's tooltip, and the description of the
  // title's input for keyboard and screen reader users (the tooltip describes only its wrapper).
  const lastSavedInTitle = compactProjectActions && !!lastSaved;
  const lastSavedId = useId();
  const dispatch = useAppDispatch();
  // Below `md` (`isSmallScreen`) the header has no room for another icon: the support entry moves
  // into the user menu. The header icon is hidden there by CSS, so the server-rendered first paint
  // (before the media query is known) never shows it on a phone; the user menu entries only render
  // once opened. Shown to everyone, read-only viewers included: without support tickets (or logged
  // out) it offers an email and the docs.
  const supportEntry = (
    <Box sx={{ display: { xs: "none", md: "inline-flex" } }}>
      <SupportMenu />
    </Box>
  );

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
        // The project menu (logo and chevron) or the logo link: never truncated away.
        leftMinWidth={props.mapHeader ? 64 : 32}
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
            {/* The title shrinks to an ellipsis inside the column; the last save beside it gives
                way first. Beside the docked dock the last save moves into the title's tooltip. */}
            <Tooltip title={lastSavedInTitle ? lastSaved : ""} describeChild>
              <Box sx={{ display: "flex", minWidth: 0 }}>
                <EditableTypography
                  variant="body1"
                  fontWeight="bold"
                  aria-describedby={lastSavedInTitle ? lastSavedId : undefined}
                  value={title || project?.name}
                  readOnly={!props.mapHeader || !!title || viewOnly}
                  isEditing={isEditingProjectName}
                  onBlur={async (value) => {
                    setIsEditingProjectName(false);
                    if (value === project?.name || !project) return;
                    await onProjectUpdate?.("name", value);
                  }}
                />
              </Box>
            </Tooltip>
            {lastSavedInTitle && (
              <Box component="span" id={lastSavedId} sx={visuallyHidden}>
                {lastSaved}
              </Box>
            )}
            {props.mapHeader && !compactProjectActions && <Divider orientation="vertical" flexItem />}
            {lastSaved && !compactProjectActions && (
              <Typography variant="caption" noWrap sx={{ flexShrink: 100 }}>
                {lastSaved}
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
                {features?.billing &&
                  organization?.on_trial &&
                  organization.plan_renewal_date &&
                  isOrgAdmin &&
                  (compactProjectActions ? (
                    <Tooltip title={trialEndsLabel(organization.plan_renewal_date)}>
                      <IconButton
                        size="small"
                        color="warning"
                        aria-label={trialEndsLabel(organization.plan_renewal_date)}
                        onClick={CONTACT_URL ? () => window.open(CONTACT_URL, "_blank") : undefined}>
                        <Info fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Chip
                      icon={<Info />}
                      variant="outlined"
                      color="warning"
                      size="small"
                      label={trialEndsLabel(organization.plan_renewal_date)}
                      title={t("trial_ends_on", {
                        date: format(parseApiDate(organization.plan_renewal_date), "PP", {
                          locale: dateLocale,
                        }),
                      })}
                      sx={{
                        "& .MuiChip-label": {
                          fontWeight: "bold",
                          fontStyle: "normal",
                        },
                      }}
                      onClick={
                        CONTACT_URL
                          ? () => {
                              window.open(CONTACT_URL, "_blank");
                            }
                          : undefined
                      }
                    />
                  ))}
                {props.mapHeader && (
                  <>
                    <Divider orientation="vertical" flexItem />
                    {compactProjectActions ? (
                      <Tooltip title={t("common:share")}>
                        <IconButton
                          size="small"
                          aria-label={t("common:share")}
                          onClick={() => setShowShareDialog(true)}
                          sx={{
                            bgcolor: "primary.main",
                            color: "primary.contrastText",
                            "&:hover": { bgcolor: "primary.dark" },
                          }}>
                          <Icon iconName={ICON_NAME.GLOBE} style={{ fontSize: 16, color: "inherit" }} />
                        </IconButton>
                      </Tooltip>
                    ) : (
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
                    )}
                    <Divider orientation="vertical" flexItem />
                  </>
                )}

                {!props.mapHeader && <OnboardingTray />}
                {!props.mapHeader && <StatusDot />}
                {!props.mapHeader && <WhatsNewPopper />}
                {askAi}
                {supportEntry}
                <JobsPopper />
                <Divider orientation="vertical" flexItem />
                <UserInfoMenu withSupport={isSmallScreen} />
              </Stack>
            )}
            {props.viewOnly && isLoggedIn && (
              <Stack direction="row" spacing={2} justifyContent="center" alignItems="center">
                {askAi}
                {supportEntry}
                <Divider orientation="vertical" flexItem />
                <UserInfoMenu withSupport={isSmallScreen} />
              </Stack>
            )}
          </>
        }
      />
    </>
  );
}
