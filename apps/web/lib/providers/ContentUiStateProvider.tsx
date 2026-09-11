"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

/** A feed section built from the paged content listing. */
export type ContentSectionKey = "folders" | "shortcuts" | "projects" | "templates" | "datasets";

/** Sections built from their own listing rather than from the content feed —
 * they collapse the same way, so they share the open/closed record. */
export type ContentExtraSectionKey = "documents";

export type ContentOpenSections = Record<ContentSectionKey | ContentExtraSectionKey, boolean>;

interface ContentUiState {
  /** Which feed sections are expanded. */
  openSections: ContentOpenSections;
  toggleSection: (key: ContentSectionKey | ContentExtraSectionKey) => void;
  /** Whether the details panel (side panel on desktop, bottom sheet below
   * `md`) is showing. */
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
  toggleDetails: () => void;
}

const ContentUiStateContext = createContext<ContentUiState | undefined>(undefined);

const DEFAULT_OPEN_SECTIONS: ContentOpenSections = {
  folders: true,
  shortcuts: true,
  projects: true,
  templates: true,
  datasets: true,
  documents: true,
};

/**
 * The Content page's own view preferences — which sections are expanded and
 * whether the details panel is showing — held above the route segment that
 * renders the page.
 *
 * Next keys every route segment by the value of its dynamic params, so the
 * `/content/[[...path]]` page is a new component instance as soon as the
 * browsed space or folder changes: state held inside it would reset on every
 * step into a folder. This provider is mounted on the static `content`
 * segment's layout, which the same navigation leaves alone.
 */
export const ContentUiStateProvider = ({ children }: { children: ReactNode }) => {
  const [openSections, setOpenSections] = useState<ContentOpenSections>(DEFAULT_OPEN_SECTIONS);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const toggleSection = useCallback(
    (key: ContentSectionKey | ContentExtraSectionKey) =>
      setOpenSections((prev) => ({ ...prev, [key]: !prev[key] })),
    []
  );
  const toggleDetails = useCallback(() => setDetailsOpen((prev) => !prev), []);

  const value = useMemo(
    () => ({ openSections, toggleSection, detailsOpen, setDetailsOpen, toggleDetails }),
    [openSections, toggleSection, detailsOpen, toggleDetails]
  );

  return <ContentUiStateContext.Provider value={value}>{children}</ContentUiStateContext.Provider>;
};

/** Reads the Content page's view preferences. Only usable under
 * `ContentUiStateProvider` — the `/content` layout mounts it for every
 * address the page answers. */
export const useContentUiState = (): ContentUiState => {
  const state = useContext(ContentUiStateContext);
  if (!state) throw new Error("useContentUiState must be used within a ContentUiStateProvider");
  return state;
};

export default ContentUiStateProvider;
