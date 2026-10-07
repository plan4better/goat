"use client";

import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  IconButton,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { format, parseISO } from "date-fns";
import type { Locale } from "date-fns";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { useSWRConfig } from "swr";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import {
  SUPPORT_API_BASE_URL,
  downloadSupportAttachment,
  forgetSupportLists,
  postSupportReply,
  rateSupportTicket,
  reopenSupportTicket,
  resolveSupportTicket,
  updateSupportFollowers,
  useSupportColleagues,
  useSupportTicket,
} from "@/lib/api/support";
import { useUserProfile } from "@/lib/api/users";
import { SUPPORT_EMAIL } from "@/lib/constants";
import { supportReplyAgent } from "@/lib/support/agent";
import { supportAvatarSrc } from "@/lib/support/avatar";
import { supportErrorMessage } from "@/lib/support/errors";
import { prepareSupportHtml } from "@/lib/support/html";
import type { SupportMessage, SupportRating, SupportTicketDetail } from "@/lib/validations/support";

import { useDraft } from "@/hooks/support/useDraft";

import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import ToolPill from "@/components/dashboard/common/ToolPill";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import ContentKebab from "@/components/dashboard/content/ContentKebab";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import FilePicker, { FileTag } from "@/components/support/FilePicker";
import StatusChip from "@/components/support/StatusChip";
import {
  BackLink,
  CATEGORY_ICON,
  InlineNotice,
  RailLabel,
  SupportPage,
  useSupportMobile,
} from "@/components/support/SupportChrome";

/** Core's limit for a reply text. */
const REPLY_MAX_LENGTH = 50_000;

const when = (iso: string, locale: Locale) => format(parseISO(iso), "EEE d MMM, HH:mm", { locale });

/** "GOAT team" after an agent's name: a small primary-tinted pill, as the dashboard's count pills are drawn. */
const AgentBadge = () => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.2,
        lineHeight: 1.5,
        padding: "1px 8px",
        borderRadius: "999px",
        whiteSpace: "nowrap",
        backgroundColor: alpha(theme.palette.primary.main, 0.12),
        color: theme.palette.primary.main,
      }}>
      {t("support_goat_team")}
    </Box>
  );
};

