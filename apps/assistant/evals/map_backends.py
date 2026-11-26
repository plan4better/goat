"""Stand-ins for core's style and map routes on the map project, so that an
eval task is graded on what core would store.

``MapState`` is one task's copy of what core holds of the project: the named
styles with their kept revisions, the layers' rows and map state, the groups,
the basemap, the scene and the dashboard. ``map_core`` answers core's routes
from it, under ``/api/v2``, with core's reply shapes and error bodies.

A style save runs core's own steps (``core.services.style``: the size and
version checks, ``_candidate``, ``_kept``, ``_to_store``) on a ``StoredStyle``
built from the state. Where core asks processes to check a style, the
stand-in does what processes' ``style-check`` does, over a DuckDB table per
layer built from the fixture's features: goatlib's ``describe``,
``compute_into`` and ``validate``. Only the SQL that reads core's tables is
replaced. Raster styles are checked against the bands processes would read
from the file (``RASTER_BANDS``); nothing reads pixels.
"""

import copy
import dataclasses
import functools
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Literal, cast
from uuid import UUID

import duckdb
import httpx
from goatlib.style.compute import needed_stats
from goatlib.style.context import BandInfo, DataContext, MapContext, raster_fields
from goatlib.style.data import compute_into, describe
from goatlib.style.data_check import referenced_fields
from goatlib.style.defaults import default_style
from goatlib.style.fingerprint import layer_fingerprint
from goatlib.style.ids import assign_ids
from goatlib.style.issues import Issue
from goatlib.style.map_rows import (
    MAX_MAP_VALUE_BYTES,
    MAX_STYLES,
    GroupRow,
    LayerRow,
    build_map_document,
    json_bytes,
)
from goatlib.style.migrate import context_for
from goatlib.style.scene import extrudes
from goatlib.style.upgrade import upgrade
from goatlib.style.validate import validate, validate_map
from goatlib.style.version import SPEC_VERSION, stamp
from goatlib.tools.style import bands, style_title
from pydantic import ValidationError

from assistant.tools.testing import Recorder
from evals.backends import FOLDER_ID, FixtureLayer
from evals.map_fixture import (
    LAND_USE_QUERY,
    MAP_BASEMAP,
    MAP_BUILDER_CONFIG,
    MAP_GROUPS,
    MAP_LAYERS,
    MAP_LAYERS_BY_ID,
    MAP_PROJECT_ID,
    MAP_PROJECT_NAME,
    MAP_REPORT_LAYOUT,
    MAP_RESULT_LAYER,
    MAP_TREE,
    MAP_VIEW_PROJECT_ID,
    MAP_VIEW_STATE,
    MAP_WORKFLOW,
    RASTER_BANDS,
    map_layer,
)

__all__ = [
    "DATA_SNAPSHOT",
    "KEPT_REVISIONS",
    "MAP_LAYERS",
    "MAP_PROJECT_ID",
    "MAP_PROJECT_NAME",
    "MAP_VIEW_PROJECT_ID",
    "STYLE_CAPABILITIES",
    "MapCore",
    "MapState",
    "NamedStyle",
    "map_core",
]

#: Revisions kept per named style (core's ``KEPT_REVISIONS``).
KEPT_REVISIONS = 20
#: What processes draws of the specification's later constructs (its
#: ``STYLE_CAPABILITIES``).
STYLE_CAPABILITIES = frozenset({"h3", "raster_service", "band_formulas"})
#: The DuckLake snapshot of every vector layer: computed values carry it.
DATA_SNAPSHOT = 1
_SQL_TYPES = {
    "string": "VARCHAR",
    "integer": "BIGINT",
    "number": "DOUBLE",
    "boolean": "BOOLEAN",
}
_NOT_NULL = {"visible", "position", "legend_expanded"}
_NOT_FOUND = {"detail": {"code": "not_found"}}


@functools.cache
def _core() -> SimpleNamespace:
    """Core's own steps and request models. Imported on first use: importing
    core reads its settings from the environment, which ``python -m evals``
    loads only after it has imported this module."""
    from core.schemas import common, project, properties_refused
    from core.schemas import style as schemas
    from core.services import style
    from fastapi import HTTPException

    return SimpleNamespace(
        CQLQueryObject=common.CQLQueryObject,
        query_save_errors=common.query_save_errors,
        ILayerProjectGroupCreate=project.ILayerProjectGroupCreate,
        ILayerProjectGroupUpdate=project.ILayerProjectGroupUpdate,
        LayerTreeUpdate=project.LayerTreeUpdate,
        PROPERTIES_REFUSED=properties_refused.PROPERTIES_REFUSED,
        GroupMapState=schemas.GroupMapState,
        LayerMapState=schemas.LayerMapState,
        StyleCheckRequest=schemas.StyleCheckRequest,
        StyleCreate=schemas.StyleCreate,
        StyleSaveRequest=schemas.StyleSaveRequest,
        StyleUpdate=schemas.StyleUpdate,
        StoredStyle=style.StoredStyle,
        StyleSaveError=style.StyleSaveError,
        _candidate=style._candidate,
        _checked_form=style._checked_form,
        _kept=style._kept,
        _to_store=style._to_store,
        check_size=style.check_size,
        incoming_document=style.incoming_document,
        HTTPException=HTTPException,
    )


