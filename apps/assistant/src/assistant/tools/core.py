"""The core pack (spec §7.2): loaded on every surface, including pages without
an adapter."""

import asyncio
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
from pydantic_ai.exceptions import ToolFailed

from assistant.context import SURFACE_LABELS, dump_context
from assistant.surfaces import SURFACES
from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.runtime import ToolEnv, ToolSpec

ALL_SURFACES = frozenset(SURFACES)
_DESCRIPTION_CHARS = 200


class NoInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


# -- core.whoami ---------------------------------------------------------------


class WhoAmI(BaseModel):
    name: str
    organization: str | None = None
    data_policy: str
    language: str
    page: str


async def _whoami(env: ToolEnv, args: NoInput) -> WhoAmI:
    async def organization() -> Any:
        try:
            return await env.call("core", "GET", "/api/v2/users/organization")
        except ServiceError as exc:
            if exc.status == 404:
                return None
            raise

    profile, org = await asyncio.gather(
        env.call("core", "GET", "/api/v2/users/profile"), organization()
    )
    name = " ".join(
        part for part in (profile.get("firstname"), profile.get("lastname")) if part
    )
    return WhoAmI(
        name=name or "unknown",
        organization=(org or {}).get("name"),
        data_policy=env.data_policy,
        language=env.locale,
        page=SURFACE_LABELS[env.page.surface],
    )


WHOAMI: ToolSpec[NoInput, WhoAmI] = ToolSpec(
    name="core.whoami",
    description=(
        "The signed-in user's name and organization, the organization's data "
        "policy for the assistant, the interface language and the current page."
    ),
    input_model=NoInput,
    output_model=WhoAmI,
    run=_whoami,
    surfaces=ALL_SURFACES,
    returns_data=False,
)


# -- core.page_context ---------------------------------------------------------


class PageContextResult(BaseModel):
    surface: str
    label: str
    context: dict[str, Any]


async def _page_context(env: ToolEnv, args: NoInput) -> PageContextResult:
    return PageContextResult(
        surface=env.page.surface,
        label=SURFACE_LABELS[env.page.surface],
        context=dump_context(env.page),
    )


PAGE_CONTEXT: ToolSpec[NoInput, PageContextResult] = ToolSpec(
    name="core.page_context",
    description=(
        "The page the user sent this message from, as the page reported it: IDs "
        "and page state such as the open project, the selected layer, the map view "
        "or the catalog search. A hint, not a permission."
    ),
    input_model=NoInput,
    output_model=PageContextResult,
    run=_page_context,
    surfaces=ALL_SURFACES,
    returns_data=False,
)


# -- core.find -----------------------------------------------------------------


class FindInput(BaseModel):
    # Stripped, so a query of spaces fails here (the model can fix it) rather
    # than in core.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query: str = Field(
        min_length=2,
        max_length=100,
        description=(
            "Part of a name, a folder or an owner's name, e.g. 'Radverkehr', "
            "'Schulung' or 'Schmidt'."
        ),
    )
    kind: Literal["any", "project", "dataset", "workflow", "layout"] = Field(
        default="any",
        description=(
            "What to look for: projects, datasets (layers and bundles), the "
            "workflows or print layouts inside projects, or all of them."
        ),
    )
    limit: int = Field(default=10, ge=1, le=20, description="Maximum results per kind.")


class Found(BaseModel):
    id: str
    name: str
    description: str | None = None
    #: A dataset's layer type (feature, table, raster), or "bundle" for a bundle.
    type: str | None = None
    #: A bundle's kind, e.g. a GTFS feed or a street network.
    bundle_type: str | None = None
    geometry_type: str | None = None
    #: Workflows and layouts: the project they are in.
    project_id: str | None = None
    project_name: str | None = None
    #: "you", or the owner's name when the search matched it; otherwise left out.
    owner: str | None = None
    #: Whose space it is in: "personal", "team <name>" or "organization <name>".
    space: str | None = None
    #: The folders it is in, outermost first, e.g. "Schulung / Tag 1".
    folder: str | None = None
    #: Why it matched when not by its own name: its folder, owner or project.
    matched_on: list[str] | None = None
    updated_at: str | None = None


class FoundTemplate(BaseModel):
    id: str
    name: str
    description: str | None = None
    #: What using it creates: a project, a workflow or a print layout.
    kind: str
    owner: str | None = None
    #: Published in GOAT's template catalog, rather than one of the user's,
    #: their team's or organization's.
    published: bool | None = None


