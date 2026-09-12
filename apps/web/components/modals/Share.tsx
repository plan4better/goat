import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import {
  Avatar,
  Box,
  Button,
  Divider,
  List,
  ListItem,
  ListItemAvatar,
  ListItemSecondaryAction,
  ListItemText,
  Menu,
  MenuItem,
  MenuList,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import {
  BUNDLES_API_BASE_URL,
  type BundleRole,
  deleteBundleGrant,
  isBundleTile,
  shareBundleGrant,
  useBundleGrants,
} from "@/lib/api/bundles";
import { matchesContentListKey } from "@/lib/api/datasets";
import {
  FOLDERS_API_BASE_URL,
  deleteFolderGrant,
  shareFolderGrant,
  useFolderGrants,
} from "@/lib/api/folders";
import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import { shareLayer, shareProject } from "@/lib/api/share";
import { useTeams } from "@/lib/api/teams";
import { useOrganization } from "@/lib/api/users";
import { type Folder, folderShareRoleEnum } from "@/lib/validations/folder";
import { type Layer, layerShareRoleEnum } from "@/lib/validations/layer";
import { type Project, projectShareRoleEnum } from "@/lib/validations/project";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { CustomTabPanel, a11yProps } from "@/components/common/CustomTabPanel";
import ShareWithPublicTab from "@/components/modals/share/ShareWithPublicTab";

interface ShareProps {
  open: boolean;
  onClose?: () => void;
  type: "layer" | "project" | "folder";
  content: Layer | Project | Folder;
}

interface Item {
  id: string;
  name: string;
  avatar: string;
  role: string;
  inheritedRole?: string;
}

interface ShareWithItemsTabProps {
  items: Item[];
  roleOptions: string[];
  onRoleChange: (id: string, role: string) => void;
  disableInherited?: boolean;
}

const ShareWithItemsTab: React.FC<ShareWithItemsTabProps> = ({
  items,
  roleOptions,
  onRoleChange,
  disableInherited = false,
}) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const open = Boolean(anchorEl);
  const { t } = useTranslation("common");

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>, itemId: string) => {
    setAnchorEl(event.currentTarget);
    setSelectedItemId(itemId);
  };

  const handleClose = () => {
    setAnchorEl(null);
    setSelectedItemId(null);
  };

  const handleRoleChange = (role: string) => {
    if (selectedItemId) {
      onRoleChange(selectedItemId, role);
      handleClose();
    }
  };

  const getRoleTranslation = (role: string) => {
    if (role.includes("editor")) {
      return t("editor");
    } else if (role.includes("viewer")) {
      return t("viewer");
    }
  };

  return (
    <>
      <List disablePadding sx={{ width: "100%", bgcolor: "background.paper" }}>
        {items.map((item) => (
          <Stack key={item.id} justifyContent="center">
            <ListItem>
              <ListItemAvatar>
                <Avatar alt={item.name} src={item.avatar} />
              </ListItemAvatar>
              <ListItemText primary={item.name} />
              <ListItemSecondaryAction
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                }}>
                {item.inheritedRole && (
                  <Tooltip
                    title={disableInherited ? t("access_via_folder_disable_hint") : t("access_via_folder")}
                    placement="top">
                    <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
                      {t("via_folder")}
                    </Typography>
                  </Tooltip>
                )}
                <Button
                  variant="text"
                  sx={{ borderRadius: "4px" }}
                  size="small"
                  color="secondary"
                  disabled={disableInherited && Boolean(item.inheritedRole)}
                  onClick={(event) => handleClick(event, item.id)}
                  endIcon={<KeyboardArrowDownIcon color="inherit" />}>
                  <Typography variant="body2" fontWeight="bold" color="inherit">
                    {item.role
                      ? getRoleTranslation(item.role)
                      : item.inheritedRole
                        ? getRoleTranslation(item.inheritedRole)
                        : t("no_access")}
                  </Typography>
                </Button>
              </ListItemSecondaryAction>
            </ListItem>
            <Divider sx={{ mt: 0, pt: 0 }} />
          </Stack>
        ))}
      </List>
      <Menu
        id="role-select-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        MenuListProps={{
          "aria-labelledby": "role-select-button",
        }}>
        <MenuList dense>
          {roleOptions.map((role) => (
            <MenuItem
              sx={{ width: "110px" }}
              selected={
                selectedItemId ? items.find((item) => item.id === selectedItemId)?.role === role : false
              }
              key={role}
              onClick={() => handleRoleChange(role)}>
              {role ? getRoleTranslation(role) : t("no_access")}
            </MenuItem>
          ))}
        </MenuList>
      </Menu>
    </>
  );
};

