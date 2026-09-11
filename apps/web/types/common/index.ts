export type NestedPartial<T> = {
  [P in keyof T]?: NestedPartial<T[P]>;
};

export enum ContentActions {
  INFO = "info",
  EDIT_METADATA = "editMetadata",
  MOVE_TO_FOLDER = "moveToFolder",
  DOWNLOAD = "download",
  SHARE = "share",
  EXPORT = "export",
  DUPLICATE = "duplicate",
  DELETE = "delete",
  TABLE = "table",
  UPDATE = "update",
  OPEN = "open",
  DETAILS = "details",
  MOVE = "move",
  RENAME = "rename",
  TRANSFER = "transfer",
  USE_TEMPLATE = "useTemplate",
  EDIT_TEMPLATE = "editTemplate",
  UPDATE_TEMPLATE_FROM_SOURCE = "updateTemplateFromSource",
  REGENERATE_THUMBNAIL = "regenerateThumbnail",
  PUBLISH_TO_GOAT_CATALOG = "publishToGoatCatalog",
  UNPUBLISH_FROM_GOAT_CATALOG = "unpublishFromGoatCatalog",
}

export enum MapLayerActions {
  CHART = "chart",
  COPY_STYLE = "copyStyle",
  DUPLICATE = "duplicate",
  EDIT_FEATURES = "editFeatures",
  PASTE_STYLE = "pasteStyle",
  RENAME = "rename",
  ZOOM_TO = "zoomTo",
  PROPERTIES = "properties",
  STYLE = "style",
}

export enum LayerStyleActions {
  RESET = "reset",
  SAVE_AS_DEFAULT = "saveAsDefault",
}

export enum FilterExpressionActions {
  DELETE = "delete",
  DUPLICATE = "duplicate",
}

export enum OrgMemberActions {
  EDIT = "edit",
  DELETE = "delete",
  TRANSFER_OWNERSHIP = "transferOwnership",
  CANCEL_INVITATION = "cancelInvitation",
}

export enum TeamMemberActions {
  DELETE = "delete",
  CANCEL_INVITATION = "cancelInvitation",
}

export type ResponseResult = {
  message: string;
  status?: "error" | "success";
};
