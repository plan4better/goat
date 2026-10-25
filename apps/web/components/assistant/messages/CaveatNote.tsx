"use client";

import { useTranslation } from "react-i18next";

import type { CaveatData } from "@/lib/assistant/types";

import DockNote from "@/components/assistant/messages/DockNote";

/** The caveat kinds the dock can explain, by the translated text that states them. */
const CAVEAT_KEYS: Record<string, string> = {
  fallback: "assistant_caveat_fallback",
  no_answer: "assistant_caveat_no_answer",
};

/**
 * A caveat the server attached to the answer, e.g. that GOAT AI stood in. Only
 * the kind is used: the server's own text is English and is never shown, and a
 * kind this version does not know renders nothing.
 */
export default function CaveatNote({ data }: { data: CaveatData }) {
  const { t } = useTranslation("common");
  const key = Object.hasOwn(CAVEAT_KEYS, data.kind) ? CAVEAT_KEYS[data.kind] : undefined;
  if (!key) return null;
  return <DockNote tone="warning">{t(key)}</DockNote>;
}
