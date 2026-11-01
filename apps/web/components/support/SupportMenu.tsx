"use client";

import { Badge, Box, Divider, IconButton, Tooltip, useTheme } from "@mui/material";
import { formatDistanceToNow, parseISO } from "date-fns";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { refreshSupportTickets, useSupportSummary } from "@/lib/api/support";
import { useUserProfile } from "@/lib/api/users";
import { DOCS_URL } from "@/lib/constants";
import { supportReplyAgent } from "@/lib/support/agent";
import { reportProblemHref, supportTicketPath } from "@/lib/support/paths";
import { isRecentlyClosed } from "@/lib/support/unread";
import type { SupportTicket } from "@/lib/validations/support";

import { ArrowPopper } from "@/components/ArrowPoper";
import CountPill from "@/components/dashboard/common/CountPill";
import {
  HeaderPopoverExternalMark,
  HeaderPopoverHeader,
  HeaderPopoverList,
  HeaderPopoverRow,
} from "@/components/header/HeaderPopover";
import HeaderPopoverPaper, { HEADER_POPOVER_PLACEMENT } from "@/components/header/HeaderPopoverPaper";
import { statusColor } from "@/components/support/StatusChip";

export type SupportCounts = { needsReply: number; unread: number };

/** The one line that says what is waiting: tickets to answer win over merely unread ones. */
export const supportCountLabel = (
  t: (key: string, options: { count: number }) => string,
  { needsReply, unread }: SupportCounts
): string | undefined => {
  if (needsReply > 0) return t("support_to_answer", { count: needsReply });
  if (unread > 0) return t("support_unread_count", { count: unread });
  return undefined;
};

/** The user documentation in the UI language, as the header's book icon opens it. */
const docsUrl = (language: string): string => `${DOCS_URL}${language === "de" ? "/de" : ""}`;

/** At most this many tickets that need attention are listed in the popover. */
const MAX_ATTENTION_ROWS = 3;

/**
 * My tickets that wait for my answer (first) or hold a message I haven't seen: the open ones, and the
 * ones closed recently enough that the badge still counts their unread replies (see `isRecentlyClosed`).
 */
export const ticketsNeedingAttention = (
  open: SupportTicket[],
  closed: SupportTicket[] = [],
  now: number = Date.now()
): SupportTicket[] =>
  [...open, ...closed.filter((ticket) => ticket.unread && isRecentlyClosed(ticket, now))]
    .filter((ticket) => ticket.needs_my_reply || ticket.unread)
    .sort((a, b) => Number(b.needs_my_reply) - Number(a.needs_my_reply))
    .slice(0, MAX_ATTENTION_ROWS);

const AttentionRow = ({ ticket, onOpen }: { ticket: SupportTicket; onOpen: () => void }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();
  const when = formatDistanceToNow(parseISO(ticket.latest_message_at ?? ticket.updated_at), {
    addSuffix: true,
    locale: dateLocale,
  });
  return (
    <HeaderPopoverRow
      onClick={onOpen}
      icon={
        // As wide as a row's icon, so the subjects line up with the action labels below.
        <Box aria-hidden sx={{ width: 15, display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: statusColor(theme, ticket.status),
            }}
          />
        </Box>
      }
      label={ticket.subject}
      secondary={`#${ticket.ref} · ${supportReplyAgent(ticket) ?? t("support_goat_team")} · ${when}`}
    />
  );
};

/**
 * The actions every support entry offers, on desktop in the popover and on a phone in the user menu.
 * `counts` is `null` where there are no support tickets (not configured, logged out, or the summary
 * hasn't answered yet): then there is no ticket list and "Report a problem" writes an email instead.
 */
const SupportActionRows = ({
  counts,
  onNavigate,
}: {
  counts: SupportCounts | null;
  onNavigate: () => void;
}) => {
  const { t, i18n } = useTranslation("common");
  const router = useRouter();
  const pathname = usePathname();
  const go = (path: string) => {
    onNavigate();
    router.push(path);
  };
  const countLabel = counts ? supportCountLabel(t, counts) : undefined;
  const report = reportProblemHref(!!counts, pathname);
  return (
    <>
      {counts && (
        <HeaderPopoverRow
          icon={ICON_NAME.HELP}
          label={t("support_tickets")}
          trailing={countLabel ? <CountPill active>{countLabel}</CountPill> : undefined}
          onClick={() => go("/support")}
        />
      )}
      {report && (
        <HeaderPopoverRow
          icon={ICON_NAME.BUG}
          label={t("support_report_problem")}
          // The ticket form opens in the app; the email in the mail client.
          {...(counts ? { onClick: () => go(report) } : { href: report, onClick: onNavigate })}
        />
      )}
      <HeaderPopoverRow
        icon={ICON_NAME.BOOK}
        label={t("support_documentation")}
        href={docsUrl(i18n.language)}
        newTab
        trailing={<HeaderPopoverExternalMark />}
        onClick={onNavigate}
      />
    </>
  );
};