# ---- data and checks ------------------------------------------------------------


def _relation(layer: FixtureLayer) -> str:
    return f"layer_{layer.layer_project_id}"


def _connection() -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB with one table per vector layer of the map project,
    the one a run saves included: its features' properties (no geometry: no
    check reads it)."""
    con = duckdb.connect()
    for layer in (*MAP_LAYERS, MAP_RESULT_LAYER):
        if layer.layer_type != "feature":
            continue
        names = list(layer.fields)
        columns = ", ".join(f'"{n}" {_SQL_TYPES[t]}' for n, t in layer.fields.items())
        con.execute(f"CREATE TABLE {_relation(layer)} ({columns})")
        marks = "(" + ", ".join("?" for _ in names) + ")"
        con.execute(
            f"INSERT INTO {_relation(layer)} VALUES "
            + ", ".join(marks for _ in layer.features),
            [feature.get(name) for feature in layer.features for name in names],
        )
    return con


def _geometry(layer: FixtureLayer) -> Literal["point", "line", "polygon"] | None:
    return cast(Literal["point", "line", "polygon"], layer.geometry) or None


def _context(layer: FixtureLayer, document: dict[str, Any]) -> DataContext:
    """What core knows of a layer without reading its data
    (``StoredStyle.context``)."""
    kind = "raster" if document.get("kind") == "raster" else layer.layer_type
    return context_for(kind, layer.geometry or None, None)


def _fingerprint(layer: FixtureLayer) -> str | None:
    """The data a layer's computed values belong to (``StoredStyle.fingerprint``)."""
    value: str | None = layer_fingerprint(
        layer.layer_type,
        None,
        data_snapshot=None if layer.layer_type == "raster" else DATA_SNAPSHOT,
    )
    return value


def _raster_context(layer: FixtureLayer) -> DataContext:
    """The raster file as processes would read it: bands, ranges, data type."""
    data_type, ranges = RASTER_BANDS[layer.layer_project_id]
    return DataContext(
        kind="raster",
        fields=raster_fields(range(1, len(ranges) + 1)),
        bands=tuple(BandInfo(n, low, high) for n, (low, high) in enumerate(ranges, 1)),
        data_type=data_type,
    )


def _issues_json(issues: list[Issue]) -> list[dict[str, Any]]:
    return [i.model_dump(mode="json", exclude_none=True) for i in issues]


Connect = Callable[[], duckdb.DuckDBPyConnection]


def _style_check(
    connect: Connect,
    layer: FixtureLayer,
    document: dict[str, Any],
    *,
    compute: bool,
    stored: bool,
) -> tuple[dict[str, Any], list[Issue]]:
    """Processes' ``style-check`` on the fixture's table of the layer: the
    data described, the computed values written in (with ``compute``), then
    goatlib's ``validate``. H3 cells are not computed (the tables have no
    geometry): an H3 document is validated without its cell values."""
    notes: list[Issue] = []
    if document.get("kind") == "raster" or layer.layer_type == "raster":
        ctx = (
            _raster_context(layer)
            if layer.layer_type == "raster"
            else DataContext(kind="raster")
        )
    else:
        con = connect()
        ctx = describe(
            con,
            _relation(layer),
            geometry=_geometry(layer),
            fields_used=referenced_fields(document),
        )
        if compute and (document.get("render") or {}).get("type") != "h3":
            document, notes = compute_into(
                con,
                _relation(layer),
                document,
                geometry=_geometry(layer),
                fingerprint=_fingerprint(layer) or "unknown",
            )
    ctx = dataclasses.replace(ctx, capabilities=STYLE_CAPABILITIES)
    issues = sorted(
        [*notes, *validate(document, ctx, stored=stored)],
        key=lambda i: (i.path, i.code),
    )
    return document, issues


def _check(
    connect: Connect, layer: FixtureLayer, document: dict[str, Any]
) -> tuple[dict[str, Any], list[Issue]]:
    """Core's ``check_document``: processes' check when the style reads the
    layer's data, else goatlib's ``validate`` alone."""
    ctx = _context(layer, document)
    if not ctx.is_service and (referenced_fields(document) or needed_stats(document)):
        return _style_check(connect, layer, document, compute=True, stored=False)
    return document, validate(document, ctx)


# ---- starting styles -------------------------------------------------------------


