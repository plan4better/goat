"use client";

import { Alert, Box, Button, Skeleton, Stack, Typography, alpha, useTheme } from "@mui/material";
import { formatDistanceToNow, parseISO } from "date-fns";
import { notFound, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useSupportTickets } from "@/lib/api/support";
import { DOCS_URL, SUPPORT_EMAIL } from "@/lib/constants";
import { supportReplyAgent } from "@/lib/support/agent";
import { supportErrorMessage } from "@/lib/support/errors";
import { newTicketPath } from "@/lib/support/paths";
import type { SupportTicket } from "@/lib/validations/support";

import { useAuthZ } from "@/hooks/auth/AuthZ";

import CountPill from "@/components/dashboard/common/CountPill";
import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import SearchInput from "@/components/dashboard/common/SearchInput";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import ToolPill from "@/components/dashboard/common/ToolPill";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import StatusChip from "@/components/support/StatusChip";
import {
  CategoryMark,
  SegmentedToggle,
  SupportPage,
  useSupportMobile,
} from "@/components/support/SupportChrome";

/** `TicketRow`'s height, so the loading rows hold the space the real ones take. */
const ROW_HEIGHT = 62;
/** On a phone the status moves under the subject, so a row is a line taller. */
const MOBILE_ROW_HEIGHT = 70;

/** Column widths on desktop, shared by every row so status and last reply line up down the list. */
const columns = (orgScope: boolean) =>
  orgScope ? "minmax(0,1fr) 180px 170px 150px" : "minmax(0,1fr) 170px 150px";

