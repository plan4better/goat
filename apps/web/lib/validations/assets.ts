import { z } from "zod";

export const ASSETS_MAX_FILE_SIZE_MB = 4;
export const DOCUMENTS_MAX_FILE_SIZE_MiB = 50;

export const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
];

export const DOCUMENT_ACCEPT = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/msword": [".doc"],
};

/** The icon types core takes, by MIME type with their extensions (browsers name an .ico either way). */
export const ICON_ACCEPT: Record<string, string[]> = {
  "image/svg+xml": [".svg"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/bmp": [".bmp"],
  "image/x-icon": [".ico"],
  "image/vnd.microsoft.icon": [".ico"],
};

/** The `accept` of an icon file input: the types and their extensions. */
export const ICON_ACCEPT_LIST = [...new Set(Object.entries(ICON_ACCEPT).flat(2))].join(",");

/** Whether core takes the file as an icon: by its extension (as core reads it), else by its type. */
export function isIconFile(file: { name: string; type: string }): boolean {
  const extension = /\.[^.]+$/.exec(file.name)?.[0].toLowerCase();
  return extension ? Object.values(ICON_ACCEPT).flat().includes(extension) : file.type in ICON_ACCEPT;
}

export const assetTypeEnum = z.enum(["image", "icon", "document"]);

export const uploadedAssetSchema = z.object({
  id: z.string().uuid().optional(),
  file_name: z.string().max(255),
  display_name: z.string().max(255).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  folder_id: z.string().uuid().nullable().optional(),
  user_id: z.string().uuid(),
  url: z.string().url(),
  mime_type: z.string().max(100),
  file_size: z.number().int().nonnegative(),
  asset_type: assetTypeEnum,
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export type UploadedAsset = z.infer<typeof uploadedAssetSchema>;
export type AssetTypeEnum = z.infer<typeof assetTypeEnum>;