def _shaped(layer_project_id: int, document: dict[str, Any]) -> dict[str, Any]:
    """Districts start with a fill, an outline and a label, Land use with its
    categories, so tasks have something to change."""
    if layer_project_id == 31:
        document["symbol"] = {
            "fill": {"color": "#deebf7", "opacity": 0.7},
            "outline": {"color": "#3a3541", "width": 1},
            "label": {"text": "{name}"},
        }
    if layer_project_id == 34:
        colors = {
            "residential": "#fc8d62",
            "farmland": "#e5c494",
            "forest": "#66a61e",
            "park": "#a6d854",
            "commercial": "#8da0cb",
            "industrial": "#b3b3b3",
        }
        document["classify"] = [
            {
                "field": "use",
                "method": "categories",
                "classes": [
                    {"values": [use], "fill": {"color": color}}
                    for use, color in colors.items()
                ],
                "other": {"fill": {"color": "#d9d9d9"}},
            }
        ]
    return document


@functools.cache
def _starting_documents() -> dict[int, dict[str, Any]]:
    """Every layer's first named style, as core's ``ensure_styles`` gives it:
    goatlib's default style for the layer (two shaped on purpose), checked
    and computed as a save stores it."""
    con = _connection()
    try:
        documents = {}
        for layer in MAP_LAYERS:
            kind = "raster" if layer.layer_type == "raster" else "vector"
            document = default_style(
                _context(layer, {"kind": kind}), seed=layer.layer_id
            )
            document = assign_ids(_shaped(layer.layer_project_id, document))
            document, issues = _check(lambda: con, layer, document)
            errors = [i for i in issues if i.level in ("error", "damaged")]
            if errors:
                raise ValueError(f"{layer.name}: {errors}")
            documents[layer.layer_project_id] = stamp(document)
        return documents
    finally:
        con.close()


# ---- state -----------------------------------------------------------------------


@dataclass
class NamedStyle:
    id: str
    layer_project_id: int
    name: str
    position: int
    revision: int
    document: dict[str, Any]
    #: revision -> document: the last ``KEPT_REVISIONS`` stored, which a save
    #: based on an older revision merges from.
    revisions: dict[int, dict[str, Any]]


class MapState:
    """What core holds of the map project during one task."""

    def __init__(self) -> None:
        self.styles: dict[str, NamedStyle] = {}
        #: layer_project_id -> the layer's row (name, query, group, order) and
        #: its map state (visible, position, active style, time, legend).
        self.layers: dict[int, dict[str, Any]] = {}
        #: group id -> name, parent_id, order, visible, expanded.
        self.groups: dict[int, dict[str, Any]] = copy.deepcopy(MAP_GROUPS)
        self.basemap: str | None = MAP_BASEMAP
        self.scene: dict[str, Any] | None = None
        self.builder_config: dict[str, Any] = copy.deepcopy(MAP_BUILDER_CONFIG)
        #: The layers removed from the project, in order.
        self.removed: list[int] = []
        self._styles_made = 0
        self._next_group = max(MAP_GROUPS) + 1
        self._con: duckdb.DuckDBPyConnection | None = None
        documents = _starting_documents()
        for layer in MAP_LAYERS:
            group, order, visible, position = MAP_TREE[layer.layer_project_id]
            self.layers[layer.layer_project_id] = {
                "name": layer.name,
                "query": (
                    copy.deepcopy(LAND_USE_QUERY)
                    if layer.layer_project_id == 34
                    else None
                ),
                "layer_project_group_id": group,
                "order": order,
                "visible": visible,
                "position": position,
                "active_style_id": None,
                "time_value": None,
                "legend_expanded": True,
            }
            style = self.add_style(
                layer.layer_project_id,
                "Default",
                copy.deepcopy(documents[layer.layer_project_id]),
            )
            self.layers[layer.layer_project_id]["active_style_id"] = style.id

    def connection(self) -> duckdb.DuckDBPyConnection:
        """The task's DuckDB with the layers' tables, built on first use."""
        if self._con is None:
            self._con = _connection()
        return self._con

    def snapshot(self) -> dict[str, Any]:
        """A deep copy of everything core holds: what graders compare."""
        return copy.deepcopy(
            {
                "styles": {
                    style_id: dataclasses.asdict(style)
                    for style_id, style in self.styles.items()
                },
                "layers": self.layers,
                "groups": self.groups,
                "basemap": self.basemap,
                "scene": self.scene,
                "builder_config": self.builder_config,
                "removed": self.removed,
            }
        )

    def styles_of(self, layer_project_id: int) -> list[NamedStyle]:
        """A layer's named styles by position."""
        return sorted(
            (s for s in self.styles.values() if s.layer_project_id == layer_project_id),
            key=lambda s: (s.position, s.id),
        )

    def active_style_id(self, layer_project_id: int) -> str:
        """The style the map draws for a layer: the active one, else the first
        by position."""
        active = self.layers[layer_project_id]["active_style_id"]
        return active or self.styles_of(layer_project_id)[0].id

    def add_style(
        self, layer_project_id: int, name: str, document: dict[str, Any]
    ) -> NamedStyle:
        """A new named style at revision 1, after the layer's others."""
        self._styles_made += 1
        positions = [s.position for s in self.styles_of(layer_project_id)]
        style = NamedStyle(
            id=f"5f000000-0000-4000-8000-{self._styles_made:012d}",
            layer_project_id=layer_project_id,
            name=name,
            position=max(positions) + 1 if positions else 0,
            revision=1,
            document=document,
            revisions={1: copy.deepcopy(document)},
        )
        self.styles[style.id] = style
        return style

    def add_result(self, layer: FixtureLayer, name: str) -> None:
        """A finished run's result joins the project, on top of the layer
        list: catchment areas with the look the catchment tool gives its
        result (``CatchmentAreaToolRunner.get_layer_style``), one class per
        travel time step in minutes, the nearest the darkest green, computed
        as the tool runner computes it. A second run saves into the layer
        that is there."""
        link = layer.layer_project_id
        if link in self.layers:
            return
        steps = sorted({feature["cost_step"] for feature in layer.features})
        document = bands(
            "cost_step",
            steps,
            "colorbrewer:YlGn",
            layer.geometry,
            style_title("travel_time"),
            "min",
            reverse=True,
        )
        document, _ = _check(self.connection, layer, document)
        top = [
            row["order"]
            for row in self.layers.values()
            if row["layer_project_group_id"] is None
        ]
        self.layers[link] = {
            "name": name,
            "query": None,
            "layer_project_group_id": None,
            "order": min(top, default=0) - 1,
            "visible": True,
            "position": "top",
            "active_style_id": None,
            "time_value": None,
            "legend_expanded": True,
        }
        style = self.add_style(link, "Default", stamp(document))
        self.layers[link]["active_style_id"] = style.id

    def remove_layer(self, layer_project_id: int) -> None:
        """A layer leaves the project with its styles and map state."""
        del self.layers[layer_project_id]
        for style in self.styles_of(layer_project_id):
            del self.styles[style.id]
        self.removed.append(layer_project_id)