class FindResult(BaseModel):
    projects: list[Found]
    datasets: list[Found]
    workflows: list[Found]
    layouts: list[Found]
    #: Saved templates whose name matches; open them in the template gallery.
    templates: list[FoundTemplate]


def _clip(text: Any) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    return text[:_DESCRIPTION_CHARS] + "…" if len(text) > _DESCRIPTION_CHARS else text


def _space(row: dict[str, Any]) -> str | None:
    kind, name = row.get("space_kind"), row.get("space_name")
    if kind == "personal":
        return "personal"
    return f"{kind} {name}" if kind and name else kind


def _owner(row: dict[str, Any], user_id: str) -> str | None:
    """Colleagues' names stay with GOAT: an owner's name goes to the model only
    when the search matched it (the user typed it), and the user's own items say
    "you". The cards show every owner, loaded by the browser."""
    creator = row.get("created_by") or {}
    if creator.get("id") == user_id:
        return "you"
    if "owner" in (row.get("matched_on") or []):
        return creator.get("name") or None
    return None


def _found(row: dict[str, Any], user_id: str) -> Found:
    """A hit of core's content search. Its ``type`` is the resource kind, so a
    layer reports the dataset's own ``layer_type`` instead."""
    matched = [m for m in row.get("matched_on") or [] if m != "name"]
    return Found(
        id=str(row.get("id")),
        name=str(row.get("name") or ""),
        description=_clip(row.get("description")),
        type="bundle" if row.get("type") == "bundle" else row.get("layer_type"),
        bundle_type=row.get("bundle_type"),
        geometry_type=row.get("geometry_type"),
        project_id=row.get("project_id"),
        project_name=row.get("project_name"),
        owner=_owner(row, user_id),
        space=_space(row),
        folder=" / ".join(row.get("folder_path") or []) or None,
        matched_on=matched or None,
        updated_at=row.get("updated_at"),
    )


def _template(row: dict[str, Any], user_id: str) -> FoundTemplate:
    return FoundTemplate(
        id=str(row.get("id")),
        name=str(row.get("name") or ""),
        description=_clip(row.get("description")),
        kind=str(row.get("payload_kind") or "project"),
        owner=_owner(row, user_id),
        published=True if row.get("catalog_status") == "published" else None,
    )


#: The content search's types for each kind the tool offers.
_SEARCH_TYPES: dict[str, str] = {
    "project": "project",
    "dataset": "layer,bundle",
    "workflow": "workflow",
    "layout": "layout",
}


async def _find(env: ToolEnv, args: FindInput) -> FindResult:
    kinds = list(_SEARCH_TYPES) if args.kind == "any" else [args.kind]

    async def search(kind: str) -> list[Found]:
        if kind not in kinds:
            return []
        # Core searches everything the user can open: own, shared with them,
        # their teams' and organization's spaces, and shared folders.
        page = await env.call(
            "core",
            "GET",
            "/api/v2/content/search",
            params={
                "search": args.query,
                "types": _SEARCH_TYPES[kind],
                "size": args.limit,
                "page": 1,
            },
        )
        rows: list[dict[str, Any]] = page.get("items", [])
        if args.kind == "any" and kind in ("workflow", "layout"):
            # Next to the projects, a workflow or layout found only by its
            # project's name repeats that project.
            rows = [row for row in rows if row.get("matched_on") != ["project"]]
        return [_found(row, str(env.user_id)) for row in rows]

    async def templates() -> list[FoundTemplate]:
        if args.kind == "dataset":
            return []
        params: dict[str, Any] = {
            "search": args.query,
            "source": "all",
            "size": args.limit,
            "page": 1,
        }
        if args.kind != "any":
            params["kind"] = args.kind
        page = await env.call("core", "GET", "/api/v2/template", params=params)
        return [_template(row, str(env.user_id)) for row in page.get("items", [])]

    projects, datasets, workflows, layouts, found_templates = await asyncio.gather(
        search("project"),
        search("dataset"),
        search("workflow"),
        search("layout"),
        templates(),
    )
    return FindResult(
        projects=projects,
        datasets=datasets,
        workflows=workflows,
        layouts=layouts,
        templates=found_templates,
    )


