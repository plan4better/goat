"""Template schemas: input declarations (T5) plus the save/list/read/update
request and response models for the template API (T1, T2, T4, T6, T8)."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.schemas.content import ContentCreator

_LAYER_TYPES = ("feature", "table", "raster")

TemplateInputMode = Literal["ship", "ask", "copy"]
"""How a template input's dataset reaches a user (see ``TemplateInput``)."""

# The modes whose input keeps the author's dataset bound: the user reads it
# on use, so the author must be able to read it on save, and its audience is
# widened by a template grant or a team/organisation destination (T6).
DATASET_MODES: tuple[str, ...] = ("ship", "copy")


def normalize_layer_type(value: Any) -> Any:
    """``value`` when it is one of the three layer types, else ``None``.

    Workflow configs are stored unvalidated, so a dataset node's
    ``layerType`` can hold any spelling — older nodes carry ``"layer"``,
    saved before the web narrowed the field to feature|table|raster. An
    unrecognised value means "type unknown" rather than an error, since
    nothing downstream can act on it either way. The comparison is exact:
    the web writes these three lowercase, so ``"FEATURE"`` is unknown too.
    """
    return value if value in _LAYER_TYPES else None


class DetectedInput(BaseModel):
    """A dataset-node reference found while scanning a workflow config.

    Produced by ``core.templates.snapshot.detect_workflow_inputs``. Detection
    only reads the config: it knows nothing about the author's ship/ask
    choice, or the layer's catalog provenance — the caller turns each one
    into a ``TemplateInput`` after deciding ``mode`` and looking up
    ``from_catalog`` from the database. ``layer_type`` holds ``None`` for a
    node whose stored ``layerType`` is not one of the three types.
    """

    key: str
    label: str
    layer_id: UUID
    project_layer_id: int | None = None
    layer_type: Literal["feature", "table", "raster"] | None = None
    geometry_type: str | None = None

    @field_validator("layer_type", mode="before")
    @classmethod
    def _normalize_layer_type(cls, value: Any) -> Any:
        return normalize_layer_type(value)


class TemplateInput(BaseModel):
    """A declared input slot on a saved template (T5).

    ``key`` is the stable id a snapshot uses to address the slot again later:
    ``"node:<dataset node id>"`` for a workflow dataset (the first of the
    dataset nodes that use it), or
    ``"param:<node id>:<param>"`` for a tool-parameter slot (not produced by
    this module yet), or ``"layer:<layer id>"`` for a project payload's
    dataset. ``mode`` is the author's choice at save time: "ship"
    keeps ``layer_id`` bound so the dataset resolves for every user who can
    read it (catalog datasets resolve for everyone through promote-on-use),
    read-only unless shared with them as editor; "ask" clears ``layer_id``
    and turns the reference into a named, typed slot the user fills in on
    use (workflow payloads only); "copy" keeps ``layer_id`` bound like
    "ship", and on use gives every user their own editable copy of that
    dataset (the ``layer_copy`` job), with its rows when ``copy_content``
    is true or as an empty layer with the same columns otherwise.
    ``copy_content`` is only read for "copy". ``layer_type`` holds ``None``
    for an input whose type is not one of the three types.

    The two dataset flags are recomputed server-side from the layer row,
    never trusted from the client: ``from_catalog`` (a catalog dataset,
    ``catalog_external_uid`` set) and ``public_read`` (a public dataset,
    readable by every signed-in user). Either one lets the dataset ship
    with a published GOAT template.
    """

    key: str
    label: str
    mode: TemplateInputMode
    copy_content: bool = True
    layer_id: UUID | None = None
    layer_type: Literal["feature", "table", "raster"] | None = None
    geometry_type: str | None = None
    from_catalog: bool = False
    public_read: bool = False

    @property
    def empty_copy(self) -> bool:
        """A "copy" without its rows: users get only the dataset's columns,
        field settings and style, so the dataset itself never has to be
        readable by them (not made public on publish, not granted on save or
        share). The copy job reads it on the template's behalf."""
        return self.mode == "copy" and not self.copy_content

    @field_validator("layer_type", mode="before")
    @classmethod
    def _normalize_layer_type(cls, value: Any) -> Any:
        return normalize_layer_type(value)


class TemplateSource(BaseModel):
    """Where a template is saved from (T8), or re-snapshotted from (refresh).

    ``workflow_id``/``layout_id`` are required for their matching ``kind``
    and ignored otherwise; a ``project`` source needs only ``project_id``.
    """

    kind: Literal["workflow", "layout", "project"]
    project_id: UUID
    workflow_id: UUID | None = None
    layout_id: UUID | None = None


