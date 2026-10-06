import { zodResolver } from "@hookform/resolvers/zod";
import { Box, DialogContentText, MenuItem, Stack, TextField, useTheme } from "@mui/material";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { inviteMember } from "@/lib/api/organizations";
import { useOrganization } from "@/lib/api/users";
import type { InvitationCreate } from "@/lib/validations/organization";
import { invitationCreateSchema, organizationRoles } from "@/lib/validations/organization";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

/** Ties the footer's primary to the form, so Enter in a field sends the
 * invite the way the in-body submit button used to. */
const FORM_ID = "invite-org-member-form";

interface OrgMemberInviteDialogProps {
  onClose: () => void;
  open: boolean;
  onInvite?: () => void;
}

const OrgMemberInviteModal: React.FC<OrgMemberInviteDialogProps> = ({ open, onClose, onInvite }) => {
  const theme = useTheme();
  const { t } = useTranslation(["common"]);

  const { organization } = useOrganization();
  const [isBusy, setIsBusy] = useState(false);

  const { register, handleSubmit, reset, formState, getValues } = useForm<InvitationCreate>({
    mode: "onChange",
    resolver: zodResolver(invitationCreateSchema),
    defaultValues: {
      user_email: "",
      role:
        organization &&
        (organization.total_editors == null || organization.used_editors < organization.total_editors)
          ? organizationRoles.EDITOR
          : organizationRoles.VIEWER,
    },
  });

  const onOrganizationMemberInvite = async () => {
    try {
      onInvite?.();
      if (!organization) return;
      setIsBusy(true);
      const payload = getValues();
      const response = await inviteMember(organization.id, payload);
      const invitation = await response.json().catch(() => null);
      // "manual": the login account was created but its set-password email
      // could not be sent, so an administrator has to set the password.
      if (invitation?.account_setup === "manual") {
        toast.warning(t("common:member_invited_account_manual"));
      } else {
        toast.success(t("common:member_invited_success"));
      }
    } catch {
      toast.error(t("common:member_invite_error"));
    } finally {
      setIsBusy(false);
      reset();
      onClose();
    }
  };

  const isRoleDisabled = (role: string) => {
    if (!organization) return true;
    if (
      (role === organizationRoles.ADMIN || role === organizationRoles.EDITOR) &&
      organization.total_editors != null &&
      organization.used_editors >= organization.total_editors
    )
      return true;
    if (
      role === organizationRoles.VIEWER &&
      organization.total_viewers != null &&
      organization.used_viewers >= organization.total_viewers
    )
      return true;
    return false;
  };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      icon={ICON_NAME.ADD_USER}
      title={t("common:invite_member")}
      maxWidth={600}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("common:send_invite")}
          onPrimary={() => void handleSubmit(onOrganizationMemberInvite)()}
          primaryType="submit"
          primaryForm={FORM_ID}
          primaryDisabled={!formState.isValid}
          primaryLoading={isBusy}
        />
      }>
      <DialogContentText>{t("common:invite_member_description")}</DialogContentText>
      <Box component="form" id={FORM_ID} onSubmit={handleSubmit(onOrganizationMemberInvite)}>
        <Stack
          spacing={theme.spacing(6)}
          sx={{
            mt: 4,
          }}>
          <TextField
            fullWidth
            required
            label={t("common:invite_member_email")}
            {...register("user_email")}
            id="user_email"
          />

          <TextField
            select
            label={t("common:role")}
            defaultValue={getValues("role")}
            size="medium"
            {...register("role")}>
            {[organizationRoles.ADMIN, organizationRoles.EDITOR, organizationRoles.VIEWER].map((role) => (
              <MenuItem key={role} value={role} disabled={isRoleDisabled(role)}>
                {t(`common:${role}`)}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </Box>
    </AppDialog>
  );
};

export default OrgMemberInviteModal;
