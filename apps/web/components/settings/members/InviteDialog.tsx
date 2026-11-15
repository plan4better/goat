"use client";

import { Alert, Box, Stack, useTheme } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import * as z from "zod";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { detailOf, statusOf } from "@/lib/api/apiError";
import { inviteMember } from "@/lib/api/organizations";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { warningTextInk } from "@/components/modals/content/ContentDialogChrome";
import EmailChipsInput from "@/components/settings/common/EmailChipsInput";
import RadioCardGroup, { type RadioCardOption } from "@/components/settings/common/RadioCardGroup";
import { type AssignableRole, roleWords } from "@/components/settings/common/roleWords";
import { type Pool, type Seats, inviteRoleState } from "@/components/settings/members/seats";

const PLAIN = { interpolation: { escapeValue: false } } as const;
/** One request per address: a send of more is refused before it starts. */
const MAX_ADDRESSES = 20;
const isEmail = (address: string) => z.string().email().safeParse(address).success;
const tooFewKey = (role: AssignableRole) =>
  role === "organization-viewer"
    ? "settings_members_too_few_viewer_seats"
    : "settings_members_too_few_editor_seats";

/**
 * "Mitglieder einladen": several addresses (one request each, one after the
 * other, F10), one role for all of them, the seat pools in view. What went
 * out leaves the field; what failed stays, red, with its reason.
 */
