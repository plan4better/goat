"use client";

import { Box, useMediaQuery, useTheme } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { refreshContentFeed } from "@/lib/api/content";
import { useTemplates } from "@/lib/api/templates";
import { useUserProfile } from "@/lib/api/users";
import type { TemplateKind, TemplateRead, TemplateSourceFilter } from "@/lib/validations/template";

import { useHomeCreate } from "@/hooks/dashboard/home/useHomeCreate";
import type { SetupStepId } from "@/hooks/dashboard/home/useHomeStage";
import { runSetupStep, useHomeStage } from "@/hooks/dashboard/home/useHomeStage";
import { useJobStatus } from "@/hooks/jobs/JobStatus";
import { templateResultHref } from "@/hooks/templates/useUseTemplate";

import BlogSection from "@/components/dashboard/home/BlogSection";
import DataWays from "@/components/dashboard/home/DataWays";
import HomeAnnouncements from "@/components/dashboard/home/HomeAnnouncements";
import HomeHero from "@/components/dashboard/home/HomeHero";
import HomeSearch from "@/components/dashboard/home/HomeSearch";
import JumpBackIn from "@/components/dashboard/home/JumpBackIn";
import RecentDatasets from "@/components/dashboard/home/RecentDatasets";
import SetupChecklist from "@/components/dashboard/home/SetupChecklist";
import TeamsCard from "@/components/dashboard/home/TeamsCard";
import TemplateBand from "@/components/dashboard/home/TemplateBand";
import TemplateBrowser from "@/components/templates/TemplateBrowser";
import UseTemplateFlow from "@/components/templates/UseTemplateFlow";

/**
 * The launchpad (H1): greeting, hero search + quick actions, and the help
 * strip all live in `HomeHero`, gated by the caller's stage (H2). Below it,
 * per §3: the onboarding checklist (New, Getting started) and "get some
 * data in" (New, while no dataset exists yet), "jump back in", the template
 * band, recent datasets with the teams card beside them, and `BlogSection`
 * (H13) last. Release notes live in the header popper; `HomeAnnouncements`
 * opens the first-run Welcome (H7a) and the spotlight (H7) over all of it,
 * one at a time.
 */
