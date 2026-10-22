import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import type { GetContentQueryParams } from "@/lib/validations/common";
import type { Space } from "@/lib/validations/content";
import type {
  Folder,
  FolderGrantsResponse,
  FolderResponse,
  FolderSharePayload,
} from "@/lib/validations/folder";

export const FOLDERS_API_BASE_URL = new URL("api/v2/folder", process.env.NEXT_PUBLIC_API_URL).href;

export const useFolders = (queryParams?: GetContentQueryParams) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<FolderResponse>(
    [`${FOLDERS_API_BASE_URL}`, queryParams],
    fetcher
  );
  return {
    folders: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const deleteFolder = async (id: string) => {
  const response = await apiRequestAuth(`${FOLDERS_API_BASE_URL}/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to delete folder");
  }
  return await response;
};

/** Creates a folder: nested under `parentId` when given, otherwise at the
 * root of `spaceId` (a team/organisation space the caller may write to) or,
 * with neither, at the root of the caller's personal space. `space_id` is
 * only sent when passed, so the personal-space default is untouched. */
export const createFolder = async (
  name: string,
  parentId?: string | null,
  spaceId?: string | null
): Promise<Folder> => {
  const body: { name: string; parent_id?: string; space_id?: string } = { name };
  if (parentId) body.parent_id = parentId;
  else if (spaceId) body.space_id = spaceId;
  const response = await apiRequestAuth(FOLDERS_API_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Failed to create folder");
  return (await response.json()) as Folder;
};

export const updateFolder = async (
  id: string,
  payload: { name?: string; parent_id?: string | null }
): Promise<Folder> => {
  const response = await apiRequestAuth(`${FOLDERS_API_BASE_URL}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Failed to update folder");
  return (await response.json()) as Folder;
};

export const getWritableFolders = (folders: FolderResponse | undefined) =>
  folders?.filter((f) => f.is_owned || f.role === "folder-editor" || f.role === "folder-owner") ?? [];

/** The writable folders plus every folder of a team or organisation space the caller edits. */
export const getWritableDestinations = (folders: FolderResponse | undefined, spaces: Space[]) => {
  const editable = new Set(
    spaces
      .filter((s) => s.kind !== "personal" && (s.my_role === "owner" || s.my_role === "editor"))
      .map((s) => s.id)
  );
  return (
    folders?.filter(
      (f) =>
        f.is_owned ||
        f.role === "folder-editor" ||
        f.role === "folder-owner" ||
        (!!f.space_id && editable.has(f.space_id))
    ) ?? []
  );
};

/** The team/organisation spaces the caller reaches through membership, keyed
 * by space id and recognised by each space's own `home` root folder — a
 * root the caller did not create. Folders in these spaces belong to a
 * Content-page space, not to "My Content" and not to a folder grant, so the
 * older Projects/Datasets pages exclude them from all three of their own
 * sections. */
export const memberSpaceIds = (folders: FolderResponse | undefined): Set<string> =>
  new Set(
    (folders ?? [])
      .filter((f) => !f.is_owned && f.parent_id === null && f.name === "home" && !!f.space_id)
      .map((f) => f.space_id as string)
  );

export const useFolderGrants = (folderId: string | null) => {
  return useSWR<FolderGrantsResponse>(folderId ? `${FOLDERS_API_BASE_URL}/${folderId}/share` : null, fetcher);
};

export const shareFolderGrant = async (
  folderId: string,
  payload: FolderSharePayload
): Promise<FolderGrantsResponse> => {
  const response = await apiRequestAuth(`${FOLDERS_API_BASE_URL}/${folderId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to share folder");
  }
  return response.json();
};

export const deleteFolderGrant = async (
  folderId: string,
  granteeType: string,
  granteeId: string
): Promise<void> => {
  const response = await apiRequestAuth(
    `${FOLDERS_API_BASE_URL}/${folderId}/share/${granteeType}/${granteeId}`,
    { method: "DELETE" }
  );
  if (!response.ok && response.status !== 204) {
    throw new Error("Failed to remove folder access");
  }
};
