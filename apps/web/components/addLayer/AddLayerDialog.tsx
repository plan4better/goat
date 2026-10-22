"use client";

import { Alert, Box, useMediaQuery, useTheme } from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FlowController } from "@/hooks/addLayer/flow";
import { useCatalogFlow } from "@/hooks/addLayer/useCatalogFlow";
import { useConnectFlow } from "@/hooks/addLayer/useConnectFlow";
import { useCreateFlow } from "@/hooks/addLayer/useCreateFlow";
import { useDatasetPickerFlow } from "@/hooks/addLayer/useDatasetPickerFlow";
import { type FetchSource, useFetchFlow } from "@/hooks/addLayer/useFetchFlow";
import { useUploadFlow } from "@/hooks/addLayer/useUploadFlow";

import CatalogBody from "@/components/addLayer/CatalogBody";
import ConnectBody from "@/components/addLayer/ConnectBody";
import { type ConnectKind, ConnectRail } from "@/components/addLayer/ConnectPicker";
import CreateBody from "@/components/addLayer/CreateBody";
import DatasetPickerBody from "@/components/addLayer/DatasetPickerBody";
import FetchBody from "@/components/addLayer/FetchBody";
import UploadBody from "@/components/addLayer/UploadBody";
import { type AddLayerSourceId, addLayerSource } from "@/components/addLayer/sources";
import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

/**
 * The chrome one source is shown in: a title, the body, and the flow's own control.
 *
 * A frame per source rather than one dialog holding all of them behind a tab bar. The
 * sources are not peers — uploading a file is a short form, browsing the catalog is a
 * search over thousands of collections — and each is sized for its own job here, which is
 * why nothing in this file animates a width or hides a body while the frame moves.
 *
 * It owns none of the rules: the flow publishes an `action` and the footer draws it.
 */
const AddLayerFrame = ({
  sourceId,
  controller,
  aside,
  instant,
  onClose,
  children,
}: {
  sourceId: AddLayerSourceId;
  controller: FlowController;
  /** A rail beside the body that stays while the body changes. */
  aside?: ReactNode;
  /** Skips the opening animation, for a frame that replaces one already open. */
  instant?: boolean;
  onClose: () => void;
  children: ReactNode;
}) => {
  const { t } = useTranslation("common");
  const source = addLayerSource(sourceId);

  const close = () => {
    controller.reset();
    onClose();
  };

  return (
    <AppDialog
      open
      onClose={close}
      icon={source.icon}
      title={t(source.labelKey)}
      // Set outright rather than capped, because each source has a width of its own and
      // MUI's paper rules would otherwise win.
      maxWidth={source.width ?? 860}
      // A browsing source lays out its own edges — a filter rail has to reach the frame —
      // so the dialog does not pad it and leave it to undo that. Forms keep their padding.
      bleed={source.wide}
      bodySx={source.wide ? undefined : { pt: 5 }}
      transitionDuration={instant ? 0 : undefined}
      notice={
        controller.action.notice ? (
          <Alert severity="info" icon={<Icon iconName={ICON_NAME.USERS} style={{ fontSize: 15 }} />}>
            {controller.action.notice}
          </Alert>
        ) : undefined
      }
      footer={
        <AppDialogFooter
          onCancel={close}
          primaryLabel={controller.action.label}
          onPrimary={() => void controller.action.run()}
          primaryDisabled={controller.action.disabled}
          primaryLoading={controller.isBusy}
          primaryTooltip={controller.action.disabled ? (controller.action.reason ?? "") : ""}
        />
      }>
      {aside ? (
        // One height for every pane, so changing what is chosen never resizes the dialog.
        <Box
          sx={{
            display: "flex",
            flexDirection: { xs: "column", md: "row" },
            flex: 1,
            minHeight: 0,
            height: { md: 640 },
          }}>
          {aside}
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>{children}</Box>
        </Box>
      ) : (
        children
      )}
    </AppDialog>
  );
};

/**
 * One wrapper per source, so only the flow being used is mounted.
 *
 * Hooks cannot be called conditionally, so a single component holding all three would run
 * all three: opening the upload dialog would start the catalog flow's queries as well.
 * Split, each dialog costs only what it is for.
 */
const UploadDialog = ({
  projectId,
  defaultFolderId,
  initialFile,
  autoOpenSetup,
  onClose,
}: {
  projectId?: string;
  defaultFolderId?: string;
  initialFile?: File;
  autoOpenSetup?: boolean;
  onClose: () => void;
}) => {
  const controller = useUploadFlow({ projectId, defaultFolderId, initialFile, onDone: onClose });
  return (
    <AddLayerFrame sourceId="upload" controller={controller} onClose={onClose}>
      <UploadBody controller={controller} autoOpenSetup={autoOpenSetup} />
    </AddLayerFrame>
  );
};

const CreateDialog = ({ projectId, onClose }: { projectId?: string; onClose: () => void }) => {
  const controller = useCreateFlow({ projectId, onDone: onClose });
  return (
    <AddLayerFrame sourceId="create" controller={controller} onClose={onClose}>
      <CreateBody controller={controller} />
    </AddLayerFrame>
  );
};

