import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { refreshContentFeed } from "@/lib/api/content";
import { getWritableFolders, useFolders } from "@/lib/api/folders";
import { createLayer, createRasterLayer } from "@/lib/api/layers";
import { useJobs } from "@/lib/api/processes";
import { addProjectLayers, useProject, useProjectLayers } from "@/lib/api/projects";
import { addRunningJobIds } from "@/lib/store/jobs/slice";
import type { ConnectFailure, ConnectedService } from "@/lib/utils/externalService";
import {
  ServiceConnectError,
  buildLayerRequest,
  capabilitiesRequestUrl,
  defaultLayerName,
  detectDirectService,
  isDirect,
  parseCapabilities,
  pickedLayers,
  serviceLayers,
} from "@/lib/utils/externalService";
import type { GetContentQueryParams } from "@/lib/validations/common";
import type { Folder } from "@/lib/validations/folder";

import type { FlowController } from "@/hooks/addLayer/flow";
import { useShareNotice } from "@/hooks/addLayer/useShareNotice";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

/**
 * Connecting an external service — WMS, WMTS, WFS, a tile template or a COG — no UI.
 *
 * One view: an address, what the service offers once it is read, and the name and folder
 * the layer gets. Imagery becomes a layer that points at the service; a WFS feature type is
 * copied into GOAT by an import job, which is why its action says Import.
 */

export type ConnectStatus = "idle" | "connecting" | "connected" | "failed";

export type ConnectFlowState = {
  address: string;
  /** Changing the address drops whatever was read from the old one. */
  setAddress: (value: string) => void;
  connect: () => Promise<void>;
  status: ConnectStatus;
  failure?: ConnectFailure;
  service?: ConnectedService;
  /** Picked layer ids, in pick order: a WMS draws them in that order. */
  selected: string[];
  toggleLayer: (id: string) => void;
  /** The layer last picked, which the detail pane describes. */
  focusedId: string | null;
  name: string;
  setName: (value: string) => void;
  folders?: Folder[];
  selectedFolder?: Folder | null;
  setSelectedFolder: (folder: Folder | null) => void;
};

export type ConnectFlow = FlowController & { connect: ConnectFlowState };