const TicketRow = ({
  ticket,
  orgScope,
  mobile,
  onOpen,
}: {
  ticket: SupportTicket;
  orgScope: boolean;
  mobile: boolean;
  onOpen: () => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();
  const closed = ticket.status === "solved" || ticket.status === "cancelled";
  const updated = formatDistanceToNow(parseISO(ticket.updated_at), { addSuffix: true, locale: dateLocale });
  const lastBy = ticket.latest_message_author
    ? ticket.latest_message_is_agent
      ? `${ticket.latest_message_author} · ${t("support_goat_team")}`
      : ticket.latest_message_author
    : "";
  const opener = ticket.is_mine ? t("support_you") : (ticket.customer_name ?? "");
  return (
    <SurfaceCard
      hoverable={false}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      sx={{
        display: "grid",
        gridTemplateColumns: mobile ? "minmax(0,1fr)" : columns(orgScope),
        gap: "16px",
        alignItems: "center",
        minHeight: ROW_HEIGHT,
        boxSizing: "border-box",
        padding: mobile ? "11px 12px 11px 14px" : "11px 16px 11px 18px",
        cursor: "pointer",
        outline: "none",
        "&:hover": { borderColor: alpha(theme.palette.text.primary, 0.24) },
        "&:focus-visible": {
          borderColor: theme.palette.primary.main,
          boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}`,
        },
      }}>
      {/* The unread mark sits in the card's left padding, so read and unread rows align. */}
      <Box
        aria-label={ticket.unread ? t("support_unread") : undefined}
        sx={{
          position: "absolute",
          left: mobile ? 4 : 6,
          top: "50%",
          width: 7,
          height: 7,
          mt: "-3.5px",
          borderRadius: "50%",
          bgcolor: ticket.unread ? "primary.main" : "transparent",
        }}
      />
      <Stack direction="row" spacing="12px" alignItems={mobile ? "flex-start" : "center"} minWidth={0}>
        <CategoryMark category={ticket.category} muted={closed} size={mobile ? 32 : 34} />
        <Box minWidth={0} flex={1}>
          <Typography
            component="div"
            noWrap
            sx={{
              fontSize: mobile ? 14 : 13.5,
              fontWeight: ticket.unread ? 800 : 700,
              color: closed ? "text.secondary" : "text.primary",
            }}>
            {ticket.subject}
          </Typography>
          {mobile ? (
            <Stack direction="row" spacing="8px" alignItems="center" sx={{ mt: "5px", minWidth: 0 }}>
              <StatusChip ticket={ticket} />
              <Typography
                component="div"
                noWrap
                sx={{ fontSize: 11.5, color: "text.secondary", minWidth: 0 }}>
                #{ticket.ref} · {updated}
              </Typography>
            </Stack>
          ) : (
            <Typography component="div" noWrap sx={{ fontSize: 11.5, color: "text.secondary", mt: "1px" }}>
              #{ticket.ref} · {t(`support_category_${ticket.category}`)}
              {ticket.via === "email" ? ` · ${t("support_via_email")}` : ""}
            </Typography>
          )}
        </Box>
      </Stack>
      {orgScope && !mobile && (
        <Stack direction="row" spacing="8px" alignItems="center" minWidth={0}>
          <UserAvatar id={ticket.customer_name ?? opener} name={ticket.customer_name ?? opener} size={22} />
          <Typography noWrap sx={{ fontSize: 13 }}>
            {opener}
          </Typography>
        </Stack>
      )}
      {!mobile && (
        <Box sx={{ minWidth: 0, display: "flex" }}>
          <StatusChip ticket={ticket} />
        </Box>
      )}
      {!mobile && (
        <Box sx={{ textAlign: "right", minWidth: 0 }}>
          <Typography noWrap component="div" sx={{ fontSize: 12, fontWeight: 600 }}>
            {lastBy}
          </Typography>
          <Typography noWrap component="div" sx={{ fontSize: 12, color: "text.secondary" }}>
            {updated}
          </Typography>
        </Box>
      )}
    </SurfaceCard>
  );
};

/** Open / Closed, as the catalog's tabs: label, count pill, 3px underline on the active one. */
const TicketTabs = ({
  active,
  onChange,
  counts,
  mobile,
}: {
  active: "open" | "closed";
  onChange: (tab: "open" | "closed") => void;
  counts: Record<"open" | "closed", number | undefined>;
  mobile: boolean;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      role="tablist"
      sx={{ borderBottom: `1px solid ${theme.palette.divider}`, mb: mobile ? "14px" : 6, gap: 1 }}>
      {(["open", "closed"] as const).map((id) => {
        const selected = id === active;
        return (
          <Box
            component="button"
            type="button"
            role="tab"
            aria-selected={selected}
            key={id}
            onClick={() => onChange(id)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2.5,
              px: 1,
              py: mobile ? 2.5 : 3,
              mr: mobile ? 4 : 6,
              mb: "-1px",
              background: "transparent",
              border: "none",
              font: "inherit",
              fontSize: mobile ? 15 : 16,
              fontWeight: 700,
              letterSpacing: "-0.1px",
              cursor: "pointer",
              color: selected ? theme.palette.primary.main : theme.palette.text.primary,
              borderBottom: `3px solid ${selected ? theme.palette.primary.main : "transparent"}`,
            }}>
            {t(id === "open" ? "support_tab_open" : "support_tab_closed")}
            {counts[id] !== undefined && <CountPill active={selected}>{counts[id]}</CountPill>}
          </Box>
        );
      })}
    </Stack>
  );
};

const TicketList = () => {
  const { t } = useTranslation("common");
  const router = useRouter();
  const mobile = useSupportMobile();
  const { isOrgAdmin } = useAuthZ();
  const [scope, setScope] = useState<"mine" | "org">("mine");
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [search, setSearch] = useState("");
  const effectiveScope = isOrgAdmin ? scope : "mine";
  const open = useSupportTickets(effectiveScope, "open");
  const closed = useSupportTickets(effectiveScope, "closed");
  const current = tab === "open" ? open : closed;

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = current.tickets ?? [];
    return needle
      ? all.filter((x) => `${x.subject} #${x.ref} ${x.customer_name ?? ""}`.toLowerCase().includes(needle))
      : all;
  }, [current.tickets, search]);
  const waiting = (open.tickets ?? []).filter((x) => x.needs_my_reply);
  // Support is switched off on this installation: behave like a page that does not exist.
  if (open.error?.status === 404 || closed.error?.status === 404) notFound();
  // Server or network trouble (5xx, status 0) is "unavailable"; anything else (401, 403, 429...) gets its own message.
  const errors = [open.error, closed.error].filter((e) => e !== undefined);
  const isServerError = (status: number) => status === 0 || status >= 500;
  const unavailable = errors.some((e) => isServerError(e.status));
  const otherError = errors.find((e) => !isServerError(e.status));
  const failed = errors.length > 0;
  // Only a successful, empty answer for both lists means "no tickets yet".
  const empty =
    open.tickets !== undefined &&
    closed.tickets !== undefined &&
    open.tickets.length === 0 &&
    closed.tickets.length === 0;
  // The tab's list has not arrived yet: hold its place rather than claim it is empty.
  const loading = current.tickets === undefined;
  // Until both lists are known, neither the tabs with their counts nor "no tickets yet" is shown:
  // either could be wrong, and switching between them flickers.
  const known = open.tickets !== undefined && closed.tickets !== undefined;
  const orgScope = effectiveScope === "org";
  // From the support pages themselves: no page to name in the ticket's details.
  const newTicket = () => router.push(newTicketPath());

  const headerActions = mobile ? (
    <Stack direction="row" spacing="8px" alignItems="center">
      <ToolPill
        icon={ICON_NAME.BOOK}
        label={t("support_documentation")}
        iconOnly
        onClick={() => window.open(DOCS_URL, "_blank")}
      />
      <Button
        variant="contained"
        startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 13 }} />}
        sx={{ whiteSpace: "nowrap", flexShrink: 0, height: 38, textTransform: "none", fontWeight: 700 }}
        onClick={newTicket}>
        {t("support_new_ticket")}
      </Button>
    </Stack>
  ) : (
    <Stack direction="row" spacing="10px" alignItems="center">
      <Button
        variant="outlined"
        startIcon={<Icon iconName={ICON_NAME.BOOK} style={{ fontSize: 14 }} />}
        sx={{ whiteSpace: "nowrap", flexShrink: 0, textTransform: "none", fontWeight: 700 }}
        onClick={() => window.open(DOCS_URL, "_blank")}>
        {t("support_documentation")}
      </Button>
      <Button
        variant="contained"
        startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14 }} />}
        sx={{ whiteSpace: "nowrap", flexShrink: 0, textTransform: "none", fontWeight: 700 }}
        onClick={newTicket}>
        {t("support_new_ticket")}
      </Button>
    </Stack>
  );

  return (
    <SupportPage mobile={mobile}>
      <Box sx={{ mb: mobile ? "16px" : 8 }}>
        <PageHeader
          title={t("support_title")}
          subtitle={t("support_subtitle")}
          action={headerActions}
          mobile={mobile}
        />
      </Box>

      <Stack spacing={mobile ? "12px" : 4} sx={{ mb: unavailable || otherError || waiting.length ? 4 : 0 }}>
        {unavailable && (
          <Alert severity="warning">{t("support_unavailable", { email: SUPPORT_EMAIL })}</Alert>
        )}
        {!unavailable && otherError && <Alert severity="error">{supportErrorMessage(t, otherError)}</Alert>}

        {waiting.length > 0 && (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                sx={{ textTransform: "none", fontWeight: 700 }}
                onClick={() => router.push(`/support/${waiting[0].ref}`)}>
                {t("support_answer")}
              </Button>
            }>
            {waiting.length > 1
              ? t("support_banner_many", { count: waiting.length })
              : supportReplyAgent(waiting[0])
                ? t("support_banner_one", {
                    agent: supportReplyAgent(waiting[0]),
                    subject: waiting[0].subject,
                  })
                : t("support_banner_one_team", { subject: waiting[0].subject })}
          </Alert>
        )}
      </Stack>

      {!failed && !known ? (
        <Stack spacing="8px" role="progressbar" aria-label={t("loading")}>
          <Skeleton variant="rounded" height={36} width={220} sx={{ borderRadius: "8px", mb: 2 }} />
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton
              key={index}
              variant="rounded"
              height={mobile ? MOBILE_ROW_HEIGHT : ROW_HEIGHT}
              sx={{ borderRadius: "12px" }}
            />
          ))}
        </Stack>
      ) : !failed && empty ? (
        <EmptyState
          icon={ICON_NAME.HELP}
          title={t("support_empty_title")}
          hint={t("support_empty_text")}
          action={
            <Button
              variant="contained"
              startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14 }} />}
              sx={{ textTransform: "none", fontWeight: 700 }}
              onClick={newTicket}>
              {t("support_new_ticket")}
            </Button>
          }
        />
      ) : (
        !failed && (
          <>
            <TicketTabs
              active={tab}
              onChange={setTab}
              counts={{ open: open.tickets?.length, closed: closed.tickets?.length }}
              mobile={mobile}
            />
            <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" gap={2.5} sx={{ mb: 4 }}>
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("support_search")}
                collapsible={mobile && isOrgAdmin}
              />
              {isOrgAdmin && (
                <SegmentedToggle<"mine" | "org">
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "mine", label: t("support_scope_mine"), icon: ICON_NAME.USER },
                    { value: "org", label: t("support_scope_org"), icon: ICON_NAME.ORGANIZATION },
                  ]}
                />
              )}
            </Stack>
            {orgScope && (
              <Stack
                direction="row"
                spacing="8px"
                alignItems="flex-start"
                sx={{ mb: 3, color: "text.secondary" }}>
                <Icon
                  iconName={ICON_NAME.ORGANIZATION}
                  style={{ fontSize: 13, marginTop: 2 }}
                  htmlColor="inherit"
                />
                <Typography sx={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  {t("support_scope_org_hint")}
                </Typography>
              </Stack>
            )}
            {loading ? (
              <Stack spacing="8px" role="progressbar" aria-label={t("loading")}>
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton
                    key={index}
                    variant="rounded"
                    height={mobile ? MOBILE_ROW_HEIGHT : ROW_HEIGHT}
                    sx={{ borderRadius: "12px" }}
                  />
                ))}
              </Stack>
            ) : rows.length === 0 ? (
              <EmptyState
                compact
                icon={search ? ICON_NAME.SEARCH : tab === "open" ? ICON_NAME.CIRCLECHECK : ICON_NAME.FOLDER}
                title={
                  search
                    ? t("support_no_match")
                    : tab === "open"
                      ? t("support_nothing_open")
                      : t("support_no_closed")
                }
              />
            ) : (
              <Stack spacing="8px">
                {rows.map((ticket) => (
                  <TicketRow
                    key={ticket.ref}
                    ticket={ticket}
                    orgScope={orgScope}
                    mobile={mobile}
                    onOpen={() => router.push(`/support/${ticket.ref}`)}
                  />
                ))}
              </Stack>
            )}
          </>
        )
      )}
    </SupportPage>
  );
};

export default TicketList;
