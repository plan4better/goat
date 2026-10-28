"""May the caller use everything a process request names?

Tools and analytics run with service credentials, so they never check the
caller themselves; this module does it once, before anything is dispatched.
It collects every layer, project-layer link, project, folder and bundle a
request refers to and asks Postgres which of them the caller may not use
(`access_sql.access_check_sql`, the rule geoapi applies to reads: a layer in
a published project, or `customer.can`).

Which inputs name a layer comes from each tool's parameter schema: fields the
UI renders as a layer selector (`widget="layer-selector"`), plus the few
listed in EXTRA_LAYER_FIELDS. A layer reference must be a layer id (checked)
or a workflow temp-layer id, which only ever resolves inside the caller's own
temp directory; anything else, a file path in particular, is refused, since
a tool would otherwise read it as given.
"""

import asyncio
import json
import logging
import re
from collections.abc import Sequence
from functools import lru_cache
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import HTTPException, status
from goatlib.config.postgres import asyncpg_connect_args
from goatlib.tools.registry import TOOL_REGISTRY
from goatlib.tools.schemas import DEFAULT_NETWORK_BUNDLE

from processes.config import settings
from processes.services.access_sql import access_check_sql

logger = logging.getLogger(__name__)

# Matched with fullmatch: `$` would also accept a trailing newline.
UUID_RE = re.compile(r"[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}", re.IGNORECASE)
# "<workflow id>:<node id>:<layer id>" from workflow tool chaining, checked
# part by part (a single pattern over the whole id backtracks badly on long
# input).
TEMP_LAYER_PART_RE = re.compile(r"[A-Za-z0-9_-]+")
MAX_REFERENCE_LENGTH = 200


def is_temp_layer_id(text: str) -> bool:
    parts = text.split(":")
    return (
        len(text) <= MAX_REFERENCE_LENGTH
        and len(parts) >= 2
        and all(TEMP_LAYER_PART_RE.fullmatch(part) for part in parts)
    )


# Layer fields a tool's schema does not mark as a layer selector.
EXTRA_LAYER_FIELDS: dict[str, tuple[str, ...]] = {
    "catchment_area_v2": ("starting_points.layer_id",),
    "layer_create_filtered": ("source_layer_id", "input_layer_id"),
    "layer_copy": ("source_layer_id",),
    "bundle_create_filtered": ("input_layer_id",),
    "merge": ("input_layer_id",),
    "custom_sql": ("input_layer_id",),
    "catalog_materialize": ("layer_id",),
    "layer_delete_multi": ("layer_ids[]",),
}
# Any input key shaped like a layer reference, at any depth, is checked too,
# whatever the schema says: the workflow runner folds numbered handles
# (`opportunity_layer_4_id`, `input_layer_7_id`, `input_path_3`) and camelCase
# keys (`additional_layers[].layerId`) into real tool inputs.
LAYER_KEY_RE = re.compile(
    r"^(?:\w+_)?layer(?:_\d+)?_id$|^(?:\w+_)?layer_ids$|^layerId$|^input_path(?:_\d+)?$"
)
# Layer-shaped fields that do not name a layer to check. -> why.
NOT_LAYER_REFERENCES: dict[str, str] = {
    "layer_owner_id": "names whose storage holds the layer; the layer id itself is checked",
}
# Tools that change or remove the layers they name: write, not read.
LAYER_WRITE_TOOLS = frozenset({"layer_delete", "layer_delete_multi", "layer_update"})
# Project-layer links (layer_project ids), checked as reads of their layer.
# `layer_copy` names the entries of its (write-checked) project it points at
# the copy; the job itself refuses an entry of another project.
# `layer_create_filtered` reads the active style of the entry it names; the job
# itself refuses an entry of a project the caller may not read.
LAYER_PROJECT_FIELDS: tuple[str, ...] = (
    "opportunities[].layer_project_id",
    "layer_project_ids[]",
    "source_layer_project_id",
)
BUNDLE_READ_FIELDS: tuple[str, ...] = (
    "street_network_bundle_id",
    "pt_network_bundle_id",
    "source_bundle_id",
)
BUNDLE_WRITE_FIELDS: tuple[str, ...] = ("bundle_id", "bundle_ids[]")
# File locations a tool reads or writes. The runner fills these from layer
# ids; a value a caller sends would be read as given, so it is refused,
# except where a caller legitimately names a location:
PATH_FIELD_RE = re.compile(r"_(path|paths|url|uri|dir|file)$")
CALLER_LOCATION_FIELDS = frozenset({"wfs_url"})  # importing a public WFS
# Uploads live under users/<uploader id>/ (core's dataset upload); an import
# may only name the caller's own.
UPLOAD_KEY_FIELDS: tuple[str, ...] = ("s3_key",)