const MessageCard = ({
  message,
  ticketRef,
  mobile,
  avatars,
}: {
  message: SupportMessage;
  ticketRef: string;
  mobile: boolean;
  avatars: SupportTicketDetail["avatars"];
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const locale = useDateFnsLocale();
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = useMemo(() => prepareSupportHtml(message.body_html), [message.body_html]);
  // A deleted contact leaves no name: a neutral label and an empty avatar.
  const name = message.is_me
    ? t("support_you")
    : message.author_known
      ? message.author_name
      : t("support_unknown_author");
  const avatarName = message.author_known ? message.author_name : "";
  return (
    <SurfaceCard hoverable={false} sx={{ p: mobile ? "12px 14px" : "14px 18px" }}>
      <Stack direction="row" spacing="10px" alignItems="center" sx={{ minWidth: 0 }}>
        <UserAvatar
          id={avatarName || "unknown"}
          name={avatarName}
          src={message.is_agent ? supportAvatarSrc(avatars, message.author_contact_id) : undefined}
          size={mobile ? 26 : 28}
        />
        <Stack
          direction="row"
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
          sx={{ flex: 1, minWidth: 0, columnGap: "8px", rowGap: "2px" }}>
          <Typography component="span" noWrap sx={{ fontSize: 13.5, fontWeight: 700, minWidth: 0 }}>
            {name}
          </Typography>
          {message.is_agent && <AgentBadge />}
        </Stack>
        {message.via === "email" && (
          <Tooltip title={t("support_via_email")} placement="top" disableInteractive>
            <Stack
              direction="row"
              spacing="4px"
              alignItems="center"
              sx={{ color: "text.secondary", flexShrink: 0 }}>
              <Icon iconName={ICON_NAME.EMAIL} style={{ fontSize: 12 }} htmlColor="inherit" />
              {!mobile && (
                <Typography component="span" sx={{ fontSize: 12 }}>
                  {t("support_via_email")}
                </Typography>
              )}
            </Stack>
          </Tooltip>
        )}
        <Typography component="span" sx={{ fontSize: 12, color: "text.secondary", flexShrink: 0 }}>
          {when(message.created_at, locale)}
        </Typography>
      </Stack>
      <Box
        sx={{
          mt: "10px",
          fontSize: 14,
          lineHeight: 1.6,
          wordBreak: "break-word",
          overflowX: "auto",
          "& p": { my: 0.5 },
          "& ul, & ol": { my: 0.5, pl: "22px" },
        }}>
        <Box dangerouslySetInnerHTML={{ __html: main }} />
        {quoted && (
          <>
            <Tooltip title={t("support_show_quoted")}>
              <IconButton
                size="small"
                aria-label={t("support_show_quoted")}
                aria-expanded={showQuoted}
                onClick={() => setShowQuoted(!showQuoted)}
                sx={{
                  mt: "6px",
                  height: 20,
                  px: "8px",
                  borderRadius: "6px",
                  border: `1px solid ${theme.palette.divider}`,
                  backgroundColor: theme.palette.action.hover,
                }}>
                <Icon iconName={ICON_NAME.ELLIPSIS} style={{ fontSize: 12 }} />
              </IconButton>
            </Tooltip>
            {showQuoted && (
              <Box
                sx={{ mt: "8px", color: "text.secondary", fontSize: 13 }}
                dangerouslySetInnerHTML={{ __html: quoted }}
              />
            )}
          </>
        )}
        {message.attachments.length > 0 && (
          <Stack direction="row" flexWrap="wrap" gap="6px" mt="12px">
            {message.attachments.map((a) => (
              <FileTag
                key={a.id}
                name={a.name}
                onClick={() =>
                  downloadSupportAttachment(ticketRef, a).catch((e) =>
                    toast.error(supportErrorMessage(t, e, { action: true }))
                  )
                }
              />
            ))}
          </Stack>
        )}
      </Box>
    </SurfaceCard>
  );
};

const RATING_ICON = { ko: ICON_NAME.XCLOSE, ok: ICON_NAME.CHECK, top: ICON_NAME.STAR } as const;

const RatingCard = ({ detail }: { detail: SupportTicketDetail }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [rating, setRating] = useState<SupportRating | null>(null);
  const [comment, setComment] = useState("");
  // What this visit just sent; otherwise the rating the user gave earlier (core reads it back).
  const [sentRating, setSentRating] = useState<SupportRating | null>(null);
  const [changing, setChanging] = useState(false);
  const given = sentRating ?? detail.my_rating ?? null;
  const closed = detail.ticket.status === "cancelled";
  // Core rejects ratings from admins who are not on the ticket (403), so only participants are asked.
  const canRate = detail.on_ticket && !closed;
  const askForRating = canRate && (given === null || changing);
  const accent = closed ? theme.palette.text.secondary : theme.palette.primary.main;
  return (
    <Box
      sx={{
        p: "16px 18px",
        borderRadius: "12px",
        border: `1px solid ${alpha(accent, 0.3)}`,
        // The tint over paper, not over the page background, so it stays a clean primary wash.
        backgroundColor: theme.palette.background.paper,
        backgroundImage: `linear-gradient(${alpha(accent, 0.07)}, ${alpha(accent, 0.07)})`,
      }}>
      <Stack direction="row" spacing="10px" alignItems="center">
        <Icon
          iconName={closed ? ICON_NAME.CLOSE : ICON_NAME.CIRCLECHECK}
          style={{ fontSize: 16 }}
          htmlColor={accent}
        />
        <Typography sx={{ fontSize: 14, fontWeight: 700 }}>
          {closed ? t("support_closed_title") : t("support_resolved_title")}
        </Typography>
      </Stack>
      {askForRating && (
        <Stack spacing="12px" mt="12px">
          <Typography sx={{ fontSize: 13.5 }}>{t("support_rate_question")}</Typography>
          <Stack direction="row" useFlexGap flexWrap="wrap" gap="8px">
            {(["ko", "ok", "top"] as const).map((r) => (
              <ToolPill
                key={r}
                icon={RATING_ICON[r]}
                label={t(`support_rating_${r}`)}
                active={rating === r}
                onClick={() => setRating(rating === r ? null : r)}
              />
            ))}
          </Stack>
          {rating && (
            <Stack direction="row" spacing="8px" alignItems="flex-start">
              <Box sx={{ flex: 1, minWidth: 0, color: "text.secondary" }}>
                <TextFieldInput
                  multiline
                  rows={2}
                  value={comment}
                  onChange={setComment}
                  placeholder={t("support_rating_comment")}
                  inputProps={{ maxLength: 2000, "aria-label": t("support_rating_comment") }}
                />
              </Box>
              <Button
                variant="contained"
                size="small"
                sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0, height: 40 }}
                onClick={async () => {
                  try {
                    await rateSupportTicket(detail.ticket.ref, rating, comment);
                    setSentRating(rating);
                    setChanging(false);
                    setRating(null);
                    setComment("");
                  } catch (e) {
                    toast.error(supportErrorMessage(t, e, { action: true }));
                  }
                }}>
                {t("support_send_feedback")}
              </Button>
            </Stack>
          )}
        </Stack>
      )}
      {canRate && !askForRating && given && (
        <Stack direction="row" useFlexGap flexWrap="wrap" alignItems="center" gap="10px" mt="8px">
          <Typography sx={{ fontSize: 13.5 }}>{t("support_feedback_thanks")}</Typography>
          <Box
            component="span"
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
              height: 30,
              px: "12px",
              borderRadius: "999px",
              fontSize: 13,
              fontWeight: 700,
              color: "primary.main",
              border: `1px solid ${theme.palette.primary.main}`,
              backgroundColor: alpha(theme.palette.primary.main, 0.12),
            }}>
            <Icon iconName={RATING_ICON[given]} style={{ fontSize: 13 }} />
            {t(`support_rating_${given}`)}
          </Box>
          <Button
            size="small"
            sx={{ textTransform: "none", fontWeight: 700, minWidth: 0 }}
            onClick={() => setChanging(true)}>
            {t("support_rating_change")}
          </Button>
        </Stack>
      )}
      <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: "10px" }}>
        {t("support_still_not_solved")}
      </Typography>
    </Box>
  );
};