/** The map's bounds when a dialog opens; absent on the dashboard, where there is no map. */
const useViewport = () => {
  const { map } = useMap();
  // Read once: the map cannot move behind a modal.
  const [viewport] = useState<[number, number, number, number] | undefined>(() => {
    const bounds = map?.getBounds();
    return bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] : undefined;
  });
  return viewport;
};

type ConnectPaneProps = {
  projectId?: string;
  defaultFolderId?: string;
  rail: ReactNode;
  instant: boolean;
  onClose: () => void;
};

const ServicePane = ({ projectId, defaultFolderId, rail, instant, onClose }: ConnectPaneProps) => {
  const controller = useConnectFlow({ projectId, defaultFolderId, onDone: onClose });
  return (
    <AddLayerFrame
      sourceId="connect"
      controller={controller}
      aside={rail}
      instant={instant}
      onClose={onClose}>
      <ConnectBody controller={controller} />
    </AddLayerFrame>
  );
};

/** OpenStreetMap and Overture share one flow, so switching between them keeps the area. */
const OpenDataPane = ({
  source,
  projectId,
  defaultFolderId,
  rail,
  instant,
  onClose,
}: ConnectPaneProps & { source: FetchSource }) => {
  const viewport = useViewport();
  const controller = useFetchFlow({
    projectId,
    defaultFolderId,
    viewport,
    initialSource: source,
    onDone: onClose,
  });
  const { fetch } = controller;
  useEffect(() => {
    if (fetch.source !== source) fetch.setSource(source);
  }, [fetch, source]);
  return (
    <AddLayerFrame
      sourceId="connect"
      controller={controller}
      aside={rail}
      instant={instant}
      onClose={onClose}>
      <FetchBody controller={controller} />
    </AddLayerFrame>
  );
};

/**
 * One dialog for everything that is connected rather than uploaded: a web service, or open
 * data GOAT hosts. The rail stays; only the side beside it changes.
 */
const ConnectDialog = ({
  projectId,
  defaultFolderId,
  onClose,
}: {
  projectId?: string;
  defaultFolderId?: string;
  onClose: () => void;
}) => {
  // Opens on services, as Connect service always has; the rail switches.
  const [kind, setKind] = useState<ConnectKind>("service");
  // The first frame opens as a dialog does; each one after replaces it in place.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  });
  const rail = <ConnectRail kind={kind} onPick={setKind} />;
  const pane = {
    projectId,
    defaultFolderId,
    rail,
    instant: opened.current,
    onClose,
  };
  if (kind === "service") return <ServicePane {...pane} />;
  return <OpenDataPane {...pane} source={kind} />;
};

const CatalogDialog = ({ projectId, onClose }: { projectId?: string; onClose: () => void }) => {
  // Absent on the dashboard, where there is no map: then nothing is boosted.
  const viewport = useViewport();
  const controller = useCatalogFlow({ projectId, onDone: onClose, viewport });
  return (
    <AddLayerFrame sourceId="catalog" controller={controller} onClose={onClose}>
      <CatalogBody controller={controller} />
    </AddLayerFrame>
  );
};

const MyDatasetsDialog = ({ projectId, onClose }: { projectId?: string; onClose: () => void }) => {
  const theme = useTheme();
  // The frame full-screens below `sm` (AppDialog's default), and a full-screen
  // paper is the whole viewport: the shelf fills the body rather than standing
  // at its own height and leaving a gap between the feed and the footer.
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const controller = useDatasetPickerFlow({ projectId, onDone: onClose });
  return (
    <AddLayerFrame sourceId="explorer" controller={controller} onClose={onClose}>
      <DatasetPickerBody mode="add" selection={controller.selection} fullHeight={fullScreen} />
    </AddLayerFrame>
  );
};

/**
 * A layer from one source, in a dialog of its own.
 *
 * Nothing is mounted until a source is asked for, so a host may render this permanently.
 */
const AddLayerDialog = ({
  source,
  projectId,
  defaultFolderId,
  initialFile,
  autoOpenSetup,
  onClose,
}: {
  /** Which source to show; `null` shows nothing. */
  source: AddLayerSourceId | null;
  projectId?: string;
  defaultFolderId?: string;
  /** A file the host already holds, e.g. one dropped on the map. */
  initialFile?: File;
  /** Opens the file's own settings as soon as they can be shown. */
  autoOpenSetup?: boolean;
  onClose: () => void;
}) => {
  if (source === "upload")
    return (
      <UploadDialog
        projectId={projectId}
        defaultFolderId={defaultFolderId}
        initialFile={initialFile}
        autoOpenSetup={autoOpenSetup}
        onClose={onClose}
      />
    );
  if (source === "create") return <CreateDialog projectId={projectId} onClose={onClose} />;
  if (source === "catalog") return <CatalogDialog projectId={projectId} onClose={onClose} />;
  if (source === "connect")
    return <ConnectDialog projectId={projectId} defaultFolderId={defaultFolderId} onClose={onClose} />;
  if (source === "explorer") return <MyDatasetsDialog projectId={projectId} onClose={onClose} />;
  return null;
};

export default AddLayerDialog;