const ShareModal: React.FC<ShareProps> = ({ open, onClose, type, content }) => {
  const { t } = useTranslation("common");
  const [isBusy, setIsBusy] = useState(false);
  const [value, setValue] = useState(0);
  const { organization: organization } = useOrganization();
  const { teams: teamsList } = useTeams();

  // Bundles share like folders (grant-based), not like layers.
  const isBundle = isBundleTile(content);

  const sharedWithContent = "shared_with" in content ? content.shared_with : undefined;
  const [sharedWith, setSharedWith] = useState(() => {
    const { teams = [], organizations = [] } = sharedWithContent || {};
    const mapToIdAndRole = (item) => ({ id: item.id, role: item.role });
    return {
      teams: teams.map(mapToIdAndRole),
      organizations: organizations.map(mapToIdAndRole),
    };
  });

  // For folders: fetch grants and sync into sharedWith once on open
  const { data: folderGrants } = useFolderGrants(type === "folder" && open ? content.id : null);

  // For bundles: same grant model as folders.
  const { data: bundleGrants } = useBundleGrants(isBundle && open ? content.id : null);

  // For layers and projects: fetch the folder's grants to show inherited access
  // read-only. Bundles flow through as type "layer" but share by their own
  // grants, so they are excluded here.
  const itemFolderId = isBundle
    ? null
    : type === "layer"
      ? (content as Layer).folder_id
      : type === "project"
        ? (content as Project).folder_id
        : null;
  const { data: layerFolderGrants, error: layerFolderGrantsError } = useFolderGrants(
    !isBundle && (type === "layer" || type === "project") && open && itemFolderId ? itemFolderId : null
  );
  const grantsLoaded = useRef(false);
  useEffect(() => {
    if (type === "folder" && folderGrants && !grantsLoaded.current) {
      setSharedWith({
        teams: folderGrants.grants
          .filter((g) => g.grantee_type === "team")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
        organizations: folderGrants.grants
          .filter((g) => g.grantee_type === "organization")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
      });
      grantsLoaded.current = true;
    }
  }, [type, folderGrants]);
  useEffect(() => {
    if (isBundle && bundleGrants && !grantsLoaded.current) {
      setSharedWith({
        teams: bundleGrants.grants
          .filter((g) => g.grantee_type === "team")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
        organizations: bundleGrants.grants
          .filter((g) => g.grantee_type === "organization")
          .map((g) => ({ id: g.grantee_id, role: g.role })),
      });
      grantsLoaded.current = true;
    }
  }, [isBundle, bundleGrants]);

  const handleChange = (_event: React.SyntheticEvent, newValue: number) => {
    setValue(newValue);
  };

  const tabItems = useMemo(() => {
    const items = [
      { label: t("organization"), value: "organization" },
      { label: t("teams"), value: "teams" },
    ];

    // Public only for projects
    if (type === "project") {
      items.push({ label: t("public"), value: "public" });
    }

    return items;
  }, [t, type]);

  const handleOnClose = () => {
    setIsBusy(false);
    grantsLoaded.current = false;
    onClose && onClose();
  };

  const organizationsAccessLevel: Item[] = useMemo(() => {
    if (!organization) {
      return [];
    }
    const sharedWitthOrg = sharedWith?.organizations;
    const inheritedOrgRole = layerFolderGrants?.grants.find(
      (g) => g.grantee_type === "organization" && g.grantee_id === organization.id
    )?.role;
    const accessLevels = [
      {
        id: organization.id,
        name: organization.name,
        avatar: organization.avatar as string,
        role: sharedWitthOrg?.find((org) => org.id === organization.id)?.role || "",
        inheritedRole: inheritedOrgRole,
      },
    ];
    return accessLevels;
  }, [organization, sharedWith, layerFolderGrants]);

  const teamsAccessLevel: Item[] = useMemo(() => {
    if (!teamsList) {
      return [];
    }
    const sharedWithTeams = sharedWith?.teams;
    const accessLevels = teamsList.map((team) => ({
      id: team.id,
      name: team.name,
      avatar: team.avatar as string,
      role: sharedWithTeams?.find((t) => t.id === team.id)?.role || "",
      inheritedRole: layerFolderGrants?.grants.find(
        (g) => g.grantee_type === "team" && g.grantee_id === team.id
      )?.role,
    }));
    return accessLevels;
  }, [teamsList, sharedWith, layerFolderGrants]);

  const roleOptions = useMemo(() => {
    if (isBundle) return ["bundle-editor", "bundle-viewer", ""];
    if (type === "layer") return [...layerShareRoleEnum.options, ""] as string[];
    if (type === "project") return [...projectShareRoleEnum.options, ""] as string[];
    if (type === "folder") return [...folderShareRoleEnum.options, ""] as string[];
    return [];
  }, [type, isBundle]);

  const handleSubmit = async () => {
    try {
      setIsBusy(true);
      if (isBundle) {
        // Grant-based, like folders: apply the added/changed grants, then remove
        // any that were cleared.
        const oldGrants = bundleGrants?.grants ?? [];
        const newTeams = (sharedWith.teams ?? []).filter((t) => t.role !== "");
        const newOrgs = (sharedWith.organizations ?? []).filter((o) => o.role !== "");
        const newTeamIds = new Set(newTeams.map((t) => t.id));
        const newOrgIds = new Set(newOrgs.map((o) => o.id));
        for (const team of newTeams) {
          await shareBundleGrant(content.id, {
            grantee_type: "team",
            grantee_id: team.id,
            role: team.role as BundleRole,
          });
        }
        for (const org of newOrgs) {
          await shareBundleGrant(content.id, {
            grantee_type: "organization",
            grantee_id: org.id,
            role: org.role as BundleRole,
          });
        }
        for (const grant of oldGrants) {
          if (grant.grantee_type === "team" && !newTeamIds.has(grant.grantee_id)) {
            await deleteBundleGrant(content.id, "team", grant.grantee_id);
          } else if (grant.grantee_type === "organization" && !newOrgIds.has(grant.grantee_id)) {
            await deleteBundleGrant(content.id, "organization", grant.grantee_id);
          }
        }
        mutate((key) => typeof key === "string" && key.startsWith(BUNDLES_API_BASE_URL));
      } else if (type === "project") {
        await shareProject(content.id, sharedWith);
        mutate((key) => Array.isArray(key) && key[0] === PROJECTS_API_BASE_URL);
      } else if (type === "layer") {
        await shareLayer(content.id, sharedWith);
        mutate(matchesContentListKey);
      } else if (type === "folder") {
        const oldGrants = folderGrants?.grants ?? [];
        const newTeams = (sharedWith.teams ?? []).filter((t) => t.role !== "");
        const newOrgs = (sharedWith.organizations ?? []).filter((o) => o.role !== "");
        const newTeamIds = new Set(newTeams.map((t) => t.id));
        const newOrgIds = new Set(newOrgs.map((o) => o.id));
        for (const team of newTeams) {
          await shareFolderGrant(content.id, {
            grantee_type: "team",
            grantee_id: team.id,
            role: team.role as "folder-viewer" | "folder-editor",
          });
        }
        for (const org of newOrgs) {
          await shareFolderGrant(content.id, {
            grantee_type: "organization",
            grantee_id: org.id,
            role: org.role as "folder-viewer" | "folder-editor",
          });
        }
        for (const grant of oldGrants) {
          if (grant.grantee_type === "team" && !newTeamIds.has(grant.grantee_id)) {
            await deleteFolderGrant(content.id, "team", grant.grantee_id);
          } else if (grant.grantee_type === "organization" && !newOrgIds.has(grant.grantee_id)) {
            await deleteFolderGrant(content.id, "organization", grant.grantee_id);
          }
        }
        mutate(
          (key) =>
            (typeof key === "string" && key.startsWith(FOLDERS_API_BASE_URL)) ||
            (Array.isArray(key) && typeof key[0] === "string" && key[0].startsWith(FOLDERS_API_BASE_URL))
        );
      }
      toast.success(t("share_access_updated_successfully"));
    } catch {
      toast.error(t("error_updating_share_access"));
    } finally {
      handleOnClose();
    }
  };

  const handleRoleChange = (type: "organizations" | "teams", id: string, role: string) => {
    setSharedWith((prevSharedWith) => {
      const items = prevSharedWith?.[type] || [];
      const itemExists = items.some((item) => item.id === id);

      let updatedItems;
      if (role === "") {
        // Remove the item if the role is an empty string
        updatedItems = items.filter((item) => item.id !== id);
      } else if (itemExists) {
        // Update the role if the item exists
        updatedItems = items.map((item) => {
          if (item.id === id) {
            return { ...item, role };
          }
          return item;
        });
      } else {
        // Add the item if it doesn't exist
        updatedItems = [...items, { id, role }];
      }

      return { ...prevSharedWith, [type]: updatedItems };
    });
  };
  const handleOrganizationRoleChange = (id: string, role: string) => {
    if (type === "folder" && role !== "") {
      // Clear all team grants when org is granted
      setSharedWith((prev) => ({ ...prev, teams: [] }));
    }
    handleRoleChange("organizations", id, role);
  };

  const handleTeamRoleChange = (id: string, role: string) => {
    if (type === "folder" && role !== "") {
      // Clear org grant when a team is granted
      setSharedWith((prev) => ({ ...prev, organizations: [] }));
    }
    handleRoleChange("teams", id, role);
  };

  // const isSharingUpdated = useMemo(() => {
  //   const { teams = [], organizations = [] } = content.shared_with || {};

  //   const sharedWithTeams = sharedWith.teams;
  //   const sharedWithOrgs = sharedWith.organizations;

  //   const isTeamsUpdated = sharedWithTeams
  //     ? sharedWithTeams.some((team) => {
  //         const existingTeam = teams.find((t) => t.id === team.id);
  //         return !existingTeam || existingTeam.role !== team.role;
  //       })
  //     : false;

  //   const isOrgsUpdated = sharedWithOrgs
  //     ? sharedWithOrgs.some((org) => {
  //         const existingOrg = organizations.find((o) => o.id === org.id);
  //         return !existingOrg || existingOrg.role !== org.role;
  //       })
  //     : false;

  //   return isTeamsUpdated || isOrgsUpdated;
  // }, [content.shared_with, sharedWith]);

  return (
    <AppDialog
      open={open}
      onClose={handleOnClose}
      icon={ICON_NAME.SHARE}
      title={t("manage_share_access_for_content", {
        content_type: isBundle
          ? t("bundle")
          : type === "layer"
            ? t("layer")
            : type === "project"
              ? t("project")
              : t("folder_label"),
        content_name: content.name,
      })}
      maxWidth={600}
      // The tab bar carries its own rule to the frame's edges; the tab bodies
      // pad themselves.
      bleed
      footer={
        // Public sharing saves itself inside its own tab, so the row is gone there.
        value !== 2 ? (
          <AppDialogFooter
            onCancel={handleOnClose}
            primaryLabel={t("save")}
            onPrimary={() => void handleSubmit()}
            primaryLoading={isBusy}
          />
        ) : undefined
      }>
      <Box sx={{ maxHeight: "500px" }}>
        <Box sx={{ width: "100%" }}>
          <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
            <Tabs value={value} scrollButtons onChange={handleChange}>
              {tabItems.map((item) => (
                <Tab key={item.value} label={item.label} {...a11yProps(item.value)} />
              ))}
            </Tabs>
          </Box>
          {tabItems.map((item) => (
            <CustomTabPanel
              disablePadding
              key={item.value}
              value={value}
              index={tabItems.findIndex((tab) => tab.value === item.value)}>
              {item.value === "organization" && (
                <>
                  {type === "folder" && sharedWith.teams.length > 0 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ px: 2, pt: 1, display: "block" }}>
                      {t("folder_share_conflict_warning")}
                    </Typography>
                  )}
                  {(type === "layer" || type === "project") && layerFolderGrantsError && itemFolderId && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ px: 2, pt: 1, display: "block" }}>
                      {t("folder_access_may_apply")}
                    </Typography>
                  )}
                  <ShareWithItemsTab
                    items={organizationsAccessLevel}
                    roleOptions={roleOptions}
                    onRoleChange={handleOrganizationRoleChange}
                    disableInherited={!isBundle && (type === "layer" || type === "project")}
                  />
                </>
              )}
              {item.value === "teams" && (
                <>
                  {type === "folder" && sharedWith.organizations.length > 0 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ px: 2, pt: 1, display: "block" }}>
                      {t("folder_share_conflict_warning")}
                    </Typography>
                  )}
                  {(type === "layer" || type === "project") && layerFolderGrantsError && itemFolderId && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ px: 2, pt: 1, display: "block" }}>
                      {t("folder_access_may_apply")}
                    </Typography>
                  )}
                  <ShareWithItemsTab
                    items={teamsAccessLevel}
                    roleOptions={roleOptions}
                    onRoleChange={handleTeamRoleChange}
                    disableInherited={!isBundle && (type === "layer" || type === "project")}
                  />
                </>
              )}
              {item.value === "public" && type === "project" && (
                // The panel drops its padding for the two edge-to-edge lists
                // above; this tab is sections and controls, so it gets it back.
                <Box sx={{ px: 3 }}>
                  <ShareWithPublicTab project={content as Project} />
                </Box>
              )}
            </CustomTabPanel>
          ))}
        </Box>
      </Box>
    </AppDialog>
  );
};

export default ShareModal;