class TemplateSourceInfo(BaseModel):
    """Where a template was saved from, resolved for the caller: names for
    the edit dialog's links, and whether "Update from source" can work —
    the project must still be readable and the workflow/layout still exist.
    Only ``GET /template/{id}`` fills this in; list rows carry ``None``."""

    kind: Literal["workflow", "layout", "project"]
    project_id: UUID | None
    project_name: str | None
    workflow_id: UUID | None = None
    workflow_name: str | None = None
    layout_id: UUID | None = None
    layout_name: str | None = None
    available: bool


class TemplatePreviewRequest(BaseModel):
    """Body of ``POST /template/preview``: what would saving this source
    into ``folder_id`` detect and require."""

    source: TemplateSource
    folder_id: UUID


class DatasetShareLine(BaseModel):
    """One row of ``TemplatePreview.datasets_needing_share`` (T6): a shipped
    dataset the destination space's audience cannot read yet."""

    layer_id: UUID
    name: str
    from_catalog: bool
    current_audience: Literal["personal", "team", "organization"]


class TemplatePreview(BaseModel):
    """Response of ``POST /template/preview``: what saving ``source`` into
    ``folder_id`` would detect, without writing anything."""

    detected_inputs: list[TemplateInput]
    kinds: list[str]
    datasets_needing_share: list[DatasetShareLine]


class TemplateCreate(BaseModel):
    """Body of ``POST /template`` (T8): the author's save-dialog choices."""

    name: str
    description: str | None = None
    categories: list[str] = []
    folder_id: UUID
    source: TemplateSource
    inputs: list[TemplateInput] = []
    share_datasets: list[UUID] = []
    thumbnail_url: str | None = None
    page_size: str | None = Field(
        default=None,
        description="For a layout payload: the page the layout prints on "
        '("A4", "A3", "Letter", …), read off the config by the client and '
        "stored verbatim. It is what a card labels the template with for a "
        "reader who cannot see the frozen config.",
    )
    page_orientation: Literal["portrait", "landscape"] | None = None


class TemplateUpdate(BaseModel):
    """Body of ``PATCH /template/{id}``: metadata only — the payload itself
    only changes through ``refresh``."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    categories: list[str] | None = None
    thumbnail_url: str | None = None
    page_size: str | None = None
    page_orientation: Literal["portrait", "landscape"] | None = None
    folder_id: UUID | None = Field(
        default=None,
        description="Move the template to this folder. None means unchanged; "
        "the target must belong to the template's own space (its root/home "
        "folder is a valid target).",
    )


class TemplateRead(BaseModel):
    """Response shape for the template API's read routes."""

    id: UUID
    name: str
    description: str | None
    categories: list[str]
    thumbnail_url: str | None
    page_size: str | None = Field(
        default=None,
        description="For a layout payload: the page the layout prints on, as "
        "the client stored it. Returned to every reader, so a card can label "
        "the template without the frozen config. None for a workflow or "
        "project payload.",
    )
    page_orientation: Literal["portrait", "landscape"] | None = None
    page_width_mm: float | None = Field(
        default=None,
        description="For a layout payload: the sheet's width in millimetres, "
        "turned the way it prints, read off the frozen config on every read "
        "so a Custom page is described as well as a named one.",
    )
    page_height_mm: float | None = None
    space_id: UUID
    folder_id: UUID
    created_by: ContentCreator | None
    payload_kind: Literal["workflow", "layout", "project"]
    kinds: list[str]
    inputs: list[TemplateInput]
    ships_data: bool
    catalog_status: Literal["none", "proposed", "published", "declined"]
    source_ref: dict[str, Any]
    source: TemplateSourceInfo | None = None
    my_role: Literal["owner", "editor", "viewer"]
    shared_into_space_id: UUID | None = Field(
        default=None,
        description="For a template outside the caller's spaces: the caller's "
        "team or organization space it is shared into, through a grant to that "
        "team or organization on the template or on a folder above it. The "
        "template browser shows it on that space's shelf. None for a template "
        "in the caller's own spaces and for one shared with the caller alone.",
    )
    created_at: datetime
    updated_at: datetime
    config: dict[str, Any] | None = Field(
        default=None,
        description="Only populated on `GET /template/{id}?include_config=true` "
        "for an owner/editor caller, and only for a workflow/layout payload "
        "(a project payload's config lives on the frozen source project).",
    )
    datasets_needing_share: list[DatasetShareLine] = Field(
        default_factory=list,
        description="Only populated by `POST /template/{id}/refresh`: shipped "
        "inputs the reconciled config still ships but that are not yet "
        "readable by the template's own space — refresh does not "
        "auto-grant these (T6), it only reports them.",
    )


