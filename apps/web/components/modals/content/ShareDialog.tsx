"use client";

import { LoadingButton } from "@mui/lab";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  Skeleton,
  Switch,
  Tab,
  Tabs,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  BUNDLES_API_BASE_URL,
  type BundleRole,
  deleteBundleGrant,
  shareBundleGrant,
  useBundleGrants,
} from "@/lib/api/bundles";
import { refreshContentFeed, setRestricted } from "@/lib/api/content";
import {
  FOLDERS_API_BASE_URL,
  deleteFolderGrant,
  shareFolderGrant,
  useFolderGrants,
} from "@/lib/api/folders";
import { useOrganizationMembers } from "@/lib/api/organizations";
import { useProject, useProjectLayers } from "@/lib/api/projects";
import { shareLayer, shareProject, useItemShares } from "@/lib/api/share";
import { useTeams } from "@/lib/api/teams";
import {
  addTemplateGrant,
  deleteTemplateGrant,
  refreshTemplates,
  useTemplate,
  useTemplateGrants,
} from "@/lib/api/templates";
import { useOrganization } from "@/lib/api/users";
import { folderPath, restrictedAncestorName, spaceIconFor } from "@/lib/utils/content";
import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";
import type { LayerSharedWith } from "@/lib/validations/layer";
import type { ProjectSharedWith } from "@/lib/validations/project";

import { canActOn } from "@/hooks/dashboard/content/useContentActions";

import {
  ContentDialogHeader,
  ContentDialogSubline,
  contentDialogPaperSx,
} from "@/components/modals/content/ContentDialogChrome";
import type { RolePrefix } from "@/components/modals/content/RolePicker";
import SharePeopleTab from "@/components/modals/content/SharePeopleTab";
import ShareTeamsTab from "@/components/modals/content/ShareTeamsTab";
import ShareDatasetPublicTab from "@/components/modals/share/ShareDatasetPublicTab";
import ShareWithPublicTab from "@/components/modals/share/ShareWithPublicTab";

interface ShareDialogProps {
  item: ContentItem;
  space: Space;
  folders: Folder[];
  onClose: () => void;
  onTransfer?: () => void;
}

interface ShareEntryState {
  id: string;
  role: string;
}

interface SharesState {
  users: ShareEntryState[];
  teams: ShareEntryState[];
  organizations: ShareEntryState[];
}

const EMPTY_SHARES: SharesState = { users: [], teams: [], organizations: [] };

/** The dialog keeps one height on every tab, and the tab body takes what the
 * header, the notes and the actions leave. Public has no notes and no
 * actions, so its body gets their room instead of the dialog shrinking. A
 * full-screen dialog on a small viewport fills the screen the same way. */
const DIALOG_HEIGHT = 566;

const ROLE_PREFIX: Record<ContentItem["type"], RolePrefix> = {
  layer: "layer",
  project: "project",
  folder: "folder",
  bundle: "bundle",
  template: "template",
};

/**
 * The Content page's Share dialog: People (layer/project only), Teams, and
 * — for a project — Public. Seeds its local `shares` state from whichever
 * source the item type actually has (the layer/project share endpoint, or a
 * folder's/bundle's grant list), lets each tab edit it, and saves it back
 * through the matching API on "Done".
 */