/** Header entry for support tickets, or for an email to the team where there are none; nothing on installations without support. */
const SupportMenu = () => {
  const { t } = useTranslation("common");
  const router = useRouter();
  const { userProfile } = useUserProfile();
  const { summary, enabled } = useSupportSummary({ enabled: !!userProfile });
  const [open, setOpen] = useState(false);
  const [tickets, setTickets] = useState<{ open: SupportTicket[]; closed: SupportTicket[] }>({
    open: [],
    closed: [],
  });
  const trigger = useRef<HTMLButtonElement>(null);
  // Without support tickets (support off, logged out, no answer yet) there is nothing to count.
  const needsReply = enabled ? (summary?.needs_reply ?? 0) : 0;
  const unread = enabled ? (summary?.unread ?? 0) : 0;
  const countLabel = supportCountLabel(t, { needsReply, unread });

  // The lists are fetched when the popover opens (the summary poll only carries counts), and what
  // comes back also feeds the ticket list page's cache. Closed ones too: the badge counts unread
  // replies on recently closed tickets.
  useEffect(() => {
    if (!open || !(needsReply > 0 || unread > 0)) return;
    let cancelled = false;
    void Promise.allSettled([refreshSupportTickets("open"), refreshSupportTickets("closed")]).then(
      ([openList, closedList]) => {
        if (cancelled) return;
        setTickets({
          open: openList.status === "fulfilled" ? openList.value : [],
          closed: closedList.status === "fulfilled" ? closedList.value : [],
        });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open, needsReply, unread]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    router.push(path);
  };
  const attention = needsReply > 0 || unread > 0 ? ticketsNeedingAttention(tickets.open, tickets.closed) : [];
  const label = countLabel ? `${t("support_title")}: ${countLabel}` : t("support_title");
  return (
    <ArrowPopper
      open={open}
      onClose={() => setOpen(false)}
      placement={HEADER_POPOVER_PLACEMENT}
      arrow={false}
      content={
        <HeaderPopoverPaper>
          <HeaderPopoverHeader title={t("support_title")} />
          <HeaderPopoverList>
            {attention.map((ticket) => (
              <AttentionRow
                key={ticket.ref}
                ticket={ticket}
                onOpen={() => go(supportTicketPath(ticket.ref))}
              />
            ))}
            {attention.length > 0 && <Divider sx={{ my: "4px" }} />}
            <SupportActionRows
              counts={enabled ? { needsReply, unread } : null}
              onNavigate={() => setOpen(false)}
            />
          </HeaderPopoverList>
        </HeaderPopoverPaper>
      }>
      <Tooltip title={label}>
        <IconButton
          ref={trigger}
          size="small"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          sx={open ? { color: "primary.main" } : undefined}>
          {needsReply > 0 ? (
            <Badge badgeContent={needsReply} color="warning">
              <Icon iconName={ICON_NAME.HELP} fontSize="inherit" />
            </Badge>
          ) : (
            <Badge variant="dot" color="primary" invisible={unread === 0}>
              <Icon iconName={ICON_NAME.HELP} fontSize="inherit" />
            </Badge>
          )}
        </IconButton>
      </Tooltip>
    </ArrowPopper>
  );
};

/** How many tickets wait for the user's answer or have a message they haven't seen, for a badge outside
 * the header's support icon (the user menu on a phone, where the header has no room for that icon);
 * `null` while support is off. */
export const useSupportCounts = (active: boolean): SupportCounts | null => {
  const { userProfile } = useUserProfile();
  const { summary, enabled } = useSupportSummary({ enabled: active && !!userProfile });
  return enabled ? { needsReply: summary?.needs_reply ?? 0, unread: summary?.unread ?? 0 } : null;
};

/**
 * Where "Report a problem" leads from the current page, as the support entry decides it (see
 * `reportProblemHref`); `null` where there is neither a ticket form nor a support email.
 */
export const useReportProblemHref = (): string | null => {
  const pathname = usePathname();
  return reportProblemHref(useSupportCounts(true) !== null, pathname);
};

/** The support entries as rows of the user menu: the phone's place for what `SupportMenu` offers on desktop.
 * `counts` is `null` without support tickets (see `SupportActionRows`). */
export const SupportMenuEntries = ({
  counts,
  onNavigate,
}: {
  counts: SupportCounts | null;
  onNavigate: () => void;
}) => <SupportActionRows counts={counts} onNavigate={onNavigate} />;

export default SupportMenu;