# ---- the routes ------------------------------------------------------------------


class _RouteError(Exception):
    """A reply that ends a route early."""

    def __init__(self, status: int, body: Any = None) -> None:
        super().__init__(status)
        self.response = httpx.Response(status, json=body)


def _json(request: httpx.Request) -> Any:
    return json.loads(request.content) if request.content else None


def _parsed(model: Any, request: httpx.Request) -> Any:
    """The body as core's request model reads it; FastAPI's 422 otherwise."""
    try:
        return model.model_validate(_json(request))
    except ValidationError as error:
        raise _RouteError(
            422,
            {
                "detail": [
                    {"type": e["type"], "loc": ["body", *e["loc"]], "msg": e["msg"]}
                    for e in error.errors()
                ]
            },
        ) from None


def _read(
    style: NamedStyle,
    document: dict[str, Any] | None = None,
    issues: list[Issue] | None = None,
) -> dict[str, Any]:
    """A style as core answers it (``StyleRead``)."""
    return {
        "id": style.id,
        "name": style.name,
        "position": style.position,
        "revision": style.revision,
        "document": style.document if document is None else document,
        "issues": _issues_json(issues or []),
        "stale": False,
    }


def _group_read(project_id: str, group_id: int, row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row["name"],
        "parent_id": row["parent_id"],
        "id": group_id,
        "project_id": project_id,
        "order": row["order"],
        "visible": row["visible"],
        "expanded": row["expanded"],
        "bundle_id": None,
    }


#: How core refuses a user who may only view the project: the style and
#: map-state routes check the role first (``access``, 403 `forbidden`); the
#: other writes refuse in ``auth_z``, whose project check needs an editor and
#: whose every refusal is 401.
_VIEWER_REFUSED = {
    "access": (403, {"detail": {"code": "forbidden"}}),
    "auth_z": (401, {"detail": "Unauthorized"}),
}
#: (method, path after the project's, handler, how a viewer is refused; None
#: for a route a viewer may use).
_ROUTES: tuple[tuple[str, str, str, str | None], ...] = (
    ("GET", r"", "_project", None),
    ("PUT", r"", "_update_project", "auth_z"),
    ("GET", r"/layer", "_layer_rows", None),
    ("DELETE", r"/layer", "_remove_layer", "auth_z"),
    ("PUT", r"/layer/(\d+)", "_update_layer", "auth_z"),
    ("PATCH", r"/layer/(\d+)/map-state", "_layer_state", "access"),
    ("POST", r"/layer/(\d+)/style", "_create_style", "access"),
    ("GET", r"/layer/(\d+)/style/([^/]+)", "_read_style", None),
    ("PUT", r"/layer/(\d+)/style/([^/]+)", "_save_style", "access"),
    ("PATCH", r"/layer/(\d+)/style/([^/]+)", "_update_style", "access"),
    ("DELETE", r"/layer/(\d+)/style/([^/]+)", "_delete_style", "access"),
    # A check stores nothing: project read is enough.
    ("POST", r"/layer/(\d+)/style/([^/]+)/check", "_check_style", None),
    ("GET", r"/group", "_group_rows", None),
    ("POST", r"/group", "_create_group", "auth_z"),
    ("PUT", r"/group/(\d+)", "_update_group", "auth_z"),
    ("DELETE", r"/group/(\d+)", "_remove_group", "auth_z"),
    ("PATCH", r"/group/(\d+)/map-state", "_group_state", "access"),
    ("PUT", r"/layer-tree", "_update_tree", "auth_z"),
    ("GET", r"/map", "_map", None),
    ("GET", r"/workflow", "_workflows", None),
    ("GET", r"/report-layout", "_layouts", None),
)
_DEFAULT_STYLE = re.compile(r"/api/v2/layer/([^/]+)/style")


