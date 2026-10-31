"use client";

import { Box, useMediaQuery, useTheme } from "@mui/material";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

import { useAssistantStatus } from "@/lib/api/assistant";
import { useUserProfile } from "@/lib/api/users";
import { claimDock, getDockState, setDockState, useActiveSurface, useDockState } from "@/lib/assistant/store";
import { assistantRouteAllowed } from "@/lib/assistant/surface";
import { ASSISTANT_BASE_URL } from "@/lib/constants";

import DockSkeleton from "@/components/assistant/DockSkeleton";
import { prefetchAssistant, useAssistantDock, whenIdle } from "@/components/assistant/dockLoader";

// The root layout carries this frame on every page: the dock (AI SDK, Markdown) and the
// run watcher load only where AI is available, the dock ahead of the first click (dockLoader).
const RunWatcher = dynamic(() => import("@/components/assistant/RunWatcher"), { ssr: false });

/** The dock, or its frame while the dock's code loads. */
function Dock({ variant }: { variant: "docked" | "fullscreen" }) {
  const AssistantDock = useAssistantDock();
  // Whether this dock showed its frame first, decided as it mounts.
  const [framed] = useState(() => !AssistantDock);
  return AssistantDock ? (
    <AssistantDock variant={variant} framed={framed} />
  ) : (
    <DockSkeleton variant={variant} />
  );
}

/**
 * Mounted once in the root layout (spec §10), so the dock survives switching
 * pages and project modes. Pages outside the app keep their DOM untouched.
 */
export default function AssistantRoot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Without an assistant service nothing is requested and the page stays as it is.
  if (!ASSISTANT_BASE_URL || !assistantRouteAllowed(pathname)) return <>{children}</>;
  return <AssistantFrame>{children}</AssistantFrame>;
}

function AssistantFrame({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("md"));
  const { status } = useAssistantStatus();
  const surface = useActiveSurface();
  const dock = useDockState();
  // Hidden entirely when AI is off for the organization or the instance, and on a switched-off surface.
  const enabled =
    !!ASSISTANT_BASE_URL &&
    !!status?.available &&
    !(status.disabled_surfaces ?? []).includes(surface?.surface ?? "none");

  useEffect(() => {
    if (getDockState().enabled !== enabled) setDockState({ enabled });
  }, [enabled]);
  // The dock's code and history load while the page is idle, so the first Ask AI click
  // waits for neither; a project that registers later gets its own list read then. A phone,
  // where data may be metered, loads them as the button is touched instead (AskAiButton).
  const projectId = surface?.project?.id;
  useEffect(() => {
    if (!enabled || isPhone) return;
    return whenIdle(prefetchAssistant);
  }, [enabled, isPhone, projectId]);
  // The tab keeps the dock's state across a sign-out: the next user starts without
  // the previous user's conversation.
  const { userProfile } = useUserProfile();
  const userId = userProfile?.id;
  useEffect(() => {
    if (userId) claimDock(userId);
  }, [userId]);
  // Leaving the app (a public or print page) unmounts this frame: no button may offer a dock then.
  useEffect(
    () => () => {
      if (getDockState().enabled) setDockState({ enabled: false });
    },
    []
  );

  const showPanel = enabled && dock.open;
  const fullscreen = dock.expanded || isPhone;
  return (
    <>
      <Box sx={{ display: "flex", width: "100%", height: "100%", overflow: "hidden" }}>
        {/* The containing block of the page's absolutely positioned overlays (map controls,
            attribution): without it they sit against the window and slide under the docked
            dock. With the dock closed this column covers the window, so nothing moves. */}
        <Box sx={{ position: "relative", flex: 1, minWidth: 0, height: "100%", overflow: "hidden" }}>
          {children}
        </Box>
        {showPanel && !fullscreen && <Dock variant="docked" />}
      </Box>
      {showPanel && fullscreen && <Dock variant="fullscreen" />}
      {enabled && <RunWatcher />}
    </>
  );
}