const ShareDialog = ({ item, space, folders, onClose, onTransfer }: ShareDialogProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("md"));

  const isLayerOrProject = item.type === "layer" || item.type === "project";
  const isFolder = item.type === "folder";
  const isBundle = item.type === "bundle";
  const isTemplate = item.type === "template";
  const rolePrefix = ROLE_PREFIX[item.type];

  const [tab, setTab] = useState(0);
  const [shares, setShares] = useState<SharesState>(EMPTY_SHARES);
  const [saving, setSaving] = useState(false);
  /** Whether `shares` holds the item's own grant list rather than the empty
   * seed. State, not a ref, because the primary action is gated on it. */
  const [sharesLoaded, setSharesLoaded] = useState(false);

  const { shares: itemShares, mutate: mutateItemShares } = useItemShares(
    item.type === "project" ? "project" : "layer",
    isLayerOrProject ? item.id : null
  );
  const { data: folderGrants } = useFolderGrants(isFolder ? item.id : null);
  const { data: bundleGrants } = useBundleGrants(isBundle ? item.id : null);
  const {
    grants: templateGrants,
    isLoading: templateGrantsLoading,
    mutate: mutateTemplateGrants,
  } = useTemplateGrants(isTemplate ? item.id : null);

  useEffect(() => {
    if (sharesLoaded) return;
    if (isLayerOrProject && itemShares) {
      setShares({
        users: (itemShares.users ?? []).map((entry) => ({ id: entry.id, role: entry.role })),
        teams: (itemShares.teams ?? []).map((entry) => ({ id: entry.id, role: entry.role })),
        organizations: (itemShares.organizations ?? []).map((entry) => ({ id: entry.id, role: entry.role })),
      });
      setSharesLoaded(true);
    } else if (isFolder && folderGrants) {
      setShares({
        users: [],
        teams: folderGrants.grants
          .filter((g) => g.grantee_type === "team")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
        organizations: folderGrants.grants
          .filter((g) => g.grantee_type === "organization")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
      });
      setSharesLoaded(true);
    } else if (isBundle && bundleGrants) {
      setShares({
        users: [],
        teams: bundleGrants.grants
          .filter((g) => g.grantee_type === "team")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
        organizations: bundleGrants.grants
          .filter((g) => g.grantee_type === "organization")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
      });
      setSharesLoaded(true);
    } else if (isTemplate && !templateGrantsLoading) {
      setShares({
        users: templateGrants
          .filter((g) => g.grantee_type === "user")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
        teams: templateGrants
          .filter((g) => g.grantee_type === "team")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
        organizations: templateGrants
          .filter((g) => g.grantee_type === "organization")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
      });
      setSharesLoaded(true);
    }
  }, [
    sharesLoaded,
    isLayerOrProject,
    itemShares,
    isFolder,
    folderGrants,
    isBundle,
    bundleGrants,
    isTemplate,
    templateGrants,
    templateGrantsLoading,
  ]);

  const { organization } = useOrganization();
  const { teams: teamsList } = useTeams();
  const { members } = useOrganizationMembers(organization?.id ?? "");
  const { layers: projectLayers } = useProjectLayers(item.type === "project" ? item.id : undefined);
  const { project: fullProject } = useProject(item.type === "project" ? item.id : undefined);

  // The nearest folder the item lives in — one hook call, not a walk up the
  // whole chain, per the grant model (a folder's grants already cascade to
  // its own children, so its own grants are the only ones worth surfacing).
  const folderChain = folderPath(folders, item.folder_id);
  const nearestFolder = folderChain[folderChain.length - 1];
  const { data: inheritedGrants } = useFolderGrants(!isFolder && nearestFolder ? nearestFolder.id : null);
  const showInheritedBanner = !isFolder && !!nearestFolder && (inheritedGrants?.grants.length ?? 0) > 0;

  const showDatasetsBanner = item.type === "project" && (projectLayers?.length ?? 0) > 0;

  // T6: a template's shipped datasets are the author's own, and a grant on
  // the template is not a grant on them — this says so with the count, so
  // the owner knows what else to share for the template to actually run.
  const { template } = useTemplate(isTemplate ? item.id : null);
  const shippedDatasetCount = (template?.inputs ?? []).filter(
    (input) => input.mode === "ship" && input.layer_id !== null && !input.public_read && !input.from_catalog
  ).length;

  // `canActOn` already requires owner and rules out a shortcut (which carries
  // its target's id, not the item's own) — restricting a shortcut would
  // silently restrict the wrong resource. A personal space has no members for
  // Restricted to narrow, so the toggle would be a no-op there. Catalog layers
  // have no flag on `ContentItem` distinguishing them here; the backend ignores
  // `restricted` for a catalog-backed layer, so the toggle is cosmetic-only for
  // them.
  const showRestrictedToggle = canActOn(item) && space.kind !== "personal";
  const [restricted, setRestrictedState] = useState(item.restricted);

  const handleToggleRestricted = async () => {
    const next = !restricted;
    setRestrictedState(next);
    try {
      await setRestricted(item.type, item.id, next);
      toast.success(t("restricted_updated"));
      refreshContentFeed();
    } catch {
      setRestrictedState(!next);
      toast.error(t("error_updating_restricted"));
    }
  };

  const setEntryRole = (bucket: keyof SharesState, id: string, role: string) => {
    setShares((prev) => {
      const items = prev[bucket];
      const exists = items.some((entry) => entry.id === id);
      let updated: ShareEntryState[];
      if (role === "") {
        updated = items.filter((entry) => entry.id !== id);
      } else if (exists) {
        updated = items.map((entry) => (entry.id === id ? { ...entry, role } : entry));
      } else {
        updated = [...items, { id, role }];
      }
      return { ...prev, [bucket]: updated };
    });
  };

  const orgEntry = shares.organizations.find((entry) => entry.id === organization?.id);
  const showOrganizationRow = space.kind !== "organization" && !!organization;
  const homeTeamId = space.kind === "team" ? space.team_id : null;
  const teamRows = teamsList
    .filter((team) => team.id !== homeTeamId)
    .map((team) => ({
      id: team.id,
      name: team.name,
      role: shares.teams.find((entry) => entry.id === team.id)?.role ?? "",
    }));

  const tabItems = useMemo(() => {
    const items = [
      { value: "people", label: t("people"), count: shares.users.length },
      { value: "teams", label: t("teams"), count: shares.teams.length + shares.organizations.length },
    ];
    if (isLayerOrProject) items.push({ value: "public", label: t("public"), count: 0 });
    return items;
  }, [isLayerOrProject, shares, t]);
  const activeTabValue = tabItems[tab]?.value;

  const kindLabel = space.kind === "team" ? t("team") : t("organization");
  const subline =
    space.kind === "personal"
      ? t("lives_in_my_content")
      : t("lives_in_space", { name: space.name, kind: kindLabel });

  /** Saving a layer/project sends all three grantee families whole, and the
   * backend reads a present-but-empty family as "clear it" — so Done stays
   * disabled until that item's own grants are actually in hand. A read that
   * failed never resolves them, and its empty list is indistinguishable from
   * "no grants", so it keeps the button disabled rather than letting a save
   * delete every grant. A folder/bundle/template save only diffs against its
   * loaded list — an unresolved one adds grants and removes none — so those
   * types are not gated. */
  const grantsUnresolved = isLayerOrProject && !sharesLoaded;

  const handleSave = async () => {
    if (grantsUnresolved) return;
    setSaving(true);
    try {
      if (isLayerOrProject) {
        const payload = {
          teams: shares.teams.filter((entry) => entry.role !== ""),
          organizations: shares.organizations.filter((entry) => entry.role !== ""),
          users: shares.users.filter((entry) => entry.role !== ""),
        };
        if (item.type === "layer") {
          await shareLayer(item.id, payload as LayerSharedWith);
        } else {
          await shareProject(item.id, payload as ProjectSharedWith);
        }
        // The layer/project grant list has its own SWR key, which
        // `refreshContentFeed` does not match — invalidate it so a dialog
        // reopened right after saving seeds from the saved grants, not the
        // cached pre-save ones.
        await mutateItemShares();
      } else if (isTemplate) {
        const newUsers = shares.users.filter((entry) => entry.role !== "");
        const newTeams = shares.teams.filter((entry) => entry.role !== "");
        const newOrgs = shares.organizations.filter((entry) => entry.role !== "");
        const keepKeys = new Set([
          ...newUsers.map((entry) => `user:${entry.id}`),
          ...newTeams.map((entry) => `team:${entry.id}`),
          ...newOrgs.map((entry) => `organization:${entry.id}`),
        ]);

        for (const entry of newUsers) {
          await addTemplateGrant(item.id, {
            grantee_type: "user",
            grantee_id: entry.id,
            role: entry.role as "template-viewer" | "template-editor",
          });
        }
        for (const entry of newTeams) {
          await addTemplateGrant(item.id, {
            grantee_type: "team",
            grantee_id: entry.id,
            role: entry.role as "template-viewer" | "template-editor",
          });
        }
        for (const entry of newOrgs) {
          await addTemplateGrant(item.id, {
            grantee_type: "organization",
            grantee_id: entry.id,
            role: entry.role as "template-viewer" | "template-editor",
          });
        }
        // Unlike folder/bundle grants (removed by grantee), a template grant
        // is removed by its own row id (T3/T6) — `deleteTemplateGrant` takes
        // the grant id, not the grantee id, so the pre-save list read here
        // is what supplies it.
        for (const grant of templateGrants) {
          if (!keepKeys.has(`${grant.grantee_type}:${grant.grantee_id}`)) {
            await deleteTemplateGrant(item.id, grant.id);
          }
        }
        await mutateTemplateGrants();
        refreshTemplates();
      } else {
        const oldGrants = isBundle ? (bundleGrants?.grants ?? []) : (folderGrants?.grants ?? []);
        const newTeams = shares.teams.filter((entry) => entry.role !== "");
        const newOrgs = shares.organizations.filter((entry) => entry.role !== "");
        const newTeamIds = new Set(newTeams.map((entry) => entry.id));
        const newOrgIds = new Set(newOrgs.map((entry) => entry.id));

        for (const team of newTeams) {
          if (isBundle) {
            await shareBundleGrant(item.id, {
              grantee_type: "team",
              grantee_id: team.id,
              role: team.role as BundleRole,
            });
          } else {
            await shareFolderGrant(item.id, {
              grantee_type: "team",
              grantee_id: team.id,
              role: team.role as "folder-viewer" | "folder-editor",
            });
          }
        }
        for (const org of newOrgs) {
          if (isBundle) {
            await shareBundleGrant(item.id, {
              grantee_type: "organization",
              grantee_id: org.id,
              role: org.role as BundleRole,
            });
          } else {
            await shareFolderGrant(item.id, {
              grantee_type: "organization",
              grantee_id: org.id,
              role: org.role as "folder-viewer" | "folder-editor",
            });
          }
        }
        for (const grant of oldGrants) {
          if (grant.grantee_type === "team" && !newTeamIds.has(grant.grantee_id)) {
            if (isBundle) await deleteBundleGrant(item.id, "team", grant.grantee_id);
            else await deleteFolderGrant(item.id, "team", grant.grantee_id);
          } else if (grant.grantee_type === "organization" && !newOrgIds.has(grant.grantee_id)) {
            if (isBundle) await deleteBundleGrant(item.id, "organization", grant.grantee_id);
            else await deleteFolderGrant(item.id, "organization", grant.grantee_id);
          }
        }
        // The grant list itself has its own SWR key (not covered by
        // `refreshContentFeed`'s content-list keys), so a dialog reopened
        // right after saving doesn't seed from the pre-save grants.
        if (isBundle) {
          mutate((key) => typeof key === "string" && key.startsWith(BUNDLES_API_BASE_URL));
        } else {
          mutate(
            (key) =>
              (typeof key === "string" && key.startsWith(FOLDERS_API_BASE_URL)) ||
              (Array.isArray(key) && typeof key[0] === "string" && key[0].startsWith(FOLDERS_API_BASE_URL))
          );
        }
      }
      refreshContentFeed();
      toast.success(t("share_access_updated_successfully"));
      onClose();
    } catch {
      toast.error(t("error_updating_share_access"));
    } finally {
      setSaving(false);
    }
  };

  const bandSx = {
    display: "flex",
    alignItems: "flex-start",
    gap: "9px",
    padding: "9px 22px 10px",
    flexShrink: 0,
    borderBottom: `1px solid ${theme.palette.divider}`,
    fontSize: 11.8,
    lineHeight: 1.5,
  } as const;

  return (
    <Dialog
      open
      onClose={onClose}
      fullScreen={fullScreen}
      PaperProps={{ sx: contentDialogPaperSx(500, fullScreen, { height: DIALOG_HEIGHT }) }}>
      <ContentDialogHeader
        icon={isFolder ? ICON_NAME.FOLDER : ICON_NAME.SHARE}
        title={t("share_item", { name: item.name })}
        subline={<ContentDialogSubline icon={spaceIconFor(space)}>{subline}</ContentDialogSubline>}
        onClose={onClose}
        closeLabel={t("close")}
        padding="17px 22px 11px"
      />

      <Box sx={{ padding: "0 22px", borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0 }}>
        <Tabs
          value={tab}
          onChange={(_event, next: number) => setTab(next)}
          sx={{
            minHeight: 0,
            "& .MuiTabs-indicator": { height: "2.5px" },
          }}>
          {tabItems.map((tabItem, index) => (
            <Tab
              key={tabItem.value}
              aria-label={tabItem.label}
              label={
                <Box sx={{ display: "inline-flex", alignItems: "center", gap: "7px" }}>
                  {tabItem.label}
                  {tabItem.count > 0 && (
                    <Box
                      component="span"
                      sx={{
                        fontSize: 11,
                        fontWeight: 800,
                        borderRadius: "999px",
                        padding: "0 7px",
                        // The catalog's own tabs mark an active count with
                        // `action.selected`; the dialog's follow suit.
                        backgroundColor:
                          tab === index ? theme.palette.action.selected : theme.palette.action.hover,
                        color: tab === index ? theme.palette.primary.main : theme.palette.text.secondary,
                      }}>
                      {tabItem.count}
                    </Box>
                  )}
                </Box>
              }
              sx={{
                minHeight: 0,
                minWidth: 0,
                padding: "10px 15px 12px",
                fontSize: 13.5,
                fontWeight: 700,
                textTransform: "none",
              }}
            />
          ))}
        </Tabs>
      </Box>

      {activeTabValue !== "public" && showDatasetsBanner && projectLayers && (
        <Box
          sx={{
            ...bandSx,
            alignItems: "center",
            backgroundColor: theme.palette.action.hover,
            color: "text.secondary",
          }}>
          <Icon iconName={ICON_NAME.DATABASE} style={{ fontSize: 13, color: theme.palette.text.secondary }} />
          <Box component="span">{t("project_shares_datasets_note", { count: projectLayers.length })}</Box>
        </Box>
      )}

      {activeTabValue !== "public" && isTemplate && shippedDatasetCount > 0 && (
        <Box
          sx={{
            ...bandSx,
            alignItems: "center",
            backgroundColor: theme.palette.action.hover,
            color: "text.secondary",
          }}>
          <Icon iconName={ICON_NAME.DATABASE} style={{ fontSize: 13, color: theme.palette.text.secondary }} />
          <Box component="span">{t("template_shares_datasets_note", { count: shippedDatasetCount })}</Box>
        </Box>
      )}

      {activeTabValue !== "public" && showInheritedBanner && nearestFolder && (
        <Box sx={{ ...bandSx, backgroundColor: alpha(theme.palette.primary.main, 0.12) }}>
          <Icon
            iconName={ICON_NAME.FOLDER}
            style={{ fontSize: 13, color: theme.palette.primary.main, marginTop: 2 }}
          />
          <Box component="span">
            <Trans
              i18nKey="common:inherited_via_folder"
              values={{ folder: nearestFolder.name }}
              components={{ b: <b /> }}
            />
          </Box>
        </Box>
      )}

      {activeTabValue !== "public" && showRestrictedToggle && (
        <Box
          sx={{ ...bandSx, alignItems: "center", gap: "11px", backgroundColor: theme.palette.action.hover }}>
          <Icon iconName={ICON_NAME.LOCK} style={{ fontSize: 14, color: theme.palette.text.secondary }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography component="div" sx={{ fontSize: 13, fontWeight: 600 }}>
              {t("restricted")}
            </Typography>
            <Typography component="div" sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.45 }}>
              {item.restricted_inherited ? (
                <Trans
                  i18nKey="common:restricted_inherited_note"
                  values={{ folder: restrictedAncestorName(folders, item.folder_id) }}
                  components={{ b: <b /> }}
                />
              ) : (
                t("restrict_toggle_hint")
              )}
            </Typography>
          </Box>
          <Switch
            size="small"
            checked={restricted}
            disabled={item.restricted_inherited}
            onChange={handleToggleRestricted}
            inputProps={{ "aria-label": t("restricted") }}
          />
        </Box>
      )}

      {isFolder && (
        <Typography sx={{ padding: "9px 22px 0", fontSize: 11.8, color: "text.secondary", flexShrink: 0 }}>
          {t("folder_share_cascade")}
        </Typography>
      )}

      <Box
        role="tabpanel"
        id={`simple-tabpanel-${activeTabValue}`}
        aria-labelledby={`simple-tab-${activeTabValue}`}
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: "12px 22px",
          overflow: activeTabValue === "public" ? "auto" : "hidden",
        }}>
        {activeTabValue === "people" && (
          <SharePeopleTab
            supported={isLayerOrProject || isTemplate}
            users={shares.users}
            members={members ?? []}
            organizationName={organization?.name ?? ""}
            rolePrefix={rolePrefix}
            onAdd={(memberId) => setEntryRole("users", memberId, `${rolePrefix}-viewer`)}
            onRoleChange={(memberId, role) => setEntryRole("users", memberId, role)}
          />
        )}
        {activeTabValue === "teams" && (
          <ShareTeamsTab
            organization={
              showOrganizationRow && organization
                ? {
                    id: organization.id,
                    name: organization.name,
                    role: orgEntry?.role ?? "",
                    memberCount: members?.length ?? 0,
                  }
                : undefined
            }
            teams={teamRows}
            rolePrefix={rolePrefix}
            onOrganizationRoleChange={(role) =>
              organization && setEntryRole("organizations", organization.id, role)
            }
            onTeamRoleChange={(teamId, role) => setEntryRole("teams", teamId, role)}
            onTransfer={onTransfer}
            showTransfer={space.kind === "personal" && !!onTransfer}
          />
        )}
        {activeTabValue === "public" &&
          item.type === "layer" && <ShareDatasetPublicTab item={item} canToggle={canActOn(item)} />}
        {activeTabValue === "public" &&
          item.type === "project" &&
          (fullProject ? (
            <ShareWithPublicTab project={fullProject} />
          ) : (
            <Skeleton variant="rectangular" height={200} />
          ))}
      </Box>

      {activeTabValue !== "public" && (
        <DialogActions
          sx={{ padding: "12px 22px", borderTop: `1px solid ${theme.palette.divider}`, gap: "10px" }}>
          <Button
            variant="text"
            onClick={onClose}
            sx={{ color: "text.secondary", fontSize: 14, fontWeight: 600, textTransform: "none" }}>
            {t("cancel")}
          </Button>
          <LoadingButton
            variant="contained"
            loading={saving}
            disabled={grantsUnresolved}
            onClick={handleSave}
            sx={{
              borderRadius: "999px",
              padding: "10px 22px",
              fontSize: 14,
              fontWeight: 700,
              textTransform: "none",
            }}>
            {t("done")}
          </LoadingButton>
        </DialogActions>
      )}
    </Dialog>
  );
};

export default ShareDialog;