/** One labelled value of the details card, drawn as the Content details panel draws its metadata rows. */
const DetailRow = ({
  icon,
  label,
  value,
  last,
}: {
  icon: ICON_NAME;
  label: string;
  value: string;
  last?: boolean;
}) => {
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      spacing="12px"
      alignItems="flex-start"
      sx={{ py: "9px", borderBottom: last ? "none" : `1px solid ${theme.palette.divider}` }}>
      <Box
        sx={{
          width: 28,
          height: 28,
          borderRadius: "6px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.palette.action.hover,
        }}>
        <Icon iconName={icon} style={{ fontSize: 13 }} htmlColor={theme.palette.primary.main} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component="div"
          sx={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.3px", color: "text.secondary" }}>
          {label}
        </Typography>
        <Typography
          component="div"
          sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }}>
          {value}
        </Typography>
      </Box>
    </Stack>
  );
};

/** A person on the ticket: avatar, name and what they are to it. */
const PersonRow = ({
  name,
  avatarName = name,
  avatarSrc,
  role,
  action,
}: {
  name: string;
  avatarSrc?: string;
  /** The person's real name, for the avatar's initials and colour, where `name` reads "You". */
  avatarName?: string;
  role: string;
  action?: ReactNode;
}) => (
  <Stack direction="row" spacing="10px" alignItems="center" sx={{ minWidth: 0 }}>
    <UserAvatar id={avatarName} name={avatarName} src={avatarSrc} size={28} />
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography noWrap component="div" sx={{ fontSize: 13.5, fontWeight: 600 }}>
        {name}
      </Typography>
      <Typography noWrap component="div" sx={{ fontSize: 12, color: "text.secondary" }}>
        {role}
      </Typography>
    </Box>
    {action}
  </Stack>
);