class MapCore(Recorder):
    """Core's routes of one map project, answered from a ``MapState``."""

    def __init__(self, state: MapState, *, read_only: bool = False) -> None:
        super().__init__()
        self.state = state
        self.read_only = read_only
        self.project_id = MAP_VIEW_PROJECT_ID if read_only else MAP_PROJECT_ID
        self.base = f"/api/v2/project/{self.project_id}"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        response = self.answer(request)
        if response is None:
            return super().__call__(request)
        self.requests.append(request)
        return response

    def answer(self, request: httpx.Request) -> httpx.Response | None:
        """Core's reply to a request of this project; None for any other."""
        path = request.url.path
        default = _DEFAULT_STYLE.fullmatch(path)
        if request.method == "GET" and default:
            layer = MAP_LAYERS_BY_ID.get(default.group(1))
            return (
                None if layer is None else self._guarded(self._default, request, layer)
            )
        if path != self.base and not path.startswith(f"{self.base}/"):
            return None
        rest = path[len(self.base) :]
        for method, pattern, name, refused in _ROUTES:
            found = re.fullmatch(pattern, rest)
            if method == request.method and found:
                if refused and self.read_only:
                    status, body = _VIEWER_REFUSED[refused]
                    return httpx.Response(status, json=body)
                return self._guarded(getattr(self, name), request, *found.groups())
        return None

    def _guarded(
        self, handler: Callable[..., httpx.Response], *args: Any
    ) -> httpx.Response:
        core = _core()
        try:
            return handler(*args)
        except _RouteError as error:
            return error.response
        except core.StyleSaveError as error:
            detail: dict[str, Any] = {"code": error.code}
            if error.issues:
                detail["issues"] = _issues_json(error.issues)
            return httpx.Response(error.status, json={"detail": detail})
        except core.HTTPException as error:
            return httpx.Response(error.status_code, json={"detail": error.detail})

    # ---- lookups

    def _layer(self, layer_project_id: str) -> int:
        """A layer of the project for the style and map-state routes (404 `not_found`)."""
        if int(layer_project_id) not in self.state.layers:
            raise _RouteError(404, _NOT_FOUND)
        return int(layer_project_id)

    def _style(self, layer_project_id: str, style_id: str) -> NamedStyle:
        """A named style of this layer (``read_named``; 404 `not_found`)."""
        link = self._layer(layer_project_id)
        style = self.state.styles.get(style_id)
        if style is None or style.layer_project_id != link:
            raise _RouteError(404, _NOT_FOUND)
        return style

    def _stored(self, style: NamedStyle) -> Any:
        layer = map_layer(style.layer_project_id)
        return _core().StoredStyle(
            id=UUID(style.id),
            name=style.name,
            position=style.position,
            revision=style.revision,
            document=style.document,
            layer_project_id=style.layer_project_id,
            dataset_id=UUID(layer.layer_id),
            layer_type=layer.layer_type,
            geometry=layer.geometry or None,
            data_snapshot=None if layer.layer_type == "raster" else DATA_SNAPSHOT,
            catalog_version=None,
        )

    def _check(
        self, layer_project_id: int, document: dict[str, Any]
    ) -> tuple[dict[str, Any], list[Issue]]:
        return _check(self.state.connection, map_layer(layer_project_id), document)

    # ---- project, layers, groups

    def _project(self, request: httpx.Request) -> httpx.Response:
        state = self.state
        return httpx.Response(
            200,
            json={
                "id": self.project_id,
                "name": MAP_PROJECT_NAME,
                "folder_id": FOLDER_ID,
                "basemap": state.basemap,
                "scene": state.scene,
                "builder_config": state.builder_config,
                "layer_order": sorted(state.layers),
            },
        )

    def _update_project(self, request: httpx.Request) -> httpx.Response:
        """Core's project update, for the basemap and the scene (``checked_scene``)."""
        body = _json(request) or {}
        scene = self.state.scene
        if "scene" in body:
            scene = self._checked_scene(body["scene"])
        if "basemap" in body:
            self.state.basemap = body["basemap"]
        self.state.scene = scene
        return self._project(request)

    def _checked_scene(self, scene: Any) -> dict[str, Any] | None:
        if not scene:
            return None
        if json_bytes(scene) > MAX_MAP_VALUE_BYTES:
            raise _RouteError(422, {"detail": {"code": "scene_too_large"}})
        extruded = frozenset(
            link
            for link, row in self.state.layers.items()
            if row["visible"]
            and extrudes(self.state.styles[self.state.active_style_id(link)].document)
        )
        issues = validate_map(
            {"version": SPEC_VERSION, "scene": scene},
            MapContext(layers={}, extruded=extruded),
        )
        if any(i.level == "error" for i in issues):
            raise _RouteError(
                422,
                {"detail": {"code": "invalid_scene", "issues": _issues_json(issues)}},
            )
        return cast(dict[str, Any], scene)

    def _row(self, layer_project_id: int) -> dict[str, Any]:
        layer, row = map_layer(layer_project_id), self.state.layers[layer_project_id]
        return {
            "id": layer_project_id,
            "layer_id": layer.layer_id,
            "name": row["name"],
            "type": layer.layer_type,
            "feature_layer_geometry_type": layer.geometry or None,
            "layer_project_group_id": row["layer_project_group_id"],
            "order": row["order"],
            "locked": False,
            "query": row["query"],
        }

    def _layer_rows(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=[self._row(link) for link in sorted(self.state.layers)]
        )

    def _remove_layer(self, request: httpx.Request) -> httpx.Response:
        raw = request.url.params.get("layer_project_id", "")
        if not raw.isdigit():
            raise _RouteError(
                422,
                {
                    "detail": [
                        {
                            "type": "int_parsing",
                            "loc": ["query", "layer_project_id"],
                            "msg": "Input should be a valid integer",
                        }
                    ]
                },
            )
        link = int(raw)
        if link not in self.state.layers:
            raise _RouteError(404, {"detail": "Layer project relation not found"})
        # Dashboards, workflows and print layouts keep naming it, as in core.
        self.state.remove_layer(link)
        return httpx.Response(204)

    def _update_layer(
        self, request: httpx.Request, layer_project_id: str
    ) -> httpx.Response:
        """Core's project layer update: the name, and for a feature layer the
        filter, checked as core checks a filter a save changes."""
        core = _core()
        body = _json(request) or {}
        if "properties" in body:
            raise _RouteError(422, {"detail": core.PROPERTIES_REFUSED})
        link = int(layer_project_id)
        if link not in self.state.layers:
            raise _RouteError(404, {"detail": "Layer project not found"})
        row = self.state.layers[link]
        query = row["query"]
        if "query" in body and map_layer(link).layer_type == "feature":
            query = body["query"]
            if query is not None:
                try:
                    parsed = core.CQLQueryObject.model_validate(query)
                except ValidationError as error:
                    raise _RouteError(422, {"detail": str(error)}) from None
                errors = core.query_save_errors(row["query"], parsed)
                if errors:
                    raise _RouteError(422, {"detail": "; ".join(errors)})
        if "name" in body:
            row["name"] = body["name"]
        row["query"] = query
        return httpx.Response(200, json=self._row(link))

    def _layer_state(
        self, request: httpx.Request, layer_project_id: str
    ) -> httpx.Response:
        """A layer's map state: only the fields sent, last write wins."""
        link = self._layer(layer_project_id)
        state = _parsed(_core().LayerMapState, request)
        if json_bytes(state.time_value) > MAX_MAP_VALUE_BYTES:
            raise _RouteError(422, {"detail": {"code": "time_value_too_large"}})
        values = {
            key: getattr(state, key)
            for key in state.model_fields_set
            if not (key in _NOT_NULL and getattr(state, key) is None)
        }
        active = values.get("active_style_id")
        if active is not None:
            values["active_style_id"] = str(active)
            style = self.state.styles.get(str(active))
            if style is None or style.layer_project_id != link:
                raise _RouteError(422, {"detail": {"code": "style_not_on_layer"}})
        self.state.layers[link].update(values)
        return httpx.Response(204)

    def _group_rows(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                _group_read(self.project_id, group_id, row)
                for group_id, row in sorted(self.state.groups.items())
            ],
        )

    def _create_group(self, request: httpx.Request) -> httpx.Response:
        body = _parsed(_core().ILayerProjectGroupCreate, request)
        if body.parent_id:
            parent = self.state.groups.get(body.parent_id)
            if parent is None:
                raise _RouteError(404, {"detail": "Parent group not found"})
            if parent["parent_id"] is not None:
                raise _RouteError(
                    400, {"detail": "Maximum nesting level reached (Max 2 levels)"}
                )
        group_id = self.state._next_group
        self.state._next_group += 1
        self.state.groups[group_id] = {
            "name": body.name,
            "parent_id": body.parent_id,
            "order": 0,
            "visible": True,
            "expanded": True,
        }
        return httpx.Response(
            201,
            json=_group_read(self.project_id, group_id, self.state.groups[group_id]),
        )

    def _update_group(self, request: httpx.Request, group_id: str) -> httpx.Response:
        body = _parsed(_core().ILayerProjectGroupUpdate, request)
        row = self.state.groups.get(int(group_id))
        if row is None:
            raise _RouteError(404, {"detail": "Group not found"})
        changes = body.model_dump(exclude_unset=True)
        parent_id = changes.get("parent_id")
        if parent_id is not None:
            if parent_id == int(group_id):
                raise _RouteError(400, {"detail": "Cannot set parent to self"})
            parent = self.state.groups.get(parent_id)
            if parent is None:
                raise _RouteError(404, {"detail": "Parent group not found"})
            if parent["parent_id"] is not None:
                raise _RouteError(400, {"detail": "Maximum nesting level reached"})
        row.update(changes)
        return httpx.Response(
            200, json=_group_read(self.project_id, int(group_id), row)
        )

    def _remove_group(self, request: httpx.Request, group_id: str) -> httpx.Response:
        """Deletes a group with its sub-groups and the layers in them, as
        core's cascade does."""
        if int(group_id) not in self.state.groups:
            raise _RouteError(404, {"detail": "Group not found"})
        gone = {int(group_id)} | {
            g
            for g, row in self.state.groups.items()
            if row["parent_id"] == int(group_id)
        }
        for link, row in sorted(self.state.layers.items()):
            if row["layer_project_group_id"] in gone:
                self.state.remove_layer(link)
        for g in gone:
            del self.state.groups[g]
        return httpx.Response(204)

    def _group_state(self, request: httpx.Request, group_id: str) -> httpx.Response:
        state = _parsed(_core().GroupMapState, request)
        row = self.state.groups.get(int(group_id))
        if row is None:
            raise _RouteError(404, _NOT_FOUND)
        row["visible"] = state.visible
        return httpx.Response(204)

    def _update_tree(self, request: httpx.Request) -> httpx.Response:
        """The tree's places and the map state it shows; unknown ids are
        skipped, as core's bulk update skips them."""
        tree = _parsed(_core().LayerTreeUpdate, request)
        for item in tree.items:
            if item.type == "group" and item.id in self.state.groups:
                row = self.state.groups[item.id]
                row.update(parent_id=item.parent_id, order=item.order)
                for key in ("visible", "expanded"):
                    if getattr(item, key) is not None:
                        row[key] = getattr(item, key)
            elif item.type == "layer" and item.id in self.state.layers:
                row = self.state.layers[item.id]
                row.update(layer_project_group_id=item.parent_id, order=item.order)
                for key in ("visible", "legend_expanded"):
                    if getattr(item, key) is not None:
                        row[key] = getattr(item, key)
        return httpx.Response(204)

    # ---- the map document

    def _map(self, request: httpx.Request) -> httpx.Response:
        """Core's map request: the map document from the rows
        (``build_map_document``), the drawn style of every layer whole and the
        others by name."""
        state = self.state
        rows, styles = [], {}
        for link, row in state.layers.items():
            drawn = state.styles[state.active_style_id(link)]
            styles[str(link)] = {
                "active": _read(drawn),
                "others": [
                    {"id": s.id, "name": s.name}
                    for s in state.styles_of(link)
                    if s.id != drawn.id
                ],
            }
            rows.append(
                LayerRow(
                    id=link,
                    group_id=row["layer_project_group_id"],
                    order=row["order"],
                    visible=row["visible"],
                    position=row["position"],
                    query=row["query"],
                    time_value=row["time_value"],
                    legend_expanded=row["legend_expanded"],
                    style_id=UUID(drawn.id),
                )
            )
        document = build_map_document(
            basemap=state.basemap,
            locale=None,
            view_state=MAP_VIEW_STATE,
            bounds=None,
            groups=[
                GroupRow(
                    g,
                    r["name"],
                    r["parent_id"],
                    r["order"],
                    r["visible"],
                    r["expanded"],
                )
                for g, r in state.groups.items()
            ],
            layers=rows,
            scene=state.scene,
        )
        return httpx.Response(
            200, json={"map": document, "styles": styles, "unpublished": []}
        )

    def _workflows(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[MAP_WORKFLOW])

    def _layouts(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[MAP_REPORT_LAYOUT])

    # ---- styles

    def _default(self, request: httpx.Request, layer: FixtureLayer) -> httpx.Response:
        """The dataset's default style: goatlib's default for the layer."""
        kind = "raster" if layer.layer_type == "raster" else "vector"
        document = default_style(_context(layer, {"kind": kind}), seed=layer.layer_id)
        return httpx.Response(
            200,
            json={
                "id": f"5d000000-0000-4000-8000-0000000000{layer.layer_project_id}",
                "name": "Default",
                "position": 0,
                "revision": 1,
                "document": document,
                "issues": [],
                "stale": False,
            },
        )

    def _create_style(
        self, request: httpx.Request, layer_project_id: str
    ) -> httpx.Response:
        """A new named style: a copy of `copy_from`, else of the drawn style
        (core's ``create_style``); 409 `too_many_styles` past ``MAX_STYLES``."""
        link = self._layer(layer_project_id)
        body = _parsed(_core().StyleCreate, request)
        if body.copy_from is not None:
            source = self._style(layer_project_id, str(body.copy_from))
        else:
            source = self.state.styles[self.state.active_style_id(link)]
        if len(self.state.styles_of(link)) >= MAX_STYLES:
            raise _RouteError(409, {"detail": {"code": "too_many_styles"}})
        layer = map_layer(link)
        document = stamp(
            upgrade(source.document, _context(layer, source.document)).document
        )
        style = self.state.add_style(link, body.name, document)
        return httpx.Response(200, json=_read(style))

    def _read_style(
        self, request: httpx.Request, layer_project_id: str, style_id: str
    ) -> httpx.Response:
        """One style; with `check`, its issues as processes reports a stored
        style's (``damaged`` included). Stored values are current: the
        fixture's data never changes, so nothing is recomputed."""
        style = self._style(layer_project_id, style_id)
        layer = map_layer(style.layer_project_id)
        document = upgrade(style.document, _context(layer, style.document)).document
        issues = None
        if request.url.params.get("check") == "true":
            _, issues = _style_check(
                self.state.connection, layer, document, compute=False, stored=True
            )
        return httpx.Response(200, json=_read(style, document, issues))

    def _save_style(
        self, request: httpx.Request, layer_project_id: str, style_id: str
    ) -> httpx.Response:
        """Core's ``save_style`` of a named style, step by step."""
        core = _core()
        style = self._style(layer_project_id, style_id)
        body = _parsed(core.StyleSaveRequest, request)
        core.check_size(body.document)
        stored = self._stored(style)
        incoming = core.incoming_document(body.document, stored.context(body.document))
        if body.base_rev == style.revision:
            base = style.document
        elif body.base_rev in style.revisions:
            kept = style.revisions[body.base_rev]
            base = upgrade(kept, stored.context(kept)).document
        else:
            raise _RouteError(409, {"detail": {"code": "base_too_old"}})
        candidate, changes, unchanged = core._candidate(stored, base, incoming)
        if unchanged:
            issues = validate(style.document, stored.context(style.document))
            return httpx.Response(200, json=_read(style, issues=issues))
        checked, issues = self._check(style.layer_project_id, candidate)
        if changes:
            kept_doc = core._kept(stored, checked, issues, changes)
            if kept_doc != checked:
                # The reply still carries the errors that were not saved.
                refused_errors = [i for i in issues if i.level == "error"]
                checked, issues = self._check(style.layer_project_id, kept_doc)
                known = {(i.code, i.path) for i in issues}
                issues += [i for i in refused_errors if (i.code, i.path) not in known]
        checked, unchanged = core._to_store(stored, checked)
        if unchanged:
            return httpx.Response(200, json=_read(style, issues=issues))
        style.revision += 1
        style.document = checked
        style.revisions[style.revision] = copy.deepcopy(checked)
        for revision in [
            r for r in style.revisions if r <= style.revision - KEPT_REVISIONS
        ]:
            del style.revisions[revision]
        return httpx.Response(200, json=_read(style, issues=issues))

    def _update_style(
        self, request: httpx.Request, layer_project_id: str, style_id: str
    ) -> httpx.Response:
        """Renames a style or moves it among the layer's styles; the revision stays."""
        style = self._style(layer_project_id, style_id)
        body = _parsed(_core().StyleUpdate, request)
        if body.name is not None:
            style.name = body.name
        if body.position is not None:
            others = [
                s
                for s in self.state.styles_of(style.layer_project_id)
                if s is not style
            ]
            others.insert(min(body.position, len(others)), style)
            for position, item in enumerate(others):
                item.position = position
        return httpx.Response(200, json=_read(style))

    def _delete_style(
        self, request: httpx.Request, layer_project_id: str, style_id: str
    ) -> httpx.Response:
        """Deletes a style; the active one hands over to the first remaining.
        409 `last_style`: a layer keeps at least one."""
        style = self._style(layer_project_id, style_id)
        link = style.layer_project_id
        if len(self.state.styles_of(link)) <= 1:
            raise _RouteError(409, {"detail": {"code": "last_style"}})
        del self.state.styles[style.id]
        if self.state.layers[link]["active_style_id"] == style.id:
            self.state.layers[link]["active_style_id"] = self.state.styles_of(link)[
                0
            ].id
        return httpx.Response(204)

    def _check_style(
        self, request: httpx.Request, layer_project_id: str, style_id: str
    ) -> httpx.Response:
        """The save's checks on the stored document, or the one given, with
        its computed values; nothing is stored."""
        core = _core()
        style = self._style(layer_project_id, style_id)
        body = _parsed(core.StyleCheckRequest, request)
        if body.document is not None:
            core.check_size(body.document)
        candidate = core._checked_form(self._stored(style), body.document)
        document, issues = self._check(style.layer_project_id, candidate)
        return httpx.Response(
            200, json={"document": document, "issues": _issues_json(issues)}
        )


def map_core(state: MapState, *, read_only: bool = False) -> MapCore:
    """Core for the map project (``MAP_PROJECT_ID``), or with ``read_only``
    for the viewer's (``MAP_VIEW_PROJECT_ID``), whose writes core refuses as
    it refuses a viewer (``_VIEWER_REFUSED``). Its ``answer`` is None for any other request."""
    return MapCore(state, read_only=read_only)
