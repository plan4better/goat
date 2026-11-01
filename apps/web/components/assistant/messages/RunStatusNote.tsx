"use client";

import { useTranslation } from "react-i18next";

import { runStatusKey } from "@/lib/assistant/errors";
import type { RunStatusData } from "@/lib/assistant/types";

import DockNote from "@/components/assistant/messages/DockNote";

/** How an answer ended when it did not succeed; the same live and after a reload. */
export default function RunStatusNote({ data }: { data: RunStatusData }) {
  const { t } = useTranslation("common");
  const tone = data.status === "failed" ? "error" : data.status === "interrupted" ? "warning" : "neutral";
  return <DockNote tone={tone}>{t(runStatusKey(data))}</DockNote>;
}
