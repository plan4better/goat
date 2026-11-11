"use client";

import { Box, useMediaQuery, useTheme } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import { useHomeCreate } from "@/hooks/dashboard/home/useHomeCreate";
import type { SetupStepId } from "@/hooks/dashboard/home/useHomeStage";
import {
  SETUP_STEPS,
  SETUP_STEP_META,
  runSetupStep,
  useHomeStage,
} from "@/hooks/dashboard/home/useHomeStage";

import { ArrowPopper } from "@/components/ArrowPoper";
import {
  HeaderPopoverFooter,
  HeaderPopoverFooterAction,
  HeaderPopoverHeader,
  HeaderPopoverList,
  HeaderPopoverRow,
} from "@/components/header/HeaderPopover";
import HeaderPopoverPaper, { HEADER_POPOVER_PLACEMENT } from "@/components/header/HeaderPopoverPaper";

const RING_SIZE = 22;
const RING_STROKE = 2.5;
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * H9's header tray: a pill with an SVG progress ring ("n/N" steps done) that
 * opens a popover listing the checklist — done steps struck through, open
 * ones clickable straight to their action — with "I'm ready, skip
 * onboarding" in the footer. Computes its own stage via `useHomeStage` so
 * `Header` can mount it with no props; renders nothing while facts or
 * preferences are still loading, or once onboarding is complete or skipped.
 */
const OnboardingTray = () => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // The narrow header has room for the title and the avatar only; on a phone
  // the inline checklist on Home carries the progress instead.
  const mobile = useMediaQuery(theme.breakpoints.down("md"));
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const { stage, isLoading, done, skip } = useHomeStage();
  const { newProject, addDataset, browseCatalog, dialogs } = useHomeCreate();

  if (mobile) return null;

  if (isLoading || !stage || stage === "established") return null;

  const total = SETUP_STEPS.length;
  const progress = done.length / total;

  const onStep = (step: SetupStepId) => {
    setOpen(false);
    runSetupStep(step, {
      newProject,
      addDataset,
      browseCatalog,
      goToTeam: () => router.push(SETTINGS_ROUTES.teams),
      // Outside Home there is no inline browser to open in place — send the
      // caller to the Catalog's Templates tab instead, for either template
      // step alike.
      openTemplates: () => router.push("/catalog?tab=templates"),
    });
  };

  const onSkip = () => {
    setOpen(false);
    void skip();
  };

  return (
    <>
      {dialogs}
      <ArrowPopper
        open={open}
        onClose={() => setOpen(false)}
        placement={HEADER_POPOVER_PLACEMENT}
        arrow={false}
        content={
          <HeaderPopoverPaper>
            <HeaderPopoverHeader
              title={t("getting_started")}
              aside={t("steps_completed", { done: done.length, total })}>
              <Box
                sx={{
                  mt: "8px",
                  height: "5px",
                  borderRadius: "999px",
                  backgroundColor: theme.palette.action.hover,
                  overflow: "hidden",
                }}>
                <Box
                  sx={{
                    height: "100%",
                    width: `${progress * 100}%`,
                    borderRadius: "999px",
                    backgroundColor: theme.palette.primary.main,
                  }}
                />
              </Box>
            </HeaderPopoverHeader>
            <HeaderPopoverList>
              {SETUP_STEPS.map((step) => {
                const isDone = done.includes(step);
                const meta = SETUP_STEP_META[step];
                return (
                  <HeaderPopoverRow
                    key={step}
                    muted={isDone}
                    onClick={isDone ? undefined : () => onStep(step)}
                    icon={
                      isDone ? (
                        <Icon
                          iconName={ICON_NAME.CIRCLECHECK}
                          style={{ fontSize: 15, color: theme.palette.primary.main }}
                        />
                      ) : (
                        meta.icon
                      )
                    }
                    label={
                      <span style={{ textDecoration: isDone ? "line-through" : "none" }}>
                        {t(meta.titleKey)}
                      </span>
                    }
                  />
                );
              })}
            </HeaderPopoverList>
            <HeaderPopoverFooter>
              <HeaderPopoverFooterAction onClick={onSkip}>{t("skip_onboarding")}</HeaderPopoverFooterAction>
            </HeaderPopoverFooter>
          </HeaderPopoverPaper>
        }>
        <Box
          component="button"
          type="button"
          onClick={() => setOpen(!open)}
          sx={{
            height: "32px",
            p: "0 11px 0 8px",
            borderRadius: "999px",
            border: `1px solid ${theme.palette.divider}`,
            fontSize: 12.5,
            fontWeight: 700,
            color: theme.palette.text.primary,
            backgroundColor: open ? theme.palette.action.hover : "transparent",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            cursor: "pointer",
          }}>
          <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke={theme.palette.divider}
              strokeWidth={RING_STROKE}
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke={theme.palette.primary.main}
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${RING_CIRCUMFERENCE * progress} ${RING_CIRCUMFERENCE}`}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          </svg>
          {done.length}/{total}
        </Box>
      </ArrowPopper>
    </>
  );
};

export default OnboardingTray;