# Where a tool writes its result. Read targets for the tools that only read
# the project they name.
FOLDER_WRITE_FIELDS: tuple[str, ...] = ("folder_id", "target_folder_id")
PROJECT_READ_TOOLS = frozenset({"project_export", "print_report"})


def _layer_selector_paths(schema: dict[str, Any]) -> set[str]:
    defs = schema.get("$defs", {})
    found: set[str] = set()

    def walk(node: Any, path: str) -> None:
        if not isinstance(node, dict):
            return
        extra = node.get("x-ui")
        if node.get("widget") == "layer-selector" or (
            isinstance(extra, dict) and extra.get("widget") == "layer-selector"
        ):
            found.add(path.lstrip("."))
        for key, value in node.items():
            if key == "properties":
                for name, child in value.items():
                    walk(child, f"{path}.{name}")
            elif key == "items":
                walk(value, f"{path}[]")
            elif key in ("anyOf", "allOf", "oneOf"):
                for child in value:
                    walk(child, path)
            elif key == "$ref":
                walk(defs.get(value.split("/")[-1], {}), path)

    walk(schema, "")
    return found


REGISTERED_TOOLS = frozenset(t.name for t in TOOL_REGISTRY)


@lru_cache(maxsize=len(REGISTERED_TOOLS) + 1)
def layer_fields(process_id: str) -> tuple[str, ...]:
    """Every input path of a tool that names a layer."""
    tool = next((t for t in TOOL_REGISTRY if t.name == process_id), None)
    if tool is None:
        return ()
    schema = tool.get_params_class().model_json_schema()
    paths = _layer_selector_paths(schema) | set(EXTRA_LAYER_FIELDS.get(process_id, ()))
    return tuple(sorted(paths))


def _values(data: Any, path: str) -> list[Any]:
    """Values at a dotted path; `name[]` steps into every item of a list."""
    current: list[Any] = [data]
    for step in path.split("."):
        is_list = step.endswith("[]")
        key = step[:-2] if is_list else step
        following: list[Any] = []
        for item in current:
            if not isinstance(item, dict) or item.get(key) is None:
                continue
            value = item[key]
            if is_list:
                following.extend(value if isinstance(value, list) else [value])
            else:
                following.append(value)
        current = following
    return [v for v in current if v not in (None, "")]


class References:
    """What a request names, as {"kind", "id", "action"} entries."""

    def __init__(self) -> None:
        self.entries: list[dict[str, str]] = []

    def add(self, kind: str, value: Any, action: str = "read") -> None:
        self.entries.append({"kind": kind, "id": str(value), "action": action})

    def add_layer(self, value: Any, action: str = "read") -> None:
        text = str(value)
        if UUID_RE.fullmatch(text):
            self.add("layer", text, action)
        elif not is_temp_layer_id(text):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="A layer input must be a layer id",
            )


