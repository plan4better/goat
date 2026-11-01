"use client";

import { Box, Dialog, IconButton, Skeleton, Stack, useMediaQuery, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { setDockState } from "@/lib/assistant/store";

import DockPanel from "@/components/assistant/DockPanel";
import { LoadFailedNotice } from "@/components/assistant/LoadFailed";
import { loadAssistantDock, useAssistantDockFailures } from "@/components/assistant/dockLoader";
import {
  CARD_RADIUS,
  composerFooterSx,
  dockBackdropSx,
  dockHeaderSx,
  dockInsetPaperSx,
  dockSidebarSx,
  headerIconButtonSx,
} from "@/components/assistant/styles";
import { TOOLBAR_HEIGHT } from "@/components/header/Toolbar";

const ignore = () => undefined;

/**
 * The dock's code did not load: say so, and try again. A second failure in a
 * row is most likely code a deploy removed, which only a reload brings back.
 */
function LoadFailed({ failures }: { failures: number }) {
  const { t } = useTranslation("common");
  return (
    <LoadFailedNotice
      message={t("assistant_load_failed")}
      retry={failures < 2 ? () => void loadAssistantDock() : undefined}
    />
  );
}

/** The assistant's 28 px mark before its name. */
const MarkPlaceholder = () => (
  <Skeleton variant="rounded" width={28} height={28} sx={{ borderRadius: "8px", flex: "none" }} />
);

/** The Beta chip after the name. */
const BetaPlaceholder = () => (
  <Skeleton variant="rounded" width={40} height={19} sx={{ borderRadius: "6px", flex: "none" }} />
);

/** Where the dock's header, start page and composer will be; the failure in their place. */
function Placeholders({ sidebar, failures }: { sidebar: boolean; failures: number }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  if (failures > 0) {
    return (
      <>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="flex-end"
          sx={dockHeaderSx(theme, sidebar)}>
          <IconButton
            aria-label={t("close")}
            onClick={() => setDockState({ open: false, expanded: false })}
            sx={headerIconButtonSx(theme)}>
            <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 13, color: "inherit" }} />
          </IconButton>
        </Stack>
        <LoadFailed failures={failures} />
      </>
    );
  }
  return (
    <>
      <Stack direction="row" alignItems="center" gap="4px" sx={dockHeaderSx(theme, sidebar)}>
        {sidebar ? (
          <Skeleton variant="text" width={140} sx={{ fontSize: 14, mx: "auto" }} />
        ) : (
          <>
            <MarkPlaceholder />
            <Skeleton variant="text" width={140} sx={{ fontSize: 14, mx: "4px" }} />
            <BetaPlaceholder />
            <Box sx={{ flex: 1 }} />
          </>
        )}
        <IconButton
          aria-label={t("close")}
          onClick={() => setDockState({ open: false, expanded: false })}
          sx={headerIconButtonSx(theme)}>
          <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 13, color: "inherit" }} />
        </IconButton>
      </Stack>
      {/* The start page's scroll area and block (NewConversation, EmptyState): centred in the
          free space by its auto margins in a flex column. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "hidden",
          display: "flex",
          flexDirection: "column",
          px: sidebar ? "24px" : "20px",
          py: "24px",
        }}>
        <Box sx={{ width: "100%", maxWidth: sidebar ? 720 : "none", mx: "auto", my: "auto" }}>
          <Stack gap={sidebar ? "24px" : "20px"}>
            <Stack gap="8px" alignItems="center">
              <Skeleton
                variant="rounded"
                width={sidebar ? 52 : 44}
                height={sidebar ? 52 : 44}
                sx={{ borderRadius: sidebar ? "14px" : "12px" }}
              />
              <Skeleton
                variant="text"
                width={sidebar ? "45%" : "60%"}
                sx={{ mt: "4px", fontSize: sidebar ? 28 : 20, lineHeight: 1.25 }}
              />
              <Stack alignItems="center" sx={{ width: "100%", maxWidth: sidebar ? 560 : 320 }}>
                {["100%", "70%"].map((width) => (
                  <Skeleton
                    key={width}
                    variant="text"
                    width={width}
                    sx={{ fontSize: sidebar ? 15 : 14, lineHeight: 1.5 }}
                  />
                ))}
              </Stack>
            </Stack>
            <Stack gap="8px">
              <Skeleton variant="text" width={96} sx={{ fontSize: 12, lineHeight: 1.5 }} />
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: sidebar ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)",
                  gap: sidebar ? "12px" : "8px",
                }}>
                {/* A starter card: its 28 px icon square between 10 px paddings and a 1 px border. */}
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} variant="rounded" height={50} sx={{ borderRadius: CARD_RADIUS }} />
                ))}
              </Box>
            </Stack>
            <Stack alignItems="center">
              {["90%", "60%"].map((width) => (
                <Skeleton
                  key={width}
                  variant="text"
                  width={width}
                  sx={{ fontSize: 11.5, lineHeight: 1.45 }}
                />
              ))}
            </Stack>
          </Stack>
        </Box>
      </Box>
      <Box sx={composerFooterSx(sidebar)}>
        <Box sx={{ maxWidth: sidebar ? 720 : "none", mx: "auto" }}>
          {/* The scope note and the Feedback link above the composer, which comes last. */}
          <Stack direction="row" justifyContent="space-between" gap="8px" sx={{ mb: "8px", px: "2px" }}>
            <Skeleton variant="text" width="70%" sx={{ fontSize: 12, lineHeight: 1.45 }} />
            <Skeleton variant="text" width={56} sx={{ fontSize: 12, lineHeight: 1.45 }} />
          </Stack>
          <Skeleton variant="rounded" height={sidebar ? 96 : 80} sx={{ borderRadius: "14px" }} />
        </Box>
      </Box>
    </>
  );
}

