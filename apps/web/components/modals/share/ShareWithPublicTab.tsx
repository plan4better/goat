import { LoadingButton } from "@mui/lab";
import {
  Box,
  Button,
  FormControl,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material";
import { formatDistance } from "date-fns";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";
import { Loading } from "@p4b/ui/components/Loading";

import { useDateFnsLocale } from "@/i18n/utils";

import {
  assignDomainToProject,
  unassignDomainFromProject,
  useOrganizationDomains,
} from "@/lib/api/customDomains";
import { useProjectMap } from "@/lib/api/map";
import {
  setProjectAnalytics,
  setProjectTrackingRequireConsent,
  useOrganizationAnalytics,
} from "@/lib/api/organizationAnalytics";
import { publishProject, unpublishProject, useProjectLayers, usePublicProject } from "@/lib/api/projects";
import { useOrganization } from "@/lib/api/users";
import type { Project } from "@/lib/validations/project";

export interface ShareWithPublicTabProps {
  project: Project;
}

/** The tab's own section heading: the Public tab is a settings list, and the
 * groups (Address, Measurement, Embed, Take it offline) are what separate one
 * decision from the next. */
const SectionLabel = ({ children, first }: { children: string; first?: boolean }) => {
  const theme = useTheme();
  return (
    <Typography
      component="div"
      sx={{
        mt: first ? "2px" : "18px",
        mb: "8px",
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: "0.7px",
        textTransform: "uppercase",
        color: theme.palette.text.disabled,
      }}>
      {children}
    </Typography>
  );
};

/** Copies one value and says so for a moment. A pill rather than the
 * `CopyField` field+button pair, because both rows here already show what
 * they copy (the link inline, the embed code by description). */
const CopyPill = ({ value, label }: { value: string; label: string }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (copied) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      variant="outlined"
      onClick={() => void copy()}
      startIcon={
        <Icon iconName={copied ? ICON_NAME.CIRCLECHECK : ICON_NAME.COPY} style={{ fontSize: 12 }} />
      }
      sx={{
        flexShrink: 0,
        borderRadius: "999px",
        padding: "5px 12px",
        textTransform: "none",
        fontSize: 12.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
        color: copied ? theme.palette.primary.main : theme.palette.text.primary,
        borderColor: copied ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.24),
        backgroundColor: copied ? alpha(theme.palette.primary.main, 0.12) : "transparent",
      }}>
      {copied ? t("copied") : label}
    </Button>
  );
};

/** The layers whose style differs from the published snapshot, each with why (spec 13.2): edited in the project, or
 * its classes recomputed for new data. Republishing takes them over. */
const UnpublishedNote = ({ projectId }: { projectId: string }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { map } = useProjectMap(projectId);
  const { layers } = useProjectLayers(projectId);
  const changes = map?.unpublished ?? [];
  if (!changes.length) return null;
  const nameOf = (id: number) => layers?.find((layer) => layer.id === id)?.name ?? String(id);
  return (
    <Box
      sx={{
        mb: 3,
        px: 3,
        py: 2,
        borderRadius: "9px",
        backgroundColor: alpha(theme.palette.warning.main, 0.08),
        border: `1px solid ${alpha(theme.palette.warning.main, 0.27)}`,
      }}>
      <Typography component="div" sx={{ fontSize: 12.5, fontWeight: 700, mb: "4px" }}>
        {t("unpublished_changes")}
      </Typography>
      <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 4 }}>
        {changes.map((change) => (
          <Typography
            key={change.layer_project_id}
            component="li"
            sx={{ fontSize: 11.8, color: theme.palette.text.secondary, lineHeight: 1.45 }}>
            {t(`unpublished_reason_${change.reason}`, { name: nameOf(change.layer_project_id) })}
          </Typography>
        ))}
      </Stack>
      <Typography component="div" sx={{ fontSize: 11.8, color: theme.palette.text.secondary, mt: "4px" }}>
        {t("unpublished_changes_hint")}
      </Typography>
    </Box>
  );
};