def _refuse(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def _check_locations(
    process_id: str, inputs: dict[str, Any], user_id: UUID | None
) -> None:
    layer_names = {p.split(".")[0].removesuffix("[]") for p in layer_fields(process_id)}
    for name, value in inputs.items():
        if value in (None, "", []) or name in layer_names:
            continue
        if PATH_FIELD_RE.search(name) and name not in CALLER_LOCATION_FIELDS:
            raise _refuse(f"{name} is set by the server, not the caller")
    for name in UPLOAD_KEY_FIELDS:
        key = inputs.get(name)
        if key in (None, ""):
            continue
        if not _is_own_upload(str(key), user_id):
            raise _refuse(f"{name} must name one of the caller's own uploads")


def _is_own_upload(key: str, user_id: UUID | None) -> bool:
    """`<bucket path>/users/<caller>/imports/uploads/<file>`, the one shape
    core hands out for uploads, with nothing after the file name."""
    parts = key.split("/")
    if user_id is None or ".." in parts or parts.count("users") != 1:
        return False
    at = parts.index("users")
    return parts[at + 1 : at + 4] == [str(user_id), "imports", "uploads"] and (
        len(parts) == at + 5 and bool(parts[at + 4])
    )


def _layer_shaped_values(data: Any) -> list[Any]:
    """Values of every layer-shaped key, at any depth."""
    found: list[Any] = []
    if isinstance(data, dict):
        for key, value in data.items():
            if (
                isinstance(key, str)
                and LAYER_KEY_RE.match(key)
                and not key.startswith(("output", "result"))
                and key not in NOT_LAYER_REFERENCES
                and value not in (None, "", [])
            ):
                values = value if isinstance(value, list) else [value]
                # A layer id, or an object or list holding one further down.
                found.extend(
                    v
                    for v in values
                    if v is not None and not isinstance(v, (dict, list))
                )
                found.extend(_layer_shaped_values(values))
            elif isinstance(value, (dict, list)):
                found.extend(_layer_shaped_values(value))
    elif isinstance(data, list):
        for item in data:
            found.extend(_layer_shaped_values(item))
    return found


def empty_copy_of_template(
    process_id: str, inputs: dict[str, Any]
) -> tuple[str, str] | None:
    """(template id, dataset id) when a `layer_copy` job copies only a
    template dataset's structure ("copy, empty"), else None.

    Such a copy needs no read of the dataset's rows: whoever may read the
    template may have its empty structure, so the author's dataset stays
    private. `ensure_empty_copy_of_template` confirms the template really
    has that dataset as a "copy, empty" input.
    """
    if process_id != "layer_copy" or inputs.get("copy_content") is not False:
        return None
    template_id, source = inputs.get("template_id"), inputs.get("source_layer_id")
    if not isinstance(template_id, str) or not isinstance(source, str):
        return None
    if not (UUID_RE.fullmatch(template_id) and UUID_RE.fullmatch(source)):
        return None
    return template_id, source


def tool_references(
    process_id: str, inputs: dict[str, Any], user_id: UUID | None = None
) -> References:
    _check_locations(process_id, inputs, user_id)
    refs = References()
    layer_action = "write" if process_id in LAYER_WRITE_TOOLS else "read"
    empty_copy = empty_copy_of_template(process_id, inputs)
    # An empty copy reads the template instead of its dataset (see above).
    skipped = {empty_copy[1]} if empty_copy else set()
    if empty_copy:
        refs.add("template", empty_copy[0], "read")
    for path in layer_fields(process_id):
        for value in _values(inputs, path):
            if value not in skipped:
                refs.add_layer(value, layer_action)
    for value in _layer_shaped_values(inputs):
        if value not in skipped:
            refs.add_layer(value, layer_action)
    # The entries an empty copy repoints still show the dataset, so reading
    # them would read it; they need no read: the project is checked for
    # write, and the job only repoints entries of that project that show
    # exactly this dataset, onto the caller's own copy.
    if not empty_copy:
        for path in LAYER_PROJECT_FIELDS:
            for value in _values(inputs, path):
                refs.add("layer_project", value)
    for path in BUNDLE_READ_FIELDS:
        for value in _values(inputs, path):
            # The network selectors' answer for the default network, which a
            # workflow keeps in its config: it names no bundle.
            if value != DEFAULT_NETWORK_BUNDLE:
                refs.add("bundle", value)
    for path in BUNDLE_WRITE_FIELDS:
        for value in _values(inputs, path):
            refs.add("bundle", value, "write")
    for path in FOLDER_WRITE_FIELDS:
        for value in _values(inputs, path):
            refs.add("folder", value, "write")
    project_action = "read" if process_id in PROJECT_READ_TOOLS else "write"
    for value in _values(inputs, "project_id"):
        refs.add("project", value, project_action)
    return refs


def analytics_references(process_id: str, inputs: dict[str, Any]) -> References:
    refs = References()
    for value in _values(inputs, "collection"):
        refs.add_layer(value)
    layers = inputs.get("layers")
    if isinstance(layers, dict):  # preview-sql / validate-sql: alias -> layer id
        for value in layers.values():
            refs.add_layer(value)
    elif isinstance(layers, list):  # layer-search: [{"layer_id": ...}, ...]
        for spec in layers:
            if isinstance(spec, dict) and spec.get("layer_id"):
                refs.add_layer(spec["layer_id"])
    return refs


def workflow_references(
    nodes: list[dict[str, Any]],
    project_id: Any,
    folder_id: Any,
    edges: Sequence[dict[str, Any]] = (),
) -> References:
    """Dataset nodes' layers, tool nodes' configured layer inputs, and where
    the workflow writes.

    A tool input an edge feeds is not checked: the runner replaces it with
    the upstream node's layer (`workflow_runner`), so whatever id its config
    still holds, often one left from before the input was connected, is
    never read. The upstream dataset's layer is checked instead.
    """
    connected = {
        (edge.get("target"), edge.get("targetHandle", "input_layer_id"))
        for edge in edges
    }
    refs = References()
    for node in nodes:
        data = node.get("data") or {}
        # A node the editor never makes: refused like any malformed input,
        # rather than failing the check itself.
        if not isinstance(data, dict) or not isinstance(data.get("config") or {}, dict):
            raise _refuse("A workflow node is malformed")
        if data.get("type") == "dataset" and data.get("layerId"):
            refs.add_layer(data["layerId"])
        elif data.get("type") == "tool":
            tool = str(data.get("processId") or "")
            if tool not in REGISTERED_TOOLS:
                raise _refuse(f"Unknown tool in workflow: {tool!r}")
            config = {
                key: value
                for key, value in (data.get("config") or {}).items()
                if (node.get("id"), key) not in connected
            }
            for entry in tool_references(tool, config).entries:
                if entry["kind"] not in ("project", "folder"):
                    refs.entries.append(entry)
    if project_id:
        refs.add("project", project_id, "write")
    if folder_id:
        refs.add("folder", folder_id, "write")
    return refs


def refused_workflow_nodes(
    nodes: list[dict[str, Any]], denied: list[dict[str, str]]
) -> list[str]:
    """The workflow's nodes that name a refused dataset, layer or bundle:
    a dataset node by its layer, a tool node by any setting holding the id."""
    refused_ids = {
        str(entry.get("raw_id", entry.get("id")))
        for entry in denied
        if entry.get("kind") in ("layer", "bundle")
    }
    names: list[str] = []
    for node in nodes:
        data = node.get("data") or {}
        if data.get("type") == "dataset":
            hit = str(data.get("layerId")) in refused_ids
        elif data.get("type") == "tool":
            hit = any(
                str(value) in refused_ids
                for value in _layer_shaped_values(data.get("config") or {})
                + [
                    value
                    for path in BUNDLE_READ_FIELDS
                    for value in _values(data.get("config") or {}, path)
                ]
            )
        else:
            hit = False
        if hit and node.get("id"):
            names.append(str(node["id"]))
    return names


async def ensure_workflow_allowed(
    user_id: UUID | None, refs: References, nodes: list[dict[str, Any]]
) -> None:
    """`ensure_allowed` for a workflow run, whose refusal says which of the
    caller's own nodes hold what they may not use, and whether the project
    or folder it writes to is refused. Node ids are the caller's own, so the
    answer reveals nothing about the data, not even whether it exists."""
    if not refs.entries:
        return
    try:
        denied = await denied_references(user_id, refs.entries)
    except Exception:
        logger.exception("access check failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Access could not be checked",
        )
    if denied:
        logger.info("access denied user=%s refs=%s", user_id, denied)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "message": "Resource not found",
                "refused_nodes": refused_workflow_nodes(nodes, denied),
                "destination_refused": any(
                    entry.get("kind") in ("project", "folder") for entry in denied
                ),
            },
        )


