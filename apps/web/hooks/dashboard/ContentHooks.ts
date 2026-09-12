import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { isBundleTile } from "@/lib/api/bundles";
import type { Folder } from "@/lib/validations/folder";
import type { Layer } from "@/lib/validations/layer";
import type { Project } from "@/lib/validations/project";

import { ContentActions } from "@/types/common";

import type { PopperMenuItem } from "@/components/common/PopperMenu";

type ItemWithSharedWith = {
  shared_with?: {
    teams?: { role?: string }[];
    organizations?: { role?: string }[];
  };
  folder_id?: string;
};

export const useContentMoreMenu = () => {
  const { t } = useTranslation("common");
  const getMoreMenuOptions = function (
    contentType: "project" | "layer",
    item: Project | Layer,
    currentUserId?: string,
    folders?: Folder[]
  ) {
    // When currentUserId is absent (profile not yet loaded) treat as owner to avoid
    // hiding menu options before auth resolves; enableActions gates the button itself.
    const isOwner = !currentUserId || item.owned_by?.id === currentUserId;

    // Bundles get their own action set (they are not real layers); the
    // bundle is the unit for these actions (move/share/delete cascade to its
    // member layers). Owner only for now.
    if (isBundleTile(item)) {
      return isOwner
        ? [
            {
              id: ContentActions.EDIT_METADATA,
              label: t("edit_metadata"),
              icon: ICON_NAME.EDIT,
            },
            {
              id: ContentActions.MOVE_TO_FOLDER,
              label: t("move_to_folder"),
              icon: ICON_NAME.FOLDER,
            },
            {
              id: ContentActions.SHARE,
              label: t("share"),
              icon: ICON_NAME.SHARE,
            },
            {
              id: ContentActions.DELETE,
              label: t("delete"),
              icon: ICON_NAME.TRASH,
              color: "error.main",
            },
          ]
        : [];
    }
    const sw = (item as ItemWithSharedWith).shared_with;
    const folderId = (item as ItemWithSharedWith).folder_id;
    const folderRole = folders?.find((f) => f.id === folderId)?.role;
    const isEditor =
      isOwner ||
      sw?.teams?.some((t) => t.role?.endsWith("-editor")) ||
      sw?.organizations?.some((o) => o.role?.endsWith("-editor")) ||
      folderRole === "folder-editor" ||
      folderRole === "folder-owner";

    if (contentType === "layer") {
      const layerItem = item as Layer;
      const layerMoreMenuOptions: PopperMenuItem[] = [
        ...(isEditor
          ? [
              {
                id: ContentActions.EDIT_METADATA,
                label: t("edit_metadata"),
                icon: ICON_NAME.EDIT,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                id: ContentActions.MOVE_TO_FOLDER,
                label: t("move_to_folder"),
                icon: ICON_NAME.FOLDER,
              },
            ]
          : []),
        ...(layerItem?.type === "feature" || layerItem?.type === "table"
          ? [
              {
                id: ContentActions.DOWNLOAD,
                label: t("download"),
                icon: ICON_NAME.DOWNLOAD,
              },
              ...(isEditor
                ? [
                    {
                      id: ContentActions.UPDATE,
                      label: t("update"),
                      icon: ICON_NAME.REFRESH,
                    },
                  ]
                : []),
            ]
          : []),
        ...(isOwner
          ? [
              {
                id: ContentActions.SHARE,
                label: t("share"),
                icon: ICON_NAME.SHARE,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                id: ContentActions.DELETE,
                label: t("delete"),
                icon: ICON_NAME.TRASH,
                color: "error.main",
              },
            ]
          : []),
      ];
      return layerMoreMenuOptions;
    }

    if (contentType === "project") {
      const projectMoreMenuOptions: PopperMenuItem[] = [
        ...(isEditor
          ? [
              {
                id: ContentActions.EDIT_METADATA,
                label: t("edit_metadata"),
                icon: ICON_NAME.EDIT,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                id: ContentActions.MOVE_TO_FOLDER,
                label: t("move_to_folder"),
                icon: ICON_NAME.FOLDER,
              },
              {
                id: ContentActions.SHARE,
                label: t("share"),
                icon: ICON_NAME.SHARE,
              },
            ]
          : []),
        {
          id: ContentActions.EXPORT,
          label: t("export"),
          icon: ICON_NAME.DOWNLOAD,
        },
        {
          id: ContentActions.DUPLICATE,
          label: t("duplicate"),
          icon: ICON_NAME.COPY,
        },
        ...(isOwner
          ? [
              {
                id: ContentActions.DELETE,
                label: t("delete"),
                icon: ICON_NAME.TRASH,
                color: "error.main",
              },
            ]
          : []),
      ];
      return projectMoreMenuOptions;
    }
    return [];
  };

  const [activeContent, setActiveContent] = useState<Project | Layer>();
  const [moreMenuState, setMoreMenuState] = useState<PopperMenuItem>();

  const closeMoreMenu = () => {
    setActiveContent(undefined);
    setMoreMenuState(undefined);
  };

  const openMoreMenu = (menuItem: PopperMenuItem, contentItem: Project | Layer) => {
    setActiveContent(contentItem);
    setMoreMenuState(menuItem);
  };

  return {
    getMoreMenuOptions,
    activeContent,
    moreMenuState,
    closeMoreMenu,
    openMoreMenu,
  };
};

export const useFileUpload = () => {
  const { t } = useTranslation("common");
  const [fileUploadError, setFileUploadError] = useState<string | undefined>(undefined);
  const [fileValue, setFileValue] = useState<File | undefined>(undefined);
  const [datasetType, setDatasetType] = useState<string | undefined>(undefined);

  const acceptedFileTypes = useMemo(() => {
    return [".gpkg", ".geojson", ".zip", ".kml", ".csv", ".xlsx", ".parquet"];
  }, []);

  const handleChange = useCallback(
    (file: File | null) => {
      setFileUploadError(undefined);
      setFileValue(undefined);
      if (file && file.name) {
        const isAcceptedType = acceptedFileTypes.some((type) => file.name.endsWith(type));
        if (!isAcceptedType) {
          setFileUploadError(t("invalid_file_type"));
          return;
        }

        // Autodetect dataset type
        const isFeatureLayer =
          file.name.endsWith(".gpkg") ||
          file.name.endsWith(".geojson") ||
          file.name.endsWith(".shp") ||
          file.name.endsWith(".kml") ||
          file.name.endsWith(".parquet");
        const isTable = file.name.endsWith(".csv") || file.name.endsWith(".xlsx");
        if (isFeatureLayer) {
          setDatasetType("feature_layer");
        } else if (isTable) {
          setDatasetType("table");
        }
        setFileValue(file);
      }
    },
    [acceptedFileTypes, t]
  );

  return {
    acceptedFileTypes,
    fileUploadError,
    setFileUploadError,
    fileValue,
    setFileValue,
    datasetType,
    setDatasetType,
    handleChange,
  };
};