const HomePage = () => {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("md"));

  const router = useRouter();
  const { userProfile } = useUserProfile();
  const { stage, isLoading: stageLoading, facts, done, refresh: refreshFacts } = useHomeStage();
  const { homeFolderId, newProject, addDataset, browseCatalog, dialogs } = useHomeCreate();

  // An upload's dialog closes before its background import has written the
  // layer, so the lists refresh when the job finishes, as the Content page
  // does. The onboarding facts follow, since they hold "has an uploaded layer".
  useJobStatus(() => {
    refreshContentFeed();
    refreshFacts();
  });

  // T10/§4: one template browser + `UseTemplateFlow` pair for the
  // checklist's "Run your first analysis"/"Build a workflow" steps —
  // `HomePage` owns them exactly like `useHomeCreate`'s own dialogs. The
  // hero's own "From template" start lives in its `NewProjectButton`.
  const [templateBrowser, setTemplateBrowser] = useState<{
    lockedKind?: TemplateKind;
    initialSource?: TemplateSourceFilter;
    initialTemplateId?: string;
  } | null>(null);
  const [usingTemplate, setUsingTemplate] = useState<TemplateRead | null>(null);
  // The GOAT shelf, read ahead of the click so "Run your first analysis" can
  // preselect a starter with no loading step in between. Its own request:
  // `TemplateBand` asks for every source, so there is nothing to share with.
  // Only fetched while the checklist can render, since that step is the only
  // reader.
  const showsChecklist = !!stage && stage !== "established";
  const { page: goatTemplatesPage } = useTemplates(showsChecklist ? { source: "goat", size: 24 } : null);

  /** T10's "Run your first analysis" opens the browser on the GOAT shelf
   * with a workflow starter that ships sample data already previewed, so the
   * rest of the shelf stays one click away; "Build a workflow" opens the
   * browser locked to the Workflow kind. Both fall back to the plain shelf
   * when no such starter is loaded. */
  const openTemplates = (kind?: TemplateKind) => {
    if (kind === "workflow") {
      setTemplateBrowser({ lockedKind: "workflow" });
      return;
    }
    const starter = (goatTemplatesPage?.items ?? []).find(
      (item) => item.ships_data && item.kinds.includes("workflow")
    );
    setTemplateBrowser({ initialSource: "goat", initialTemplateId: starter?.id });
  };

  const onStep = (step: SetupStepId) => {
    runSetupStep(step, {
      newProject,
      addDataset,
      browseCatalog,
      goToTeam: () => router.push("/settings/teams"),
      openTemplates,
    });
  };

  return (
    <Box
      sx={{
        // `main` is a flex column, where `mx: auto` alone would shrink this
        // band to its widest child; the explicit width keeps it at 1180px
        // whatever is loading.
        width: "100%",
        maxWidth: 1180,
        mx: "auto",
        px: mobile ? "14px" : "28px",
        py: mobile ? "18px" : "40px",
        display: "flex",
        flexDirection: "column",
        gap: mobile ? "28px" : "40px",
      }}>
      {dialogs}
      {templateBrowser && (
        <TemplateBrowser
          mode="dialog"
          open
          onClose={() => setTemplateBrowser(null)}
          lockedKind={templateBrowser.lockedKind}
          initialSource={templateBrowser.initialSource}
          initialTemplateId={templateBrowser.initialTemplateId}
          onUse={(template) => {
            setTemplateBrowser(null);
            setUsingTemplate(template);
          }}
        />
      )}
      {usingTemplate && (
        <UseTemplateFlow
          template={usingTemplate}
          context={{ kind: "outside_project" }}
          onClose={() => setUsingTemplate(null)}
          onDone={(result) => {
            const template = usingTemplate;
            setUsingTemplate(null);
            router.push(templateResultHref(template, result));
          }}
        />
      )}

      {/* Neither `has_project` etc. nor `onboarding_skipped_at` are in yet.
       * The hero renders straight away — search and the quick actions are
       * the same in every stage but New, so it opens on the Established
       * shape and only the greeting waits, as a skeleton. What a stage read
       * now would get wrong stays out: the New-only hero, and the help strip
       * that real usage hides. The strip ignores the skip flag on purpose:
       * skipping dismisses the checklist, not the docs, so it stays until
       * the caller has a project and has run a workflow. */}
      <HomeHero
        stage={stage ?? "established"}
        firstName={userProfile?.firstname ?? ""}
        search={<HomeSearch />}
        homeFolderId={homeFolderId}
        onAddDataset={addDataset}
        onBrowseCatalog={browseCatalog}
        loading={stageLoading || !stage}
        showHelp={!!stage && !(facts?.has_project && facts?.has_workflow)}
        mobile={mobile}
      />

      {/* H9: the onboarding checklist, capped at 720px rather than stretching
       * to the full 1180px band width. It leads the page until the first
       * project exists; from then on the header tray is the only surface. */}
      {stage && stage !== "established" && !facts?.has_project && (
        <Box sx={{ maxWidth: 720, width: "100%", mx: "auto" }}>
          <SetupChecklist done={done} compact={stage !== "new"} onStep={onStep} />
        </Box>
      )}
      {/* §3: "Get some data in" — New only, while no dataset is reachable yet. */}
      {stage === "new" && !facts?.has_uploaded_layer && !facts?.has_catalog_layer && (
        <DataWays onUpload={addDataset} onCatalog={browseCatalog} />
      )}
      <JumpBackIn />
      <TemplateBand />

      {stage === "new" ? (
        /* Day one: no team to show beside the datasets yet, so they take the
         * full width instead of a side column with an empty neighbour. */
        <RecentDatasets />
      ) : (
        <Box
          sx={{
            display: "flex",
            flexDirection: mobile ? "column" : "row",
            alignItems: "flex-start",
            gap: mobile ? "28px" : "24px",
          }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <RecentDatasets />
          </Box>
          <Box
            sx={{
              width: mobile ? "100%" : 340,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: "24px",
            }}>
            <TeamsCard />
          </Box>
        </Box>
      )}

      <BlogSection />
      <HomeAnnouncements />
    </Box>
  );
};

export default HomePage;