/** One "label + explanation + control" row of the tab. */
const SettingRow = ({
  icon,
  iconColor,
  title,
  hint,
  control,
  dimmed,
}: {
  icon: ICON_NAME;
  iconColor?: string;
  title: string;
  hint: string;
  control: React.ReactNode;
  dimmed?: boolean;
}) => {
  const theme = useTheme();
  return (
    <Stack direction="row" alignItems="center" spacing={3} sx={{ opacity: dimmed ? 0.5 : 1 }}>
      <Icon iconName={icon} style={{ fontSize: 15, color: iconColor ?? theme.palette.text.secondary }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="div" sx={{ fontSize: 13, fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography
          component="div"
          sx={{ fontSize: 11.5, color: theme.palette.text.secondary, lineHeight: 1.45 }}>
          {hint}
        </Typography>
      </Box>
      {control}
    </Stack>
  );
};

/**
 * The Public tab: publishing a project as a snapshot anyone on the web can
 * open. It is the only audience that leaves the organization, so it carries
 * its own accent (the warning palette) rather than the brand green every
 * grant-based tab uses.
 *
 * Private, it is a single decision — one explanation and "Publish to web".
 * Published, it becomes the settings of a live page: where it is served from
 * (Address), whether visits are measured (Measurement), how to embed it, and
 * how to take it down again. GOAT has no password protection for public
 * pages, so the prototype's Protection section has no counterpart here.
 */
const ShareWithPublicTab: React.FC<ShareWithPublicTabProps> = ({ project }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { sharedProject, isLoading, mutate } = usePublicProject(project.id);
  const { mutate: mutateMap } = useProjectMap(project.id);
  const { organization } = useOrganization();
  const { domains: orgDomains, mutate: mutateOrgDomains } = useOrganizationDomains(
    organization?.id
  );
  const { analyticsList, mutate: mutateOrgAnalytics } = useOrganizationAnalytics(
    organization?.id
  );
  const [isPublishing, setIsPublishing] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [isCustomUrlBusy, setIsCustomUrlBusy] = useState(false);
  const [isTrackingBusy, setIsTrackingBusy] = useState(false);
  const [isConsentBusy, setIsConsentBusy] = useState(false);
  const dateLocale = useDateFnsLocale();
  const baseUrl = window.location.origin;
  const publicUrl = `${baseUrl}/map/public/${project.id}`;
  const embedCode = `<iframe src="${publicUrl}" width="100%" height="600" frameborder="0" style="max-width: 100%; border: 1px solid #EAEAEA; border-radius: 4px;"></iframe>`;

  const publicAccent = theme.palette.warning.main;
  const assignedDomainId = sharedProject?.custom_domain_id ?? null;
  const assignedAnalyticsId = sharedProject?.analytics_id ?? null;
  // Domains the user can pick:
  //   - cert is active (so it can actually serve traffic), AND
  //   - not already taken by a different project (the backend rejects
  //     double-assignment, so let's not surface options that error out).
  // The currently-assigned domain is always included so we can render its
  // option even if its cert later regresses (otherwise MUI warns about an
  // out-of-range value).
  const selectableDomains = useMemo(() => {
    const all = orgDomains ?? [];
    return all.filter((d) => {
      if (d.id === assignedDomainId) return true;
      if (d.cert_status !== "active") return false;
      const takenByOther =
        d.assigned_project_id != null && d.assigned_project_id !== project.id;
      return !takenByOther;
    });
  }, [orgDomains, assignedDomainId, project.id]);
  // Nothing to choose between: an organisation without a usable custom domain
  // is served from the GOAT address, and an empty picker says nothing.
  const showDomainPicker = selectableDomains.length > 0;

  const handleCustomUrlChange = async (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    setIsCustomUrlBusy(true);
    try {
      if (value === "" || value === "__none__") {
        await unassignDomainFromProject(project.id);
        toast.success(t("share_custom_url_unassign_success"));
      } else {
        await assignDomainToProject(project.id, value);
        const picked = selectableDomains.find((d) => d.id === value);
        toast.success(
          t("share_custom_url_assign_success", { domain: picked?.base_domain ?? "" })
        );
      }
      await mutate();
      await mutateOrgDomains();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("error_updating_share_access");
      toast.error(message);
    } finally {
      setIsCustomUrlBusy(false);
    }
  };

  const handleAnalyticsChange = async (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    const next = value === "__none__" ? null : value;
    setIsTrackingBusy(true);
    try {
      await setProjectAnalytics(project.id, next);
      toast.success(
        next ? t("share_tracking_enabled_success") : t("share_tracking_disabled_success")
      );
      await mutate();
      await mutateOrgAnalytics();
    } catch {
      toast.error(t("share_tracking_update_error"));
    } finally {
      setIsTrackingBusy(false);
    }
  };

  const handleConsentToggle = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    setIsConsentBusy(true);
    try {
      await setProjectTrackingRequireConsent(project.id, next);
      await mutate();
    } catch {
      toast.error(t("share_tracking_update_error"));
    } finally {
      setIsConsentBusy(false);
    }
  };

  const handlePublish = async () => {
    try {
      setIsPublishing(true);
      await publishProject(project.id);
      mutate();
      // The map request says again which layers differ from the new snapshot.
      void mutateMap();
    } catch {
      toast.error(t("error_publishing_project"));
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    try {
      setIsUnpublishing(true);
      await unpublishProject(project.id);
      // Drop the cached snapshot without a refetch: `GET .../public` answers
      // 404 once a project is unpublished, and SWR keeps the last successful
      // value through an errored revalidation — which left this tab claiming
      // "Published" until something else refilled the cache.
      await mutate(undefined, { revalidate: false });
    } catch {
      toast.error(t("error_unpublishing_project"));
    } finally {
      setIsUnpublishing(false);
    }
  };

  if (isLoading) {
    return (
      <Box
        sx={{
          minHeight: "80px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}>
        <Loading size={40} />
      </Box>
    );
  }

  if (!sharedProject) {
    return (
      <Stack alignItems="center" sx={{ textAlign: "center", py: 6, px: 4 }}>
        <Box
          sx={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            mb: 3,
            backgroundColor: alpha(publicAccent, 0.14),
          }}>
          <Icon iconName={ICON_NAME.GLOBE} style={{ fontSize: 24, color: publicAccent }} />
        </Box>
        <Typography component="div" sx={{ fontSize: 14.5, fontWeight: 800, mb: "5px" }}>
          {t("project_is_private")}
        </Typography>
        <Typography
          component="div"
          sx={{
            fontSize: 12.8,
            color: theme.palette.text.secondary,
            lineHeight: 1.6,
            maxWidth: 340,
            mb: 4,
          }}>
          <Trans i18nKey="common:publish_to_web_explanation" components={{ b: <b /> }} />
        </Typography>
        {/* `color="warning"` rather than an `sx` background: publishing to the
          * web is the one act that leaves the organization, and the palette
          * colour carries its own hover and contrast text. */}
        <LoadingButton
          variant="contained"
          color="warning"
          loading={isPublishing}
          onClick={handlePublish}
          startIcon={<Icon iconName={ICON_NAME.GLOBE} style={{ fontSize: 15 }} />}
          sx={{
            borderRadius: "999px",
            padding: "10px 22px",
            textTransform: "none",
            fontSize: 14,
            fontWeight: 700,
            boxShadow: "none",
            "&:hover": { boxShadow: "none" },
          }}>
          {t("publish_to_web")}
        </LoadingButton>
      </Stack>
    );
  }

  return (
    <Box sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={3} sx={{ mb: 3 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{
            height: 22,
            px: "10px",
            borderRadius: "999px",
            flexShrink: 0,
            backgroundColor: alpha(publicAccent, 0.14),
            border: `1px solid ${alpha(publicAccent, 0.27)}`,
          }}>
          <Icon iconName={ICON_NAME.GLOBE} style={{ fontSize: 12, color: publicAccent }} />
          <Typography component="span" sx={{ fontSize: 11.5, fontWeight: 800, color: publicAccent }}>
            {t("published")}
          </Typography>
        </Stack>
        <Typography
          component="span"
          sx={{ flex: 1, minWidth: 0, fontSize: 11.8, color: theme.palette.text.secondary }}>
          {t("snapshot_from", {
            time: formatDistance(new Date(sharedProject.updated_at), new Date(), {
              addSuffix: true,
              locale: dateLocale,
            }),
          })}
        </Typography>
        <LoadingButton
          variant="outlined"
          loading={isPublishing}
          disabled={isUnpublishing}
          onClick={handlePublish}
          startIcon={<Icon iconName={ICON_NAME.REFRESH} style={{ fontSize: 12 }} />}
          sx={{
            flexShrink: 0,
            borderRadius: "999px",
            padding: "5px 12px",
            textTransform: "none",
            fontSize: 12.5,
            fontWeight: 700,
            color: theme.palette.text.primary,
            borderColor: alpha(theme.palette.text.primary, 0.24),
          }}>
          {t("republish")}
        </LoadingButton>
      </Stack>
      <UnpublishedNote projectId={project.id} />

      <SectionLabel first>{t("address")}</SectionLabel>
      {showDomainPicker && (
        <FormControl fullWidth size="small">
          <Select
            value={assignedDomainId ?? "__none__"}
            disabled={isCustomUrlBusy}
            onChange={handleCustomUrlChange}
            renderValue={(selected) =>
              selected === "__none__"
                ? new URL(baseUrl).host
                : (selectableDomains.find((d) => d.id === selected)?.base_domain ?? "")
            }
            sx={{ borderRadius: "9px" }}>
            <MenuItem value="__none__">
              <Stack>
                <Typography variant="body2">{new URL(baseUrl).host}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t("goat_default_domain")}
                </Typography>
              </Stack>
            </MenuItem>
            {selectableDomains.map((domain) => (
              <MenuItem key={domain.id} value={domain.id}>
                <Typography variant="body2">{domain.base_domain}</Typography>
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
      <Stack
        direction="row"
        alignItems="center"
        spacing={2.5}
        sx={{
          mt: showDomainPicker ? 2 : 0,
          padding: "9px 12px",
          borderRadius: "10px",
          border: `1px solid ${alpha(publicAccent, 0.2)}`,
          backgroundColor: alpha(publicAccent, 0.14),
        }}>
        <Icon iconName={ICON_NAME.LINK} style={{ fontSize: 14, color: publicAccent }} />
        <Typography
          component="a"
          href={publicUrl}
          target="_blank"
          rel="noreferrer"
          noWrap
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          sx={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: theme.palette.text.primary,
            textDecoration: "none",
            "&:hover": { textDecoration: "underline" },
          }}>
          {publicUrl}
        </Typography>
        <CopyPill value={publicUrl} label={t("copy_link")} />
      </Stack>

      <SectionLabel>{t("measurement")}</SectionLabel>
      {analyticsList.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {t("share_analytics_empty")}
        </Typography>
      ) : (
        <>
          <FormControl fullWidth size="small">
            <Select
              value={assignedAnalyticsId ?? "__none__"}
              disabled={isTrackingBusy}
              onChange={handleAnalyticsChange}
              renderValue={(selected) =>
                !selected || selected === "__none__"
                  ? t("share_analytics_none")
                  : (analyticsList.find((a) => a.id === selected)?.name ?? "")
              }
              sx={{ borderRadius: "9px" }}>
              <MenuItem value="__none__">
                <Typography variant="body2">{t("share_analytics_none")}</Typography>
              </MenuItem>
              {analyticsList.map((instance) => {
                const otherCount =
                  instance.usage_count - (instance.id === assignedAnalyticsId ? 1 : 0);
                return (
                  <MenuItem key={instance.id} value={instance.id}>
                    <Stack>
                      <Typography variant="body2">{instance.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {(instance.config as { url?: string }).url}
                        {otherCount > 0 &&
                          ` — ${t("share_analytics_used_by_hint", { count: otherCount })}`}
                      </Typography>
                    </Stack>
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>
          <Box sx={{ mt: 2 }}>
            <SettingRow
              icon={ICON_NAME.CIRCLEINFO}
              title={t("cookie_consent_banner")}
              hint={assignedAnalyticsId ? t("cookie_consent_ask_first") : t("cookie_consent_not_needed")}
              dimmed={!assignedAnalyticsId}
              control={
                <Switch
                  checked={!!assignedAnalyticsId && sharedProject.tracking_require_consent !== false}
                  disabled={isConsentBusy || !assignedAnalyticsId}
                  onChange={handleConsentToggle}
                  inputProps={{ "aria-label": t("cookie_consent_banner") }}
                />
              }
            />
            {assignedAnalyticsId && sharedProject.tracking_require_consent === false && (
              <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ mt: 2, pl: 7 }}>
                <Icon
                  iconName={ICON_NAME.CIRCLEINFO}
                  htmlColor={publicAccent}
                  style={{ fontSize: 14, marginTop: 3, flexShrink: 0 }}
                />
                <Typography variant="caption" color="warning.main">
                  {t("share_consent_warning")}
                </Typography>
              </Stack>
            )}
          </Box>
        </>
      )}

      <SectionLabel>{t("embed")}</SectionLabel>
      <SettingRow
        icon={ICON_NAME.COPY}
        title={t("embed_code")}
        hint={t("embed_code_hint")}
        control={<CopyPill value={embedCode} label={t("copy")} />}
      />

      <SectionLabel>{t("take_it_offline")}</SectionLabel>
      <SettingRow
        icon={ICON_NAME.GLOBE}
        iconColor={theme.palette.error.main}
        title={t("unpublish")}
        hint={t("unpublish_hint")}
        control={
          <LoadingButton
            variant="outlined"
            color="error"
            loading={isUnpublishing}
            disabled={isPublishing}
            onClick={handleUnpublish}
            sx={{
              flexShrink: 0,
              borderRadius: "999px",
              padding: "6px 14px",
              textTransform: "none",
              fontSize: 12.5,
              fontWeight: 700,
              borderColor: alpha(theme.palette.error.main, 0.4),
            }}>
            {t("unpublish")}
          </LoadingButton>
        }
      />
    </Box>
  );
};

export default ShareWithPublicTab;
