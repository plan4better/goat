"use client";

import { useSpaces } from "@/lib/api/content";
import { useFolders } from "@/lib/api/folders";
import { lastRoleSegment } from "@/lib/utils/content";
import type { ContentItem, ContentRole, Space } from "@/lib/validations/content";
import type { Project } from "@/lib/validations/project";

import ShareDialog from "@/components/modals/content/ShareDialog";

const CONTENT_ROLES: ContentRole[] = ["owner", "editor", "viewer"];

/** The project as the Content page lists it. The project read names its role
 * per resource (`project-owner`), a content row plainly (`owner`). */
const asContentItem = (project: Project): ContentItem => {
  const role = lastRoleSegment(project.my_role ?? "") as ContentRole;
  return {
    type: "project",
    id: project.id,
    name: project.name,
    space_id: project.space_id ?? "",
    folder_id: project.folder_id,
    created_at: project.created_at ?? "",
    updated_at: project.updated_at ?? "",
    my_role: CONTENT_ROLES.includes(role) ? role : "viewer",
    shared_with: null,
    thumbnail_url: project.thumbnail_url,
    is_public: false,
    is_shortcut: false,
    restricted: project.restricted ?? false,
    restricted_inherited: project.restricted_inherited ?? false,
  };
};

/**
 * The Content page's Share dialog, opened from inside a project.
 *
 * A project shared with someone can live in a space they are not a member of,
 * so their own space list may not hold it; the project read carries the
 * space's kind and name, which is what the dialog shows of it.
 */
const ProjectShareDialog = ({ project, onClose }: { project: Project; onClose: () => void }) => {
  const { spaces } = useSpaces();
  const { folders } = useFolders({});

  const space: Space = spaces.find((entry) => entry.id === project.space_id) ?? {
    id: project.space_id ?? "",
    kind: project.space_kind ?? "personal",
    name: project.space_name ?? "",
    default_role: "viewer",
  };

  return (
    <ShareDialog item={asContentItem(project)} space={space} folders={folders ?? []} onClose={onClose} />
  );
};

export default ProjectShareDialog;