class TemplatePage(BaseModel):
    """Response of ``GET /template``: one page of the caller's readable
    templates."""

    items: list[TemplateRead]
    total: int


class TemplateCategoryFacet(BaseModel):
    """One row of ``GET /template/categories``: a category in use on the
    caller's readable templates, and how many of them carry it.

    Categories are free-form strings grouped case-insensitively; ``name``
    is the spelling of the template that first used it (earliest
    ``created_at``), so "Mobility" and "mobility" are one row.
    """

    name: str
    count: int


class TemplateUseRequest(BaseModel):
    """Body of ``POST /template/{id}/use`` (T7): where to land the
    template's payload and how to fill its inputs.

    Exactly one of ``project_id`` (insert into that existing project —
    workflow/layout payloads only) or ``target_folder_id`` (create a new
    project there) is required; a project payload always creates a new
    project, so it requires ``target_folder_id``. ``bindings`` maps an
    input's ``key`` to a layer the caller chose — filling an "ask" slot,
    or overriding a "ship" input the caller cannot read (or simply wants
    to replace with their own dataset).
    """

    project_id: UUID | None = None
    target_folder_id: UUID | None = None
    name: str | None = None
    description: str | None = Field(
        None,
        description="For a workflow payload: the created workflow's description. "
        "None leaves it empty.",
    )
    bindings: dict[str, UUID] = {}


class TemplateCopyJob(BaseModel):
    """One "copy" dataset of a used template: the ``layer_copy`` job that
    gives the caller their own editable copy of it.

    ``layer_project_ids`` are the project entries that show the dataset
    and that the job points at the copy once it has written it; until
    then they show the author's dataset, read-only. ``job_id`` is the
    processes job to poll; ``None`` together with ``error`` when the job
    did not start (``source_not_readable``: the caller may not read the
    dataset, ``copy_not_started``: the processes service refused or could
    not be reached). Either way the entries keep showing the source.
    """

    key: str
    source_layer_id: UUID
    layer_project_ids: list[int]
    copy_content: bool
    job_id: str | None = None
    error: Literal["source_not_readable", "copy_not_started"] | None = None


class TemplateUseResult(BaseModel):
    """Response of ``POST /template/{id}/use``: what got created, what got
    linked, which inputs still need the caller's attention, and the copy
    jobs started for the template's "copy" datasets."""

    project_id: UUID
    workflow_id: UUID | None = None
    layout_id: UUID | None = None
    added_layer_project_ids: list[int] = []
    unresolved_inputs: list[TemplateInput] = []
    copy_jobs: list[TemplateCopyJob] = []


class TemplateUsePreviewRequest(BaseModel):
    """Body of ``POST /template/{id}/use/preview``: the existing project a
    workflow template would be used in, and the ``bindings`` the use would
    get (as in ``TemplateUseRequest``)."""

    project_id: UUID
    bindings: dict[str, UUID] = {}


class TemplateUsePreview(BaseModel):
    """Response of ``POST /template/{id}/use/preview``: the workflow config a
    use with the same bindings would write, and the inputs it would leave
    unresolved. A layer the use would link into the project anew has no
    ``projectLayerId`` in it yet: the entry does not exist before the use.
    For the same reason, the tool settings that name an empty copy's dataset
    by its entry, which the use points at the copy's new entry, are cleared
    (``None``), as for an input still to be chosen."""

    config: dict[str, Any]
    unresolved_inputs: list[TemplateInput] = []


class TemplateGrantCreate(BaseModel):
    """Body of ``POST /template/{id}/grant`` (T3/T6): grant a role on a
    template to a user, team, or organization. Owner only."""

    grantee_type: Literal["user", "team", "organization"]
    grantee_id: UUID
    role: Literal["template-viewer", "template-editor"]


class TemplateGrantRead(BaseModel):
    """One row of ``GET /template/{id}/grant``: a direct grant on a template,
    ``id`` being the ``grant_id`` used by ``DELETE /template/{id}/grant/{grant_id}``."""

    id: UUID
    grantee_type: Literal["user", "team", "organization"]
    grantee_id: UUID
    grantee_name: str
    role: Literal["template-viewer", "template-editor"]
    granted_by: UUID | None
    created_at: datetime


class TemplateGrantsResponse(BaseModel):
    """Response of ``GET /template/{id}/grant``: every direct grant on the
    template."""

    grants: list[TemplateGrantRead]