export const useConnectFlow = ({
  projectId,
  defaultFolderId,
  onDone,
}: {
  projectId?: string;
  defaultFolderId?: string;
  onDone?: () => void;
}): ConnectFlow => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { mutate: mutateJobs } = useJobs({ read: false });
  const { project, mutate: mutateProject } = useProject(projectId);
  const { mutate: mutateProjectLayers } = useProjectLayers(projectId);
  const notice = useShareNotice(projectId);
  const queryParams: GetContentQueryParams = { order: "descendent", order_by: "updated_at" };
  const { folders: allFolders } = useFolders(queryParams);
  const folders = getWritableFolders(allFolders);

  const [address, setAddressValue] = useState("");
  const [status, setStatus] = useState<ConnectStatus>("idle");
  const [failure, setFailure] = useState<ConnectFailure>();
  const [service, setService] = useState<ConnectedService>();
  const [selected, setSelected] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [customName, setCustomName] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>();
  const [isBusy, setIsBusy] = useState(false);
  const folderInitialized = useRef(false);
  /** Bumped on every connect and address change, so a slow answer cannot land late. */
  const attempt = useRef(0);

  // The project's own folder, as for an upload; otherwise the one the host was showing.
  useEffect(() => {
    if (!folders.length || folderInitialized.current) return;
    const initial =
      folders.find((folder) => folder.id === project?.folder_id) ??
      folders.find((folder) => folder.id === defaultFolderId);
    if (initial) {
      setSelectedFolder(initial);
      folderInitialized.current = true;
    }
  }, [folders, project?.folder_id, defaultFolderId]);

  const clearService = useCallback(() => {
    setService(undefined);
    setSelected([]);
    setFocusedId(null);
    setCustomName(null);
    setFailure(undefined);
  }, []);

  const setAddress = useCallback(
    (value: string) => {
      attempt.current += 1;
      setAddressValue(value);
      setStatus("idle");
      clearService();
    },
    [clearService]
  );

  const connect = useCallback(async () => {
    const current = ++attempt.current;
    clearService();
    const directService = detectDirectService(address);
    if (directService) {
      setService(directService);
      setStatus("connected");
      return;
    }
    setStatus("connecting");
    let found: ConnectedService;
    try {
      const requestUrl = capabilitiesRequestUrl(address);
      let text: string;
      try {
        const response = await fetch(requestUrl, { headers: { Accept: "application/xml, text/xml, */*" } });
        if (!response.ok) throw new ServiceConnectError("unreachable");
        text = await response.text();
      } catch (error) {
        // A browser reports a CORS refusal exactly like a server that is down.
        throw error instanceof ServiceConnectError ? error : new ServiceConnectError("unreachable");
      }
      found = parseCapabilities(requestUrl, text);
    } catch (error) {
      if (current !== attempt.current) return;
      setFailure(error instanceof ServiceConnectError ? error.reason : "unrecognised");
      setStatus("failed");
      return;
    }
    if (current !== attempt.current) return;
    setService(found);
    setStatus("connected");
  }, [address, clearService]);

  const toggleLayer = useCallback(
    (id: string) => {
      if (!service) return;
      const layer = serviceLayers(service).find((entry) => entry.id === id);
      if (!layer || layer.unsupported) return;
      setFocusedId(id);
      setSelected((previous) =>
        service.multiple
          ? previous.includes(id)
            ? previous.filter((entry) => entry !== id)
            : [...previous, id]
          : [id]
      );
    },
    [service]
  );

  const suggestedName = service ? defaultLayerName(service, selected) : "";
  const name = customName ?? suggestedName;

  const reset = useCallback(() => {
    attempt.current += 1;
    setAddressValue("");
    setStatus("idle");
    clearService();
    setIsBusy(false);
    setSelectedFolder(undefined);
    folderInitialized.current = false;
  }, [clearService]);

  const hasPick = !!service && (isDirect(service) || pickedLayers(service, selected).length > 0);
  const isImport = service?.mode === "copy";

  const submit = useCallback(async () => {
    if (!service || !selectedFolder || !hasPick || !name.trim()) return;
    const request = buildLayerRequest(service, selected, { name: name.trim(), folderId: selectedFolder.id });
    try {
      setIsBusy(true);
      if (request.kind === "import") {
        // `layer_import` adds the layer to the project itself once the features are in.
        const job = await createLayer(request.payload, projectId);
        if (job?.jobID) {
          mutateJobs();
          dispatch(addRunningJobIds([job.jobID]));
        }
        toast.info(t("connect_service_import_started", { name: request.payload.name }));
      } else {
        const layer = await createRasterLayer(request.payload, projectId);
        if (projectId) {
          await addProjectLayers(projectId, [layer.id]);
          mutateProjectLayers();
          mutateProject();
        }
        toast.success(t("connect_service_added", { name: request.payload.name }));
      }
      refreshContentFeed();
      reset();
      onDone?.();
    } catch (error) {
      console.error("error", error);
      toast.error(t("error_adding_external_dataset"));
      setIsBusy(false);
    }
  }, [
    service,
    selectedFolder,
    hasPick,
    name,
    selected,
    projectId,
    mutateJobs,
    dispatch,
    t,
    mutateProjectLayers,
    mutateProject,
    reset,
    onDone,
  ]);

  const reason = !service
    ? t("connect_service_connect_first")
    : !hasPick
      ? t(service.multiple ? "connect_service_pick_layers" : "connect_service_pick_layer")
      : !name.trim()
        ? t("connect_service_name_needed")
        : !selectedFolder
          ? t("connect_service_folder_needed")
          : undefined;

  const action = useMemo(
    () => ({
      label: t(isImport ? "connect_service_import" : "add_layer"),
      disabled: !!reason || isBusy,
      reason,
      notice,
      // What adding it does, once there is a service to add.
      note: service ? t(isImport ? "connect_service_copy" : "connect_service_live") : undefined,
      run: submit,
    }),
    [t, isImport, reason, isBusy, notice, service, submit]
  );

  return {
    action,
    isBusy,
    reset,
    connect: {
      address,
      setAddress,
      connect,
      status,
      failure,
      service,
      selected,
      toggleLayer,
      focusedId,
      name,
      setName: setCustomName,
      folders,
      selectedFolder,
      setSelectedFolder,
    },
  };
};