const SidePanel = ({ detail, onChanged }: { detail: SupportTicketDetail; onChanged: () => void }) => {
  const { t } = useTranslation("common");
  const router = useRouter();
  const locale = useDateFnsLocale();
  const { colleagues } = useSupportColleagues();
  const tk = detail.ticket;
  const [busy, setBusy] = useState(false);
  // By contact, not name: two colleagues can share a name. The customer has their own line.
  const onTicket = new Set([tk.customer_contact_id, ...detail.followers.map((f) => f.contact_id)]);
  const addable = colleagues.filter((c) => c.contact_id === null || !onTicket.has(c.contact_id));
  const change = async (
    update: { add_user_ids?: string[]; remove_contact_ids?: number[] },
    leave = false
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await updateSupportFollowers(tk.ref, update);
      void forgetSupportLists(); // leaving a ticket removes it from your list
      // Removing yourself ends your access; a refetch would only show "not found".
      if (leave) router.push("/support");
      else onChanged();
    } catch (e) {
      toast.error(supportErrorMessage(t, e, { action: true }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing="12px">
      <SurfaceCard hoverable={false} sx={{ p: "14px 16px" }}>
        <RailLabel>{t("support_handled_by")}</RailLabel>
        {tk.agent_name ? (
          <PersonRow
            name={tk.agent_name}
            avatarSrc={supportAvatarSrc(detail.avatars, detail.agent_contact_id)}
            role={t("support_goat_team")}
          />
        ) : (
          <Typography sx={{ fontSize: 13, color: "text.secondary", lineHeight: 1.5 }}>
            {t("support_not_picked_up")}
          </Typography>
        )}
      </SurfaceCard>
      <SurfaceCard hoverable={false} sx={{ p: "14px 16px" }}>
        <RailLabel>{t("support_people")}</RailLabel>
        <Stack spacing="10px">
          <PersonRow
            name={tk.is_mine ? t("support_you") : (tk.customer_name ?? "")}
            avatarName={tk.customer_name ?? undefined}
            role={t("support_opened_the_ticket")}
          />
          {detail.followers.map((f) => (
            <PersonRow
              key={f.contact_id}
              name={f.is_me ? t("support_you") : f.name}
              avatarName={f.name}
              role={t("support_following")}
              action={
                (detail.can_manage_people || f.is_me) && (
                  <Tooltip title={`${t("support_remove")} ${f.name}`}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`${t("support_remove")} ${f.name}`}
                        disabled={busy}
                        onClick={() => change({ remove_contact_ids: [f.contact_id] }, f.is_me)}>
                        <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 12 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                )
              }
            />
          ))}
        </Stack>
        {detail.can_manage_people && addable.length > 0 && (
          <Autocomplete
            size="small"
            sx={{ mt: "12px" }}
            options={addable}
            getOptionLabel={(c) => c.name}
            getOptionKey={(c) => c.user_id}
            renderOption={({ key, ...props }, c) => (
              <li key={key} {...props}>
                <Stack sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 14 }} noWrap>
                    {c.name}
                  </Typography>
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }} noWrap>
                    {c.email}
                  </Typography>
                </Stack>
              </li>
            )}
            value={null}
            blurOnSelect
            disabled={busy}
            onChange={(_, c) => {
              if (c) change({ add_user_ids: [c.user_id] });
            }}
            renderInput={(p) => <TextField {...p} placeholder={t("support_add_colleague")} />}
          />
        )}
        <Stack
          direction="row"
          spacing="6px"
          alignItems="flex-start"
          sx={{ mt: "12px", color: "text.secondary" }}>
          <Icon
            iconName={ICON_NAME.ORGANIZATION}
            style={{ fontSize: 12, marginTop: 2 }}
            htmlColor="inherit"
          />
          <Typography sx={{ fontSize: 12, lineHeight: 1.45 }}>{t("support_admins_see_all")}</Typography>
        </Stack>
      </SurfaceCard>
      <SurfaceCard hoverable={false} sx={{ p: "14px 16px 6px" }}>
        <RailLabel sx={{ mb: "2px" }}>{t("support_details")}</RailLabel>
        <DetailRow
          icon={CATEGORY_ICON[tk.category]}
          label={t("support_category")}
          value={t(`support_category_${tk.category}`)}
        />
        {tk.impact && (
          <DetailRow
            icon={ICON_NAME.BULLSEYE}
            label={t("support_impact")}
            value={t(`support_impact_${tk.impact}`)}
          />
        )}
        <DetailRow
          icon={ICON_NAME.CALENDAR}
          label={t("support_opened")}
          value={when(tk.created_at, locale)}
        />
        <DetailRow
          icon={ICON_NAME.CLOCK}
          label={t("support_last_update")}
          value={when(tk.updated_at, locale)}
          last
        />
      </SurfaceCard>
    </Stack>
  );
};