export default function InviteDialog({
  organizationId,
  organizationName,
  seats,
  known,
  onClose,
  onChanged,
}: {
  organizationId: string;
  organizationName: string;
  seats: Seats;
  /** Addresses of members and open invitations, trimmed and lowercased. */
  known: Set<string>;
  onClose: () => void;
  /** Reads the list and the organization again (after every send). */
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const words = roleWords(t);
  // EmailChipsInput hands over its addresses trimmed and lowercased, so they
  // key `problems` and `failures` as they are and compare with `known`.
  const [addresses, setAddresses] = useState<string[]>([]);
  const [role, setRole] = useState<AssignableRole>(() => inviteRoleState(seats, 1).defaultRole);
  /** The line of each address whose send failed, by address. */
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const invalid = addresses.filter((address) => !isEmail(address));
  const knownHere = addresses.filter((address) => isEmail(address) && known.has(address));
  const valid = addresses.filter((address) => isEmail(address) && !known.has(address));
  const state = inviteRoleState(seats, valid.length);
  const pool: Pool = role === "organization-viewer" ? seats.viewers : seats.editors;
  const poolOk = role === "organization-viewer" ? state.viewersOk : state.editorsOk;

  // The first problem that applies (one line, as the spec orders them).
  const problem = invalid.length
    ? t("settings_members_invalid", { count: invalid.length, addresses: invalid.join(", "), ...PLAIN })
    : knownHere.length
      ? t("settings_members_known", { count: knownHere.length, addresses: knownHere.join(", "), ...PLAIN })
      : !poolOk
        ? t(tooFewKey(role), { count: pool.free ?? 0, people: valid.length })
        : addresses.length > MAX_ADDRESSES
          ? t("settings_members_invite_limit")
          : null;

  // A failure of an address the list knows by now (invited from elsewhere
  // meanwhile) is not repeated in red: the amber line and its chip say it.
  const failed = Object.keys(failures).filter(
    (address) => addresses.includes(address) && !known.has(address)
  );
  const problems: Record<string, string> = {
    ...Object.fromEntries(invalid.map((address) => [address, t("settings_members_reason_invalid")])),
    ...Object.fromEntries(knownHere.map((address) => [address, t("settings_members_reason_known")])),
    ...Object.fromEntries(failed.map((address) => [address, t("settings_members_reason_failed")])),
  };
  const canSend = valid.length > 0 && !problem && !sending;

  const figure = (poolOf: Pool) =>
    poolOf.total === null ? (
      t("settings_members_no_limit")
    ) : (
      <Box
        component="span"
        sx={{
          color: poolOf.free === 0 ? warningTextInk(theme) : "text.secondary",
        }}>
        {t("settings_members_seats_free", { free: poolOf.free, total: poolOf.total })}
      </Box>
    );
  const option = (value: AssignableRole, ok: boolean, poolOf: Pool): RadioCardOption<AssignableRole> => ({
    value,
    label: words[value].word,
    line: words[value].description,
    figure: figure(poolOf),
    disabled: !ok,
    disabledReason: ok
      ? undefined
      : t(tooFewKey(value), { count: poolOf.free ?? 0, people: Math.max(1, valid.length) }),
  });

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const sent: string[] = [];
    const manual: string[] = [];
    const lines: Record<string, string> = {};
    try {
      for (const email of valid) {
        try {
          const response = await inviteMember(organizationId, { user_email: email, role });
          const body = await response.json().catch(() => null);
          sent.push(email);
          if (body?.account_setup === "manual") manual.push(email);
          // It leaves the field at once: the refreshed list knows it now, and
          // the seat it took must not count against the addresses still to go.
          setAddresses((current) => current.filter((address) => address !== email));
        } catch (error) {
          const status = statusOf(error);
          const detail = detailOf(error);
          lines[email] =
            status === 400 && detail
              ? t("settings_members_invite_failed_detail", { email, detail, ...PLAIN })
              : status === 502
                ? t("settings_members_invite_failed_account", { email, ...PLAIN })
                : t("settings_members_invite_failed", { email, ...PLAIN });
        }
        // Every send changes the seats and the list.
        await onChanged();
      }
    } finally {
      setSending(false);
    }
    for (const email of manual) {
      toast.warning(
        t("settings_members_invite_manual", { email, text: t("member_invited_account_manual"), ...PLAIN })
      );
    }
    if (Object.keys(lines).length === 0) {
      onClose();
      return;
    }
    setFailures(lines);
  };

  const failureLines = failed.map((address) => failures[address]);
  const notice =
    failureLines.length || problem ? (
      <Stack spacing={2}>
        {failureLines.length > 0 && (
          <Alert severity="error" role="alert">
            {failureLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </Alert>
        )}
        {problem && (
          <Alert severity="warning" role="alert">
            {problem}
          </Alert>
        )}
      </Stack>
    ) : undefined;

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.ADD_USER}
      title={t("settings_members_invite_title")}
      subtitle={t("settings_members_invite_subtitle", { organization: organizationName, ...PLAIN })}
      maxWidth={600}
      closeDisabled={sending}
      notice={notice}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={sending}
          primaryLabel={
            valid.length > 1
              ? t("settings_members_invite_send_n", { n: valid.length })
              : t("settings_members_invite_send")
          }
          primaryDisabled={!canSend}
          primaryLoading={sending}
          onPrimary={() => void send()}
        />
      }>
      <Stack spacing={5} sx={{ pt: 1 }}>
        <EmailChipsInput
          id="invite-emails"
          label={t("settings_members_invite_emails")}
          value={addresses}
          onChange={(next) => {
            setAddresses(next);
            setFailures((current) =>
              Object.fromEntries(Object.entries(current).filter(([address]) => next.includes(address)))
            );
          }}
          problems={problems}
          placeholder={t("settings_members_invite_placeholder")}
          placeholderMore={t("settings_members_invite_placeholder_more")}
          help={t("settings_members_invite_help")}
          onSubmitEmpty={() => void send()}
          disabled={sending}
        />
        <RadioCardGroup<AssignableRole>
          label={t("settings_members_invite_role")}
          value={role}
          onChange={setRole}
          options={[
            option("organization-admin", state.editorsOk, seats.editors),
            option("organization-editor", state.editorsOk, seats.editors),
            option("organization-viewer", state.viewersOk, seats.viewers),
          ]}
        />
      </Stack>
    </AppDialog>
  );
}