FIND: ToolSpec[FindInput, FindResult] = ToolSpec(
    name="core.find",
    description=(
        "Find the user's projects, datasets (layers, bundles) and the workflows "
        "and print layouts inside projects, in everything they can open: own, "
        "shared, team and organization spaces, shared folders. Matches the name, "
        "a folder, the owner's name, and for workflows and layouts their project's "
        "name; each hit says where it is, who owns it and why it matched. Also "
        "lists matching templates. Try German terms too (Schulung for training). "
        "Not the public catalog: that is catalog_search. On the Map and Workflows "
        "pages, a dataset's id (not a bundle's) is what project_add_dataset takes."
    ),
    input_model=FindInput,
    output_model=FindResult,
    run=_find,
    surfaces=ALL_SURFACES,
    returns_data=False,
)


# -- core.find_layers ----------------------------------------------------------


class FindLayersInput(BaseModel):
    # Stripped, so a query of spaces fails here (the model can fix it) rather
    # than in core.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query: str = Field(
        min_length=2,
        max_length=100,
        description="Part of the layer's name to look for, e.g. 'rad' or 'Bäume'.",
    )
    limit: int = Field(
        default=20, ge=1, le=50, description="Maximum number of layers to return."
    )


class FoundLayer(BaseModel):
    project_id: str
    project_name: str
    layer_project_id: int
    name: str
    #: The underlying dataset's name, when the layer is named differently in
    #: the project. Never for a locked layer: core withholds it.
    dataset_name: str | None = None
    type: str | None = None
    geometry_type: str | None = None
    project_updated_at: str | None = None
    #: The user cannot read this layer's data (it is in the project, but its
    #: dataset is not shared with them); set only then.
    locked: bool | None = None


class FindLayersResult(BaseModel):
    layers: list[FoundLayer]
    #: Matching layers in all, beyond ``limit`` too.
    total: int


def _found_layer(row: dict[str, Any]) -> FoundLayer:
    name = str(row.get("layer_name") or "")
    dataset = row.get("dataset_name")
    return FoundLayer(
        project_id=str(row.get("project_id")),
        project_name=str(row.get("project_name") or ""),
        layer_project_id=int(row["layer_project_id"]),
        name=name,
        dataset_name=dataset if dataset and dataset != name else None,
        type=row.get("layer_type"),
        geometry_type=row.get("geometry_type"),
        project_updated_at=row.get("project_updated_at"),
        locked=True if row.get("locked") else None,
    )


async def _find_layers(env: ToolEnv, args: FindLayersInput) -> FindLayersResult:
    # Core searches every project the user can read, own, shared directly or
    # through a team, the organization or a folder, and checks each one.
    page = await env.call(
        "core",
        "GET",
        "/api/v2/project/layers/search",
        params={"search": args.query, "size": args.limit, "page": 1},
    )
    items: list[dict[str, Any]] = page.get("items", [])
    return FindLayersResult(
        layers=[_found_layer(row) for row in items],
        total=int(page.get("total") or len(items)),
    )


FIND_LAYERS: ToolSpec[FindLayersInput, FindLayersResult] = ToolSpec(
    name="core.find_layers",
    description=(
        "Find layers by name inside every project the user can open (own, shared, "
        "team, organization), with each one's project: for which projects use or "
        "contain some data; core_find finds projects and datasets themselves. Names "
        "and ids only; a locked layer's data cannot be read. For the open project's layers, fields or values, use "
        "project_get_layers and the other project tools."
    ),
    input_model=FindLayersInput,
    output_model=FindLayersResult,
    run=_find_layers,
    surfaces=ALL_SURFACES,
    returns_data=False,
)

# -- core.show_items -----------------------------------------------------------

_MAX_ITEMS = 10
_MAX_ITEM_GROUPS = 4
ItemKind = Literal["project", "dataset", "layer", "bundle", "workflow", "layout"]


class ItemRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ItemKind = Field(
        description=(
            "project (an id from core_find's projects), dataset (an id from "
            "core_find's datasets), bundle (a dataset of type bundle from "
            "core_find: several layers kept together, e.g. a GTFS feed), layer "
            "(a layer_project_id from core_find_layers or project_get_layers, "
            "with its project_id), workflow (an id from project_get_workflows, "
            "with its project_id) or layout (an id from project_get_layouts, with "
            "its project_id)."
        )
    )
    id: str = Field(min_length=1, max_length=64)
    project_id: UUID | None = Field(
        default=None,
        description="The project of a layer, workflow or layout; only for those kinds.",
    )
    note: str | None = Field(
        default=None,
        max_length=160,
        description=(
            "One short line, in the user's language, on why it matters for the "
            "question. Not its name again."
        ),
    )

    @model_validator(mode="after")
    def _id_fits_the_kind(self) -> "ItemRef":
        if self.kind in ("workflow", "layout"):
            if self.project_id is None:
                raise ValueError(f"a {self.kind} needs its project_id")
            try:
                UUID(self.id)
            except ValueError as exc:
                raise ValueError(f"a {self.kind} id is a UUID") from exc
        elif self.kind == "layer":
            if self.project_id is None or not self.id.isdigit():
                raise ValueError(
                    "a layer needs its layer_project_id as id and its project_id"
                )
        else:
            try:
                UUID(self.id)
            except ValueError as exc:
                raise ValueError(f"a {self.kind} id is a UUID") from exc
            if self.project_id is not None:
                raise ValueError("project_id is only for kind layer")
        return self

    @property
    def key(self) -> str:
        return (
            f"{self.kind}:{self.project_id}:{self.id}"
            if self.project_id
            else f"{self.kind}:{self.id}"
        )


class ItemGroupInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    title: str | None = Field(
        default=None,
        max_length=60,
        description="A short heading for the group, in the user's language.",
    )
    # ``records``, as catalog_show_records names its list, is taken too.
    items: list[ItemRef] = Field(
        min_length=1,
        max_length=_MAX_ITEMS,
        validation_alias=AliasChoices("items", "records"),
    )


class ShowItemsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    groups: list[ItemGroupInput] = Field(
        min_length=1,
        max_length=_MAX_ITEM_GROUPS,
        description=(
            f"What your answer points to, in up to {_MAX_ITEM_GROUPS} groups, in "
            f"the order you present them; the first {_MAX_ITEMS} are shown. One "
            "group without a title is fine."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _one_group(cls, data: Any) -> Any:
        """A bare list (``items`` or ``records``) without groups is one group
        without a title."""
        if not isinstance(data, dict) or "groups" in data:
            return data
        key = next((key for key in ("items", "records") if key in data), None)
        if key is None:
            return data
        rest = {name: value for name, value in data.items() if name != key}
        return {**rest, "groups": [{"items": data[key]}]}

    @field_validator("groups")
    @classmethod
    def _each_once(cls, groups: list[ItemGroupInput]) -> list[ItemGroupInput]:
        seen: set[str] = set()
        kept: list[ItemGroupInput] = []
        for group in groups:
            items = []
            for item in group.items:
                if item.key not in seen:
                    seen.add(item.key)
                    items.append(item)
            if items:
                kept.append(group.model_copy(update={"items": items}))
        return kept


class ShownItem(BaseModel):
    kind: ItemKind
    id: str
    #: The project of a layer, workflow or layout.
    project_id: str | None = None
    #: The dataset behind a layer (a dataset's own id for kind dataset): the
    #: card previews it and adds it to another project.
    dataset_id: str | None = None
    name: str
    #: The project a layer, workflow or layout is in.
    project_name: str | None = None
    #: A dataset's or layer's type and geometry, e.g. "feature · polygon".
    detail: str | None = None
    #: A layer whose data the user cannot read (its dataset is not shared with them).
    locked: bool | None = None
    note: str | None = None


class ShownItemGroup(BaseModel):
    title: str | None = None
    items: list[ShownItem]


class ShowItemsResult(BaseModel):
    groups: list[ShownItemGroup]
    #: Named but not found, or not readable for the user: never shown.
    not_found: list[str]
    #: Named beyond the first ``_MAX_ITEMS``: not shown either.
    left_out: list[str]


async def _optional(env: ToolEnv, path: str) -> Any:
    """A core document, or None when it does not exist or the user may not read
    it (core answers 401 for no access too). An expired sign-in fails the call:
    nothing was looked at."""
    try:
        return await env.call("core", "GET", path)
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403, 404, 422):
            return None
        raise


def _text_or_none(value: Any) -> str | None:
    return str(value) if value else None


def _detail(row: dict[str, Any]) -> str | None:
    parts = [row.get("type"), row.get("feature_layer_geometry_type")]
    return " · ".join(str(part) for part in parts if part) or None


async def _show_items(env: ToolEnv, args: ShowItemsInput) -> ShowItemsResult:
    refs = [item for group in args.groups for item in group.items]
    shown = {item.key for item in refs[:_MAX_ITEMS]}
    left_out = [item.key for item in refs[_MAX_ITEMS:]]
    # One request per project, however many of its layers are named.
    fetched: dict[str, asyncio.Task[Any]] = {}

    def fetch(path: str) -> "asyncio.Task[Any]":
        if path not in fetched:
            fetched[path] = asyncio.ensure_future(_optional(env, path))
        return fetched[path]

    async def resolve(ref: ItemRef) -> ShownItem | None:
        note = (ref.note or "").strip() or None
        if ref.kind == "project":
            project = await fetch(f"/api/v2/project/{ref.id}")
            if not project:
                return None
            return ShownItem(
                kind="project",
                id=ref.id,
                name=str(project.get("name") or ""),
                note=note,
            )
        if ref.kind == "bundle":
            bundle = await fetch(f"/api/v2/bundle/{ref.id}")
            if not bundle:
                return None
            return ShownItem(
                kind="bundle",
                id=ref.id,
                name=str(bundle.get("name") or ""),
                detail=_text_or_none(bundle.get("bundle_type")),
                note=note,
            )
        if ref.kind in ("workflow", "layout"):
            path = "workflow" if ref.kind == "workflow" else "report-layout"
            project, rows = await asyncio.gather(
                fetch(f"/api/v2/project/{ref.project_id}"),
                fetch(f"/api/v2/project/{ref.project_id}/{path}"),
            )
            row = next(
                (row for row in rows or [] if str(row.get("id")) == ref.id), None
            )
            if not project or row is None:
                return None
            return ShownItem(
                kind=ref.kind,
                id=ref.id,
                project_id=str(ref.project_id),
                name=str(row.get("name") or ""),
                project_name=project.get("name"),
                note=note,
            )
        if ref.kind == "dataset":
            layer = await fetch(f"/api/v2/layer/{ref.id}")
            if not layer:
                return None
            return ShownItem(
                kind="dataset",
                id=ref.id,
                dataset_id=ref.id,
                name=str(layer.get("name") or ""),
                detail=_detail(layer),
                note=note,
            )
        project, rows = await asyncio.gather(
            fetch(f"/api/v2/project/{ref.project_id}"),
            fetch(f"/api/v2/project/{ref.project_id}/layer"),
        )
        row = next((row for row in rows or [] if str(row.get("id")) == ref.id), None)
        if not project or row is None:
            return None
        return ShownItem(
            kind="layer",
            id=ref.id,
            project_id=str(ref.project_id),
            # A locked layer's dataset is not the user's to read or add.
            dataset_id=None
            if row.get("locked")
            else _text_or_none(row.get("layer_id")),
            name=str(row.get("name") or ""),
            project_name=project.get("name"),
            detail=_detail(row),
            locked=True if row.get("locked") else None,
            note=note,
        )

    kept = [ref for ref in refs if ref.key in shown]
    found = dict(
        zip(
            (ref.key for ref in kept),
            await asyncio.gather(*(resolve(ref) for ref in kept)),
            strict=True,
        )
    )
    groups: list[ShownItemGroup] = []
    not_found: list[str] = []
    for group in args.groups:
        items = []
        for ref in group.items:
            if ref.key not in shown:
                continue
            item = found[ref.key]
            if item is None:
                not_found.append(ref.key)
                continue
            # A note that only repeats the name says nothing the card does not.
            if item.note and item.note.casefold().rstrip(".") == item.name.casefold():
                item.note = None
            items.append(item)
        if items:
            title = (group.title or "").strip() or None
            groups.append(ShownItemGroup(title=title, items=items))
    return ShowItemsResult(groups=groups, not_found=not_found, left_out=left_out)


SHOW_ITEMS: ToolSpec[ShowItemsInput, ShowItemsResult] = ToolSpec(
    name="core.show_items",
    description=(
        "Show the user's own projects, datasets, bundles, project layers, workflows "
        "and layouts your answer points to as cards they can open, under short "
        "headings, each with a one-line note on why it matters. Call it once, right "
        "before the final answer, with only what you point to, named by the ids "
        f"core_find, core_find_layers or project_get_layers returned. At most {_MAX_ITEMS} "
        "are shown: more come back as left_out, missing or unreadable ones as "
        "not_found; count only what is shown. Catalog datasets: catalog_show_records."
    ),
    input_model=ShowItemsInput,
    output_model=ShowItemsResult,
    run=_show_items,
    surfaces=ALL_SURFACES,
    returns_data=False,
)

CORE_TOOLS: tuple[ToolSpec[Any, Any], ...] = (
    WHOAMI,
    PAGE_CONTEXT,
    FIND,
    FIND_LAYERS,
    SHOW_ITEMS,
)
