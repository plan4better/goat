"use client";

import { LoadingButton } from "@mui/lab";
import { Alert, Box, Divider, Grid, Link, Stack, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  updateOrganizationInvitationRole,
  updateOrganizationMemberRole,
  useOrganizationMembers,
} from "@/lib/api/organizations";
import { useOrganization } from "@/lib/api/users";
import { CONTACT_URL } from "@/lib/constants";
import { invitationStatusEnum } from "@/lib/validations/invitation";
import type { OrganizationMember } from "@/lib/validations/organization";
import { organizationRoles, organizationRolesEnum } from "@/lib/validations/organization";

import type { OrgMemberActions } from "@/types/common";

import { useMemberSettingsMoreMenu } from "@/hooks/dashboard/SettingsHooks";

import QuotaStatus from "@/components/common/QuotaStatus";
import MembersTable from "@/components/dashboard/settings/MembersTable";
import OrgMemberInviteModal from "@/components/modals/settings/InviteOrgMember";
import OrgMemberDialogWrapper from "@/components/modals/settings/OrgMembersDialogWrapper";

const OrganizationMembers = () => {
  const theme = useTheme();
  const { organization, mutate: mutateOrganization } = useOrganization();
  const { members, mutate: mutateMembers } = useOrganizationMembers(organization?.id || "", {
    include_invitations: true,
  });
  const [isBusy, setIsBusy] = useState(false);

  const { t } = useTranslation("common");

  const {
    activeMemberMoreMenuOptions,
    pendingInvitationMoreMenuOptions,
    activeMember,
    moreMenuState,
    closeMoreMenu,
    openMoreMenu,
  } = useMemberSettingsMoreMenu("organization");

  const [openInviteModal, setOpenInviteModal] = useState(false);

  const isViewerQuotaFull = useMemo(() => {
    if (!organization) return false;
    return organization.total_viewers != null && organization.used_viewers >= organization.total_viewers;
  }, [organization]);

  const isEditorQuotaFull = useMemo(() => {
    if (!organization) return false;
    return organization.total_editors != null && organization.used_editors >= organization.total_editors;
  }, [organization]);

  const quotaStatus = useMemo(() => {
    if (!organization) return "";
    const isViewerQuotaFull =
      organization.total_viewers != null && organization.used_viewers >= organization.total_viewers;
    const isEditorQuotaFull =
      organization.total_editors != null && organization.used_editors >= organization.total_editors;

    const statuses = [] as string[];
    if (isViewerQuotaFull) statuses.push("Viewers");
    if (isEditorQuotaFull) statuses.push("Editors");

    return statuses.join(", ");
  }, [organization]);

  const disabledRoles = useMemo(() => {
    const roles = [] as string[];
    if (isViewerQuotaFull) roles.push(organizationRoles.VIEWER);
    if (isEditorQuotaFull) roles.push(organizationRoles.EDITOR, organizationRoles.ADMIN);
    return roles;
  }, [isViewerQuotaFull, isEditorQuotaFull]);

  const onRoleChange = async (memberId: string, role: string) => {
    setIsBusy(true);
    if (!organization) return;
    try {
      // Find if invitation_status is pending
      const member = members?.find((m) => m.id === memberId);
      if (member?.invitation_status === invitationStatusEnum.Enum.pending) {
        await updateOrganizationInvitationRole(organization?.id, memberId, role);
      } else {
        await updateOrganizationMemberRole(organization?.id, memberId, role);
      }
      mutateMembers();
      mutateOrganization();
      toast.success(t("member_role_updated_success"));
    } catch (error) {
      toast.error(t("member_role_update_error"));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Box sx={{ p: 4 }}>
      {activeMember && moreMenuState && (
        <OrgMemberDialogWrapper
          member={activeMember as OrganizationMember}
          action={moreMenuState.id as OrgMemberActions}
          onClose={closeMoreMenu}
          organizationId={organization?.id}
          onMemberDelete={() => {
            mutateMembers();
            mutateOrganization();
            closeMoreMenu();
          }}
        />
      )}
      <OrgMemberInviteModal
        open={openInviteModal}
        onClose={() => {
          setOpenInviteModal(false);
          mutateOrganization();
          mutateMembers();
        }}
        onInvite={() => {}}
      />
      <Box>
        {members && (
          <Stack spacing={theme.spacing(6)}>
            <Divider />
            <Box>
              <Typography variant="body1" fontWeight="bold">
                {t("organization_manage_users")}
              </Typography>
              <Typography variant="caption">{t("organization_manage_users_description")}</Typography>
            </Box>
            <Divider />
            {members?.length && organization && (
              <>
                <Box sx={{ flexGrow: 1 }}>
                  <Grid
                    container
                    alignItems="center"
                    spacing={0}
                    sx={{
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}>
                    <Grid item xs={12} md={4} sx={{ pl: 0, py: 4 }}>
                      <QuotaStatus
                        current={organization.used_viewers}
                        total={organization.total_viewers}
                        quotaLabel={
                          <Trans
                            i18nKey="common:viewers_quota_label"
                            values={{
                              current: organization.used_viewers,
                              total: organization.total_viewers ?? "∞",
                            }}
                            components={{
                              highlight: (
                                <span
                                  style={{
                                    color: isViewerQuotaFull
                                      ? theme.palette.warning.main
                                      : theme.palette.primary.main,
                                  }}
                                />
                              ),
                            }}
                          />
                        }
                        colorWhenFull={theme.palette.warning.main}
                      />
                    </Grid>
                    <Divider
                      orientation="vertical"
                      flexItem
                      sx={{
                        display: {
                          sm: "none",
                          md: "block",
                        },
                      }}
                    />
                    <Grid item xs={12} md={4} sx={{ pl: 0, py: 4 }}>
                      <QuotaStatus
                        current={organization.used_editors}
                        total={organization.total_editors}
                        quotaLabel={
                          <Trans
                            i18nKey="common:editors_quota_label"
                            values={{
                              current: organization.used_editors,
                              total: organization.total_editors ?? "∞",
                            }}
                            components={{
                              highlight: (
                                <span
                                  style={{
                                    color: isEditorQuotaFull
                                      ? theme.palette.warning.main
                                      : theme.palette.primary.main,
                                  }}
                                />
                              ),
                            }}
                          />
                        }
                        colorWhenFull={theme.palette.warning.main}
                      />
                    </Grid>
                    <Divider
                      orientation="vertical"
                      flexItem
                      sx={{
                        display: {
                          sm: "none",
                          md: "block",
                        },
                      }}
                    />
                    <Grid item xs={12} md="auto" sx={{ pl: 0, py: 4 }}>
                      <Stack alignItems="flex-end">
                        <LoadingButton
                          disabled={isViewerQuotaFull && isEditorQuotaFull}
                          variant="contained"
                          sx={{ whiteSpace: "nowrap" }}
                          onClick={() => setOpenInviteModal(true)}
                          startIcon={<Icon fontSize="small" iconName={ICON_NAME.PLUS} />}
                          name="send-invite">
                          {t("new_org_member")}
                        </LoadingButton>
                      </Stack>
                    </Grid>
                  </Grid>
                </Box>

                {(isViewerQuotaFull || isEditorQuotaFull) && (
                  <Alert severity="warning" sx={{ mt: 4 }}>
                    <Trans
                      i18nKey="common:organization_users_quota_alert"
                      values={{ role_type: quotaStatus }}
                      components={{
                        b: <b />,
                        anchor: CONTACT_URL ? (
                          <Link sx={{ fontWeight: "bold" }} target="_blank" href={CONTACT_URL} />
                        ) : (
                          <span />
                        ),
                      }}
                    />
                  </Alert>
                )}
              </>
            )}

            <MembersTable
              members={members}
              memberRoles={organizationRolesEnum.options}
              activeMemberMoreMenuOptions={activeMemberMoreMenuOptions}
              pendingInvitationMoreMenuOptions={pendingInvitationMoreMenuOptions}
              onMoreMenuItemClick={openMoreMenu}
              disabledRoles={disabledRoles}
              onRoleChange={onRoleChange}
              isBusy={isBusy}
              type="organization"
            />
          </Stack>
        )}
      </Box>
    </Box>
  );
};

export default OrganizationMembers;
