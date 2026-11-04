"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { contextChips, fitContext, plainTranslate, stripContext, withSources } from "@/lib/assistant/chips";
import { getDraft, saveDraft, useActiveSurface } from "@/lib/assistant/store";
import type { SourceRef } from "@/lib/assistant/types";

export const MAX_SOURCES = 10;
/** The server refuses longer source names (context.py). */
export const MAX_SOURCE_NAME = 200;

/** Trimmed and cut to MAX_SOURCE_NAME code points, so a surrogate pair is never split. */
export const sourceName = (name: string): string =>
  Array.from(name.trim()).slice(0, MAX_SOURCE_NAME).join("");

/**
 * What the next message carries (spec §6.3): the page's context, minus the
 * chips the user removed, plus the projects they mentioned with @. Removed
 * chips come back when the page changes; sources are per message.
 *
 * With a `draftKey`, the sources and removed chips are kept in the dock store
 * under that key and restored on mount (the dock remounts on expand/collapse).
 */
export function useComposerContext(draftKey?: string) {
  const { t } = useTranslation("common");
  const surface = useActiveSurface();
  const surfaceKey = `${surface?.surface ?? "none"}:${surface?.project?.id ?? ""}`;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => {
    const saved = draftKey ? getDraft(draftKey) : null;
    return new Set(saved && saved.surfaceKey === surfaceKey ? saved.removed : []);
  });
  const [sources, setSources] = useState<SourceRef[]>(
    () => (draftKey ? getDraft(draftKey)?.sources : null) ?? []
  );
  const [seenKey, setSeenKey] = useState(surfaceKey);
  if (seenKey !== surfaceKey) {
    setSeenKey(surfaceKey);
    setRemoved(new Set());
  }
  useEffect(() => {
    if (draftKey) saveDraft(draftKey, { sources, removed: Array.from(removed), surfaceKey: seenKey });
  }, [draftKey, sources, removed, seenKey]);
  // Fitted last: the sources count towards the size the server accepts.
  const stripped = stripContext(withSources(surface ? surface.getContext() : null, sources), removed);
  const context = stripped && fitContext(stripped);
  // Project and search names are user text: React escapes them, i18next must not as well.
  const chips = contextChips(context, surface?.project?.name, plainTranslate(t));
  return {
    context,
    chips,
    // Project tools load on pages without context and on project pages (plan 3 T16, plan 4 W8).
    mentionsEnabled: !surface || surface.surface.startsWith("project."),
    projectId: surface?.project?.id,
    /** No further @ source fits into this message. */
    sourcesFull: sources.length >= MAX_SOURCES,
    removeChip: (key: string) => {
      if (key.startsWith("source:"))
        setSources((list) => list.filter((source) => `source:${source.id}` !== key));
      else setRemoved((current) => new Set(current).add(key));
    },
    addSource: (source: SourceRef) =>
      setSources((list) =>
        list.some((s) => s.id === source.id)
          ? list
          : [...list, { ...source, name: sourceName(source.name) }].slice(0, MAX_SOURCES)
      ),
    reset: () => {
      setSources([]);
      setRemoved(new Set());
    },
  };
}
