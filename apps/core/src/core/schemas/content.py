"""Trash schemas: `GET /content/trash` + `POST /content/restore`.

Also the unified feed: `GET /content`.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ResourceType = Literal["layer", "project", "folder", "bundle", "template"]
ContentView = Literal["space", "shared_with_me", "shared_with_space", "recent"]
# The sort keys and directions the feed accepts. `crud_content._validate_order`
# holds the same allow-list and maps each to the SQL it formats into the
# query; these types reject anything else at the request boundary (422)
# before it ever gets there.
ContentOrderBy = Literal["updated_at", "created_at", "name", "last_opened_at"]
ContentOrder = Literal["ascendent", "descendent"]


class TrashItem(BaseModel):
    """One restorable entry in the trash listing.

    A trashed item whose own folder is also trashed is not listed
    separately — it is folded into that folder's entry (restoring the
    folder restores its whole subtree). See `CRUDTrash.list`.
    """

    type: ResourceType
    id: UUID
    name: str
    deleted_at: datetime
    purge_after: datetime = Field(
        description="When the purge task removes this item for good "
        "(30 days after `deleted_at`)."
    )


class RestoreItem(BaseModel):
    type: ResourceType
    id: UUID


class RestoreRequest(BaseModel):
    items: list[RestoreItem]


class ShareEntry(BaseModel):
    """One direct grant on a resource, as `fetch_grants_by_resource`
    (core/content.py) buckets it — a team/organisation/user grantee shaped
    identically so a caller can render all three kinds the same way."""

    role: str
    id: UUID
    name: str | None = None
    avatar: str | None = None


class SharedWith(BaseModel):
    """Every direct grant on one resource, bucketed by grantee kind. Mirrors
    the dict shape `fetch_grants_by_resource` returns per resource id."""

    teams: list[ShareEntry] = Field(default_factory=list)
    organizations: list[ShareEntry] = Field(default_factory=list)
    users: list[ShareEntry] = Field(default_factory=list)


class ContentCreator(BaseModel):
    """The person who created a feed row — `user_id` on the content table,
    resolved to what a card or row can draw: a display name and a picture."""

    id: UUID
    name: str
    avatar: str | None = None


class ContentItem(BaseModel):
    """One row in the unified feed (`GET /content`) — a folder, project,
    layer or bundle the caller may read."""

    type: ResourceType
    id: UUID
    name: str
    space_id: UUID
    folder_id: UUID | None = Field(
        default=None,
        description="Parent folder id — a folder's own parent for a "
        "`type: folder` row, the containing folder for anything else.",
    )
    updated_at: datetime
    created_at: datetime
    my_role: Literal["owner", "editor", "viewer"]
    created_by: ContentCreator | None = Field(
        default=None,
        description="Who created the row. None when the creating account no "
        "longer exists.",
    )
    shared_with: SharedWith | None = None
    thumbnail_url: str | None = Field(
        default=None,
        description="A URL the client can load: a presigned link for a "
        "stored thumbnail, or the default artwork for this row's kind.",
    )
    is_public: bool = Field(
        default=False,
        description="A published public snapshot exists for this row "
        "(projects only; always False for the other kinds).",
    )
    layer_type: str | None = None
    feature_layer_geometry_type: str | None = None
    data_type: str | None = Field(
        default=None,
        description="Layers only: the source format (wms, wmts, xyz, cog, wfs); "
        "None for data uploaded or created in GOAT.",
    )
    is_linked: bool = Field(
        default=False,
        description="Layers only: drawn live from someone else's service (a "
        "stored `url`), rather than held by GOAT. A WFS import is a copy, so "
        "it is not linked.",
    )
    source_host: str | None = Field(
        default=None,
        description="Layers only: the host a linked layer is drawn from, or a "
        "WFS import was copied from. The host alone: a full tile URL can carry "
        "an API key.",
    )
    is_shortcut: bool = Field(
        default=False,
        description="True for a `content_shortcut` row left behind after a "
        "transfer — a badged pointer at an item that now lives elsewhere, "
        "shown with that item's real name/type/thumbnail.",
    )
    restricted: bool = Field(
        default=False,
        description="Restricted (D9): members of this row's space do not get "
        "the space default role on it — only its space owner/admin and "
        "whoever holds a grant reach it.",
    )
    restricted_inherited: bool = Field(
        default=False,
        description="Restricted through an ancestor folder, or through a "
        "bundle holding this layer; toggled there, not here.",
    )
    template_payload_kind: Literal["workflow", "layout", "project"] | None = Field(
        default=None,
        description="`type: template` rows only: what the template's config "
        "carries (T1). None for every other row.",
    )
    template_kinds: list[Literal["project", "dashboard", "workflow", "layout"]] = Field(
        default_factory=list,
        description="`type: template` rows only: the kinds shown on the "
        "card, derived from `template_payload_kind` (T1). Empty for every "
        "other row.",
    )
    template_catalog_status: (
        Literal["none", "proposed", "published", "declined"] | None
    ) = Field(
        default=None,
        description="`type: template` rows only: the GOAT catalog shelf "
        "state (T4). None for every other row.",
    )
    template_ships_data: bool = Field(
        default=False,
        description="`type: template` rows only: true once any declared "
        "input (T5) is a shipped, catalog-origin dataset. Always False for "
        "every other row.",
    )


class RestrictedUpdate(BaseModel):
    restricted: bool = Field(
        description="True closes the folder or item off from the space "
        "default role; False lifts it."
    )


class ContentPage(BaseModel):
    items: list[ContentItem]
    total: int
    page: int
    size: int


#: What `GET /content/search` finds: projects, datasets (layers and bundles)
#: and the workflows and print layouts inside projects.
ContentSearchType = Literal["project", "layer", "bundle", "workflow", "layout"]
#: Why a hit matched: its own name, the name of its project (workflows and
#: layouts), a folder it sits in (or one above it), or its owner's name.
ContentSearchMatch = Literal["name", "project", "folder", "owner"]


class ContentSearchHit(BaseModel):
    """One item the caller can open whose name, project, folder or owner
    matches a search."""

    type: ContentSearchType
    id: UUID
    name: str
    description: str | None = None
    project_id: UUID | None = Field(
        default=None,
        description="Workflows and layouts: the project they belong to.",
    )
    project_name: str | None = Field(
        default=None,
        description="Workflows and layouts: the name of their project.",
    )
    updated_at: datetime
    my_role: Literal["owner", "editor", "viewer"]
    created_by: ContentCreator | None = Field(
        default=None,
        description="Who owns the item (for a workflow or layout: its "
        "project). None when the account no longer exists.",
    )
    space_kind: Literal["personal", "team", "organization"]
    space_name: str | None = Field(
        default=None,
        description="The team's or organisation's name; for a personal "
        "space, its owner's name.",
    )
    folder_path: list[str] = Field(
        default_factory=list,
        description="The folders the item sits in, outermost first (for a "
        "workflow or layout: its project's).",
    )
    matched_on: list[ContentSearchMatch]
    layer_type: str | None = Field(
        default=None, description="Layers only: feature, table or raster."
    )
    geometry_type: str | None = Field(
        default=None, description="Feature layers only: point, line or polygon."
    )
    bundle_type: str | None = Field(
        default=None, description="Bundles only: what kind of bundle (e.g. gtfs)."
    )


class ContentSearchPage(BaseModel):
    items: list[ContentSearchHit]
    total: int
    page: int
    size: int