/**
 * The dock's frame while its code loads (opened before the page prefetched it,
 * or on a phone): the same panel or dialog, header bar and composer footer, so
 * the dock takes its place without a jump. A failed load says so here.
 */
export default function DockSkeleton({ variant }: { variant: "docked" | "fullscreen" }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("md"));
  const failures = useAssistantDockFailures();
  const sidebar = variant === "fullscreen" && !isPhone;
  if (variant === "docked") {
    return (
      <DockPanel
        label={t("assistant_ask_ai")}
        busy={failures === 0}
        entrance
        onDragOver={ignore}
        onDrop={ignore}>
        <Placeholders sidebar={false} failures={failures} />
      </DockPanel>
    );
  }
  return (
    <Dialog
      open
      fullScreen={isPhone}
      maxWidth={false}
      onClose={() => setDockState({ expanded: false })}
      aria-label={t("assistant_ask_ai")}
      aria-busy={failures === 0}
      slotProps={{ backdrop: { sx: dockBackdropSx(theme) } }}
      PaperProps={{ sx: isPhone ? undefined : dockInsetPaperSx(theme) }}>
      <Stack direction="row" sx={{ height: "100%", minHeight: 0 }}>
        {sidebar && (
          <Box sx={dockSidebarSx}>
            {/* The sidebar's header: the mark, "Ask AI" and the Beta chip. */}
            <Stack
              direction="row"
              alignItems="center"
              gap="10px"
              sx={{ boxSizing: "content-box", height: TOOLBAR_HEIGHT, pb: "1px", flexShrink: 0, px: "18px" }}>
              <MarkPlaceholder />
              <Skeleton variant="text" width={56} sx={{ fontSize: 15 }} />
              <BetaPlaceholder />
            </Stack>
            <Stack gap="10px" sx={{ px: "18px", pb: "18px" }}>
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} variant="rounded" height={32} sx={{ borderRadius: "8px" }} />
              ))}
            </Stack>
          </Box>
        )}
        <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Placeholders sidebar={sidebar} failures={failures} />
        </Stack>
      </Stack>
    </Dialog>
  );
}
