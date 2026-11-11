"use client";

import { darken } from "@mui/material";
import type { Theme } from "@mui/material";
import { useTranslation } from "react-i18next";

import type { SupportStatus, SupportTicket } from "@/lib/validations/support";

import StatusPill from "@/components/common/StatusPill";

/** The palette colour each status is tinted with; `null` is the neutral grey. */
const TONE: Record<SupportStatus, "info" | "warning" | "success" | null> = {
  new: null,
  in_progress: "info",
  waiting: "warning",
  solved: "success",
  cancelled: null,
};

/** A status's colour for the support menu's dot (the chip itself is a
 * `StatusPill`, whose ink reads on its tint). In light mode the palette's
 * bright mains read too pale on a pale ground, so the dot takes a darker shade. */
export const statusColor = (theme: Theme, status: SupportStatus): string => {
  const tone = TONE[status];
  if (!tone) return theme.palette.text.secondary;
  const main = theme.palette[tone].main;
  return theme.palette.mode === "light" ? darken(main, 0.22) : main;
};

type Props = { ticket: Pick<SupportTicket, "status" | "needs_my_reply" | "customer_name"> };

/** Status label as GOAT's status pill (`StatusPill`, tinted, with a dot); an admin looking at a colleague's waiting ticket sees who it waits for. */
const StatusChip = ({ ticket }: Props) => {
  const { t } = useTranslation("common");
  const label =
    ticket.status === "waiting" && !ticket.needs_my_reply && ticket.customer_name
      ? t("support_status_waiting_for", { name: ticket.customer_name })
      : t(`support_status_${ticket.status}`);
  return <StatusPill tone={TONE[ticket.status] ?? "neutral"}>{label}</StatusPill>;
};

export default StatusChip;