_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()


async def _get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    async with _pool_lock:
        if _pool is not None:
            return _pool
        # Same connection as geoapi's: separate parameters, so a password
        # character that is special in a URL cannot break it.
        _pool = await asyncpg.create_pool(
            host=settings.POSTGRES_SERVER,
            port=settings.POSTGRES_PORT,
            user=settings.POSTGRES_USER,
            password=settings.POSTGRES_PASSWORD,
            database=settings.POSTGRES_DB,
            min_size=1,
            max_size=4,
            # Close a connection once it has sat idle for a minute rather
            # than five. asyncpg closes idle ones down to none, min_size
            # included, so the first request after a quiet minute reconnects.
            max_inactive_connection_lifetime=60,
            command_timeout=10,
            **asyncpg_connect_args(
                "goat-processes", settings.POSTGRES_TRANSACTION_POOLER
            ),
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def denied_references(
    user_id: UUID | None, entries: list[dict[str, str]]
) -> list[dict[str, str]]:
    """The entries the caller may not use, from one database round trip."""
    pool = await _get_pool()
    rows = await pool.fetch(
        access_check_sql(settings.CUSTOMER_SCHEMA),
        str(user_id) if user_id else None,
        json.dumps(entries),
    )
    return [dict(row) for row in rows]


async def raster_file_url(layer_id: str) -> str | None:
    """The stored address of a raster file layer (a COG), else None. The style
    check reads raster files from here only, never from a request."""
    try:
        uuid = str(UUID(layer_id))
    except ValueError:
        return None
    pool = await _get_pool()
    return await pool.fetchval(
        f"SELECT url FROM {settings.CUSTOMER_SCHEMA}.layer "
        "WHERE id = $1::uuid AND type = 'raster' AND data_type = 'cog'",
        uuid,
    )


async def ensure_empty_copy_of_template(template_id: str, layer_id: str) -> None:
    """404 unless the live template `template_id` has `layer_id` as a "copy"
    input without its rows: the only case in which `tool_references` lets a
    `layer_copy` job read the template instead of the dataset."""
    try:
        pool = await _get_pool()
        found = await pool.fetchval(
            f"""
            SELECT EXISTS (
                SELECT 1
                  FROM {settings.CUSTOMER_SCHEMA}.template t,
                       jsonb_array_elements(t.inputs) AS i
                 WHERE t.id = $1::uuid
                   AND t.deleted_at IS NULL
                   AND i->>'mode' = 'copy'
                   AND i->>'layer_id' = $2::uuid::text
                   AND (i->>'copy_content')::boolean IS FALSE
            )
            """,
            template_id,
            layer_id,
        )
    except Exception:
        logger.exception("empty-copy check failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Access could not be checked",
        )
    if not found:
        logger.info("empty copy refused template=%s layer=%s", template_id, layer_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found"
        )


async def ensure_allowed(user_id: UUID | None, refs: References) -> None:
    """404 unless the caller may use everything referenced.

    404, the answer for a missing resource, so a probe cannot tell "not
    yours" from "does not exist". A failed check is a 503, never a pass.
    """
    if not refs.entries:
        return
    try:
        denied = await denied_references(user_id, refs.entries)
    except Exception:
        logger.exception("access check failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Access could not be checked",
        )
    if denied:
        logger.info("access denied user=%s refs=%s", user_id, denied)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found"
        )