const TicketView = ({ ticketRef }: { ticketRef: string }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const mobile = useSupportMobile();
  const router = useRouter();
  const locale = useDateFnsLocale();
  const { mutate: globalMutate } = useSWRConfig();
  const { ticket: detail, error, mutate } = useSupportTicket(ticketRef);
  const { userProfile } = useUserProfile();
  // Per user, so a draft never shows up for someone else on a shared browser; no key until the user is known.
  const [reply, setReply, clearReply] = useDraft<string>(
    userProfile?.id ? `reply:${userProfile.id}:${ticketRef}` : null,
    ""
  );
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const statusRef = useRef(false);

  // Loading the ticket marks it read on the server, so the header badge must refetch its count.
  const loadedRef = detail?.ticket.ref;
  const messageCount = detail?.messages.length;
  useEffect(() => {
    if (loadedRef !== undefined) globalMutate(`${SUPPORT_API_BASE_URL}/summary`);
  }, [loadedRef, messageCount, globalMutate]);

  const back = <BackLink label={t("support_title")} onClick={() => router.push("/support")} />;

  if (!detail) {
    if (error?.status === 404)
      return (
        <SupportPage mobile={mobile}>
          {back}
          <Box sx={{ mt: 4 }}>
            <EmptyState icon={ICON_NAME.SEARCH} title={t("support_not_found")} />
          </Box>
        </SupportPage>
      );
    if (error)
      return (
        <SupportPage mobile={mobile}>
          {back}
          <Alert severity="warning" sx={{ mt: 4 }}>
            {t("support_unavailable", { email: SUPPORT_EMAIL })}
          </Alert>
        </SupportPage>
      );
    return (
      <SupportPage mobile={mobile}>
        <Box role="progressbar" aria-label={t("loading")}>
          <Skeleton variant="text" width={80} sx={{ fontSize: 14 }} />
          <Skeleton variant="text" width="45%" sx={{ fontSize: 24, mt: 2 }} />
          <Skeleton variant="text" width={240} sx={{ fontSize: 13, mb: 6 }} />
          <Box
            sx={{
              display: "grid",
              gap: 4,
              gridTemplateColumns: { xs: "minmax(0,1fr)", lg: "minmax(0,1fr) 320px" },
            }}>
            <Stack spacing="12px">
              {[120, 90, 90].map((height, index) => (
                <Skeleton key={index} variant="rounded" height={height} sx={{ borderRadius: "12px" }} />
              ))}
            </Stack>
            {!mobile && <Skeleton variant="rounded" height={260} sx={{ borderRadius: "12px" }} />}
          </Box>
        </Box>
      </SupportPage>
    );
  }
  const tk = detail.ticket;
  const isOpen = ["new", "in_progress", "waiting"].includes(tk.status);

  const send = async () => {
    if (sendingRef.current || (!reply.trim() && files.length === 0)) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await postSupportReply(tk.ref, reply, files);
      clearReply();
      setFiles([]);
      if (result.failed_files.length)
        toast.warning(t("support_failed_files", { files: result.failed_files.join(", ") }));
      void forgetSupportLists();
      await mutate();
    } catch (e) {
      toast.error(supportErrorMessage(t, e, { action: true }));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const setStatus = async (action: "resolve" | "reopen") => {
    if (statusRef.current) return;
    statusRef.current = true;
    setStatusBusy(true);
    try {
      await (action === "resolve" ? resolveSupportTicket(tk.ref) : reopenSupportTicket(tk.ref));
      void forgetSupportLists();
      await mutate();
    } catch (e) {
      toast.error(supportErrorMessage(t, e, { action: true }));
    } finally {
      statusRef.current = false;
      setStatusBusy(false);
    }
  };

  const statusLabel = isOpen ? t("support_mark_resolved") : t("support_reopen");
  const statusIcon = isOpen ? ICON_NAME.CHECK : ICON_NAME.REFRESH;

  return (
    <SupportPage mobile={mobile}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minHeight: 32 }}>
        {back}
        {/* On a phone the status change sits behind the kebab rather than as a
            wide button under the title, where a stray tap would close the ticket. */}
        {mobile && (
          <ContentKebab
            mobile
            items={[{ id: "status", label: statusLabel, icon: statusIcon, disabled: statusBusy }]}
            onSelect={() => setStatus(isOpen ? "resolve" : "reopen")}
          />
        )}
      </Stack>
      <Box sx={{ mt: "6px", mb: mobile ? "16px" : 6 }}>
        <PageHeader
          mobile={mobile}
          title={tk.subject}
          subtitle={
            <Box
              component="span"
              sx={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                columnGap: "10px",
                rowGap: "6px",
                mt: "6px",
              }}>
              <StatusChip ticket={tk} />
              <Box component="span" sx={{ fontSize: mobile ? 12 : 13 }}>
                #{tk.ref} ·{" "}
                {t("support_opened_by", {
                  name: tk.is_mine ? t("support_you") : tk.customer_name,
                  date: when(tk.created_at, locale),
                })}
              </Box>
            </Box>
          }
          action={
            mobile ? undefined : (
              <Button
                variant="outlined"
                disabled={statusBusy}
                startIcon={<Icon iconName={statusIcon} style={{ fontSize: 13 }} />}
                sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}
                onClick={() => setStatus(isOpen ? "resolve" : "reopen")}>
                {statusLabel}
              </Button>
            )
          }
        />
      </Box>

      <Box
        sx={{
          display: "grid",
          gap: mobile ? "12px" : 4,
          gridTemplateColumns: { xs: "minmax(0,1fr)", lg: "minmax(0,1fr) 320px" },
          alignItems: "start",
        }}>
        <Stack spacing="12px" sx={{ minWidth: 0 }}>
          {detail.messages.map((msg, index) => (
            // The ticket description comes first and has id 0 when it carries no files message: ids alone may repeat.
            <MessageCard
              key={`${msg.id}-${index}`}
              message={msg}
              ticketRef={tk.ref}
              mobile={mobile}
              avatars={detail.avatars}
            />
          ))}
          {!isOpen && <RatingCard detail={detail} />}
          <SurfaceCard
            hoverable={false}
            sx={{
              overflow: "hidden",
              ...(tk.needs_my_reply && { borderColor: alpha(theme.palette.warning.main, 0.6) }),
            }}>
            {tk.needs_my_reply && (
              <InlineNotice icon={ICON_NAME.CLOCK} tone="warning">
                {supportReplyAgent(tk)
                  ? t("support_waiting_banner", { agent: supportReplyAgent(tk) })
                  : t("support_waiting_banner_team")}
              </InlineNotice>
            )}
            {!detail.on_ticket && (
              <InlineNotice icon={ICON_NAME.ORGANIZATION} tone="neutral">
                {t("support_admin_note")}
              </InlineNotice>
            )}
            <TextField
              multiline
              minRows={mobile ? 3 : 4}
              fullWidth
              disabled={sending}
              inputProps={{ maxLength: REPLY_MAX_LENGTH }}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send()}
              placeholder={t("support_reply_placeholder")}
              sx={{
                "& fieldset": { border: "none" },
                "& .MuiInputBase-root": {
                  fontSize: 14,
                  lineHeight: 1.55,
                  px: mobile ? "14px" : "18px",
                  py: "14px",
                },
              }}
            />
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                px: mobile ? "8px" : "12px",
                py: "8px",
                borderTop: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.action.hover,
              }}>
              <Box flex={1} minWidth={0}>
                <FilePicker files={files} onChange={setFiles} compact />
              </Box>
              <LoadingButton
                variant="contained"
                onClick={send}
                loading={sending}
                disabled={!reply.trim() && files.length === 0}
                sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
                {t("support_send")}
              </LoadingButton>
            </Stack>
          </SurfaceCard>
        </Stack>
        <SidePanel detail={detail} onChanged={() => mutate()} />
      </Box>
    </SupportPage>
  );
};

export default TicketView;
