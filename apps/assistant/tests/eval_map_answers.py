"""Hand-written right answers to the map suite's tasks, applied to the
stand-in through core's own routes: what the tools should store. Each
proves that its task can be passed and that the checks read the places the
answer writes (``test_eval_map.test_every_task_expectation_is_reachable``).

An answer's Undo is written out as the writes that restore the state before
(``Answer.undo``)."""

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from goatlib.filter.areas import (
    REGION_SOURCE,
    Piece,
    add_feature,
    add_view,
    area_of,
    filter_fits,
)
from goatlib.filter.rows import Rows, read_rows, write_rows

from evals.backends import AREA_REGIONS, _geometry
from evals.harness import ToolCall, Transcript, map_states
from evals.map_backends import MapState, map_core
from evals.map_fixture import (
    LAND_USE_QUERY,
    MAP_PROJECT_ID,
    MAP_RESULT_LAYER,
    MAP_VIEW_PROJECT_ID,
    map_layer,
)
from evals.tasks import EvalTask

Document = dict[str, Any]
#: The ids of the first two styles an answer makes in the map project.
FIRST_MADE = "5f000000-0000-4000-8000-000000000012"
SECOND_MADE = "5f000000-0000-4000-8000-000000000013"


class Api:
    """Core's map routes for one state, called as the tools would call them;
    every write must succeed."""

    def __init__(self, state: MapState, project_id: str = MAP_PROJECT_ID) -> None:
        self.state = state
        self.core = map_core(state, read_only=project_id == MAP_VIEW_PROJECT_ID)
        self.base = f"/api/v2/project/{project_id}"

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        request = httpx.Request(
            method,
            f"http://core{self.base}{path}",
            params=params,
            content=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json"} if body is not None else None,
        )
        response: httpx.Response = self.core(request)
        assert response.status_code < 300, (path, response.status_code, response.text)
        return response.json() if response.content else None

    def _save(self, link: int, style_id: str, document: Document) -> None:
        style = self.state.styles[style_id]
        reply = self.call(
            "PUT",
            f"/layer/{link}/style/{style_id}",
            {"base_rev": style.revision, "document": document},
        )
        errors = [i for i in reply["issues"] if i["level"] in ("error", "damaged")]
        assert not errors, errors

    def edit(self, link: int, change: Callable[[Document], Any]) -> None:
        """The active style edited in place."""
        style_id = self.state.active_style_id(link)
        document = copy.deepcopy(self.state.styles[style_id].document)
        change(document)
        self._save(link, style_id, document)

    def new_style(
        self,
        link: int,
        name: str,
        change: Callable[[Document], Any],
        activate: bool = True,
    ) -> str:
        """A new named style, a copy of the active one changed, made active."""
        made = self.call("POST", f"/layer/{link}/style", {"name": name})
        document = copy.deepcopy(made["document"])
        change(document)
        self._save(link, made["id"], document)
        if activate:
            self.layer_state(link, active_style_id=made["id"])
        return str(made["id"])

    def remove_style(self, link: int, style_id: str) -> None:
        self.call("DELETE", f"/layer/{link}/style/{style_id}")

    def layer_state(self, link: int, **values: Any) -> None:
        self.call("PATCH", f"/layer/{link}/map-state", values)

    def put_layer(self, link: int, **body: Any) -> None:
        self.call("PUT", f"/layer/{link}", body)

    def remove_layer(self, link: int) -> None:
        self.call("DELETE", "/layer", params={"layer_project_id": link})

    def tree(self, items: list[dict[str, Any]]) -> None:
        self.call("PUT", "/layer-tree", {"items": items})

    def add_group(self, name: str, parent_id: int | None = None) -> int:
        return int(
            self.call("POST", "/group", {"name": name, "parent_id": parent_id})["id"]
        )

    def group_state(self, group_id: int, **values: Any) -> None:
        self.call("PATCH", f"/group/{group_id}/map-state", values)

    def project(self, **body: Any) -> None:
        self.call("PUT", "", body)


Step = Callable[[Api], Any]


@dataclass
class Answer:
    #: The writes of the answer (of its first turn when a card is answered).
    run: Step = lambda api: None
    #: The writes after the eval user answered the card.
    after_card: Step | None = None
    #: The writes the Undo makes, given the state before the answer.
    undo: Callable[[Api, dict[str, Any]], Any] | None = None
    calls: list[ToolCall] = field(default_factory=list)
    #: The workflows core saved in the answer.
    saved: list[dict[str, Any]] = field(default_factory=list)
    answer: str = "Done: the map shows it now."


def _call(name: str, result: Any = None) -> ToolCall:
    return ToolCall(name, {}, result if result is not None else {}, False)


def _map_update(operations: list[dict[str, Any]], view: dict[str, Any]) -> ToolCall:
    return ToolCall(
        "map_update",
        {"operations": operations},
        {"project_id": MAP_PROJECT_ID, "applied": [], "view": view},
        False,
    )


def _new_style_call(name: str, asked: str) -> ToolCall:
    """A style_update call that makes a named style, quoting the task's own
    words that ask for it."""
    return ToolCall(
        "style_update",
        {"new_style": {"name": name, "asked": asked, "start": "current"}},
        {"created": True},
        False,
    )


def _restore_style(link: int) -> Callable[[Api, dict[str, Any]], Any]:
    """Undo of a style edited in place: the document before saved again."""

    def undo(api: Api, before: dict[str, Any]) -> None:
        style_id = before["layers"][link]["active_style_id"]
        old = before["styles"][style_id]["document"]
        api.edit(link, lambda d: (d.clear(), d.update(copy.deepcopy(old))))

    return undo


def _drop_created(link: int) -> Callable[[Api, dict[str, Any]], Any]:
    """Undo of a style made in the answer: the old one active, the new one gone."""

    def undo(api: Api, before: dict[str, Any]) -> None:
        api.layer_state(link, active_style_id=before["layers"][link]["active_style_id"])
        for style_id in [s for s in api.state.styles if s not in before["styles"]]:
            api.remove_style(link, style_id)

    return undo


def _symbol(part: str, **keys: Any) -> Callable[[Document], Any]:
    def change(document: Document) -> None:
        current = document.setdefault("symbol", {}).get(part)
        document["symbol"][part] = {
            **(current if isinstance(current, dict) else {}),
            **keys,
        }

    return change


def _set(**keys: Any) -> Callable[[Document], Any]:
    return lambda document: document.update(copy.deepcopy(keys))


def _public_transport(api: Api) -> None:
    group = api.add_group("Public transport")
    api.tree(
        [
            {"id": group, "type": "group", "order": 0, "parent_id": None},
            {"id": 40, "type": "layer", "order": 0, "parent_id": group},
            {"id": 33, "type": "layer", "order": 1, "parent_id": group},
        ]
    )


def _hide_but_cycling(api: Api) -> None:
    api.group_state(1, visible=False)
    for link in (32, 35, 37, 40, 33):
        api.layer_state(link, visible=False)


def _leave_out_residential(api: Api) -> None:
    query = copy.deepcopy(LAND_USE_QUERY)
    query["cql"]["args"].append(
        {"op": "<>", "args": [{"property": "use"}, "residential"]}
    )
    api.put_layer(34, query=query)


def _on_top_renamed(api: Api) -> None:
    api.put_layer(32, name="Shops and services")
    api.tree([{"id": 32, "type": "layer", "order": -1, "parent_id": None}])


def _density_ramp(document: Document) -> None:
    """The classes of the first variant give way to a smooth ramp."""
    document.pop("classify", None)
    _symbol("fill", color={"field": "density", "palette": "colorbrewer:YlGnBu"})(
        document
    )


def _two_density_variants(api: Api) -> None:
    """Two named styles: the first drawn, the second a copy of it changed
    and left for the user to pick."""
    api.new_style(
        31,
        "Density in classes",
        _set(
            classify=[
                {
                    "field": "density",
                    "method": "quantile",
                    "count": 5,
                    "palette": "colorbrewer:YlOrRd",
                }
            ]
        ),
    )
    api.new_style(31, "Density as a ramp", _density_ramp, activate=False)


#: A workflow as core saves it: walking catchments around the stations.
CATCHMENT_WORKFLOW: dict[str, Any] = {
    "id": "0b6f0000-0000-0000-0000-000000000001",
    "project_id": MAP_PROJECT_ID,
    "name": "Walking catchments around the stations",
    "config": {
        "nodes": [
            {
                "id": "stations",
                "data": {
                    "type": "dataset",
                    "projectLayerId": 40,
                    "layerId": map_layer(40).layer_id,
                },
            },
            {
                "id": "walk",
                "data": {
                    "type": "tool",
                    "processId": "catchment_area_v2",
                    "config": {"routing_mode": "walking", "max_cost": 15, "steps": 3},
                },
            },
            {
                "id": "save",
                "data": {"type": "export", "datasetName": "Walking catchments"},
            },
        ],
        "edges": [
            {"source": "stations", "target": "walk", "targetHandle": "starting_points"},
            {"source": "walk", "target": "save", "targetHandle": "input"},
        ],
    },
}
#: The calls that build and run it, as the graders read them.
_BUILT_AND_RUN = [
    ToolCall(
        "workflow_create",
        {},
        {"workflow": {"id": CATCHMENT_WORKFLOW["id"]}, "open_issues": []},
        False,
    ),
    _call("workflow_run", {"status": "succeeded"}),
]


def _run_saved(api: Api) -> None:
    """What the run leaves in the project: its result layer."""
    api.state.add_result(MAP_RESULT_LAYER, "Walking catchments")


def _half_transparent_result(api: Api) -> None:
    _run_saved(api)
    api.edit(
        MAP_RESULT_LAYER.layer_project_id,
        lambda d: (
            _symbol("fill", opacity=0.5)(d),
            _symbol("outline", color="#333333", width=0.5)(d),
        ),
    )


def _hide_land_use_light(api: Api) -> None:
    api.layer_state(34, visible=False)
    api.project(basemap="light")


def _undo_land_use_light(api: Api, before: dict[str, Any]) -> None:
    api.layer_state(34, visible=True)
    api.project(basemap=before["basemap"])


def _with_area(link: int, pieces: tuple[Piece, ...]) -> Callable[[Api], None]:
    """The layer's filter with these pieces as its area, its rows kept, as
    the filter panel saves it."""

    def change(api: Api) -> None:
        stored = read_rows(api.state.layers[link]["query"], None)
        cql, notes = area_of(pieces)
        api.put_layer(
            link,
            query=write_rows(
                Rows(stored.match, stored.rows, area=cql, area_notes=notes)
            ),
        )

    return change


def _region_pieces(region_id: str) -> tuple[Piece, ...]:
    name, outline = AREA_REGIONS[region_id]
    added = add_feature(
        (), REGION_SOURCE, region_id, outline, name=name, fits=filter_fits()
    )
    assert added is not None
    return added.pieces


def _district_pieces(*numbers: int) -> tuple[Piece, ...]:
    """Districts picked as the items route answers them: district n is the
    feature with id n."""
    districts = map_layer(31)
    pieces: tuple[Piece, ...] = ()
    for n in numbers:
        feature = districts.features[n - 1]
        added = add_feature(
            pieces,
            districts.layer_id,
            str(n),
            _geometry(districts, feature["_at"]),
            name=feature["name"],
            fits=filter_fits(),
        )
        assert added is not None
        pieces = added.pieces
    return pieces


def _view_pieces(bounds: tuple[float, float, float, float]) -> tuple[Piece, ...]:
    added = add_view((), bounds, fits=filter_fits())
    assert added is not None
    return added.pieces


#: Points of interest by kind: the five most frequent each with an icon,
#: the rest in grey.
_ICON_CLASSES: list[dict[str, Any]] = [
    {
        "field": "category",
        "method": "categories",
        "palette": "colorbrewer:Dark2",
        "classes": [
            {"values": [value], "marker": {"color": color, "icon": icon}}
            for value, color, icon in (
                ("restaurant", "#1b9e77", "goat:restaurant"),
                ("cafe", "#d95f02", "goat:mug-hot-solid"),
                ("shop", "#7570b3", "goat:shop"),
                ("bus_stop", "#e7298a", "goat:bus"),
                ("pharmacy", "#66a61e", "goat:pharmacy"),
            )
        ],
        "other": {"name": "Other", "marker": {"color": "#9aa3ad"}},
    }
]


def _without_area(api: Api) -> None:
    stored = read_rows(api.state.layers[34]["query"], None)
    api.put_layer(34, query=write_rows(Rows(stored.match, stored.rows)))


ANSWERS: dict[str, Answer] = {
    "map-01": Answer(
        lambda api: api.edit(
            31,
            _set(
                classify=[
                    {
                        "title": "Residents per km²",
                        "field": "density",
                        "method": "quantile",
                        "count": 5,
                        "palette": "colorbrewer:YlOrRd",
                    }
                ]
            ),
        )
    ),
    "map-02": Answer(
        lambda api: api.edit(
            32,
            _set(
                classify=[
                    {
                        "field": "category",
                        "method": "categories",
                        "count": 5,
                        "palette": "colorbrewer:Set2",
                        "other": {"name": "Other", "marker": {"color": "#bdbdbd"}},
                    }
                ]
            ),
        ),
        calls=[_call("project_field_statistics")],
    ),
    "map-03": Answer(
        lambda api: api.edit(
            33,
            lambda d: (
                _symbol("line", color="#ffd400", width=3)(d),
                _symbol("casing", color="#1a1a1a", width=1.5)(d),
            ),
        ),
        answer="On the satellite image the thin purple lines got lost, so they are "
        "yellow and wider now, with a dark edge.",
    ),
    "map-04": Answer(
        lambda api: api.edit(40, _symbol("label", text="{name}", min_zoom=13))
    ),
    "map-05": Answer(
        lambda api: api.edit(31, _symbol("outline", color="#4d4d4d", width=0.5))
    ),
    "map-06": Answer(lambda api: api.edit(34, _symbol("fill", opacity=0.5))),
    "map-07": Answer(
        lambda api: api.edit(
            35,
            _set(
                classify=[
                    {
                        "field": "turnout_change",
                        "method": "manual",
                        "palette": "colorbrewer:RdBu",
                        "classes": [
                            {"to": -5, "marker": {"color": "#ca0020"}},
                            {"from": -5, "to": 0, "marker": {"color": "#f4a582"}},
                            {"from": 0, "to": 5, "marker": {"color": "#92c5de"}},
                            {"from": 5, "marker": {"color": "#0571b0"}},
                        ],
                    }
                ]
            ),
        )
    ),
    "map-08": Answer(
        lambda api: api.edit(
            32, _symbol("marker", icon="goat:cart-shopping-solid", icon_color="#ffffff")
        ),
        calls=[_call("style_catalog")],
    ),
    "map-09": Answer(
        lambda api: api.edit(
            37,
            _set(
                render={
                    "type": "hillshade",
                    "method": "standard",
                    "exaggeration": 0.5,
                    "palette": "goat:elevation",
                }
            ),
        )
    ),
    "map-10": Answer(
        lambda api: api.edit(
            38,
            _set(
                render={
                    "type": "continuous",
                    "band": {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"},
                    "palette": "goat:green",
                    "domain": [-0.2, 0.8],
                }
            ),
        )
    ),
    "map-11": Answer(
        lambda api: api.edit(
            36, _symbol("extrude", height={"field": "floors"}, unit="storeys")
        ),
        calls=[
            _map_update(
                [{"op": "set_view", "mode": "3d", "pitch": 50}],
                {"camera": {"pitch": 50}, "mode": "3d"},
            )
        ],
    ),
    "map-12": Answer(
        lambda api: api.edit(
            36,
            _set(
                classify=[
                    {
                        "field": "year_built",
                        "method": "equal_interval",
                        "count": 5,
                        "palette": "colorbrewer:YlGnBu",
                        "no_data": {"name": "Unknown", "fill": {"color": "#d9d9d9"}},
                    }
                ]
            ),
        ),
        answer="The buildings are colored by the year they were built. 280 of them "
        "have no year; they are grey.",
    ),
    "map-13": Answer(
        lambda api: api.edit(
            40,
            _set(
                popup={
                    "blocks": [
                        {
                            "type": "field_list",
                            "attributes": [
                                {"field": "name", "label": "Name"},
                                {"field": "lines", "label": "Lines"},
                            ],
                        }
                    ]
                }
            ),
        )
    ),
    "map-14": Answer(
        lambda api: api.edit(31, _set(legend={"title": "Residents per km²"}))
    ),
    "map-15": Answer(
        lambda api: api.edit(
            32,
            _set(render={"type": "heatmap", "radius": 20, "palette": "d3:magma"}),
        )
    ),
    "map-16": Answer(
        lambda api: api.edit(
            32, _set(render={"type": "cluster", "radius": 50, "cluster_until_zoom": 15})
        )
    ),
    "map-17": Answer(
        _two_density_variants,
        after_card=lambda api: api.layer_state(31, active_style_id=SECOND_MADE),
        calls=[
            _new_style_call("Density in classes", "two style options"),
            _new_style_call("Density as a ramp", "as separate styles"),
            ToolCall(
                "ask_user",
                {
                    "questions": [
                        {
                            "question": "Which style should the map show?",
                            "header": "Look",
                            "options": [
                                {
                                    "label": "Five classes",
                                    "description": (
                                        "Yellow to red, active now; "
                                        "the other stays in the style list."
                                    ),
                                    "value": f"use_style:{FIRST_MADE}",
                                    "recommended": True,
                                },
                                {
                                    "label": "Smooth ramp",
                                    "description": (
                                        "Yellow to blue, no class limits; "
                                        "the other stays in the style list."
                                    ),
                                    "value": f"use_style:{SECOND_MADE}",
                                },
                            ],
                        }
                    ]
                },
                {"card_id": "ask-1"},
                False,
            ),
        ],
    ),
    "map-18": Answer(
        lambda api: api.edit(
            33,
            _symbol("line", width={"field": "frequency_per_hour", "range": [1, 8]}),
        )
    ),
    "map-19": Answer(
        lambda api: api.edit(
            33,
            _set(
                classify=[
                    {
                        "field": "line_class",
                        "method": "categories",
                        "count": 5,
                        "palette": "colorbrewer:Dark2",
                    }
                ]
            ),
        ),
        answer="Die Buslinien sind nun nach ihrer Linienklasse eingefärbt.",
    ),
    "map-20": Answer(
        lambda api: api.edit(31, _symbol("fill", color="#f3f8fc", opacity=0.5)),
        undo=_restore_style(31),
    ),
    "map-21": Answer(
        lambda api: api.new_style(
            35,
            "Turnout change",
            _symbol(
                "marker",
                color={"field": "turnout_change", "palette": "colorbrewer:RdBu"},
            ),
        ),
        calls=[_new_style_call("Turnout change", "Save a new style")],
        undo=_drop_created(35),
    ),
    "map-22": Answer(_hide_but_cycling),
    "map-23": Answer(
        lambda api: api.put_layer(
            33,
            query={
                "cql": {"op": ">=", "args": [{"property": "frequency_per_hour"}, 6]}
            },
        )
    ),
    "map-24": Answer(_leave_out_residential),
    "map-25": Answer(
        after_card=lambda api: api.remove_layer(39),
        calls=[
            ToolCall(
                "map_update",
                {"operations": [{"op": "remove_layer", "layer_project_id": 39}]},
                {
                    "project_id": MAP_PROJECT_ID,
                    "applied": [],
                    "confirm": [
                        {
                            "layer_project_id": 39,
                            "name": "Old boundaries",
                            "value": "remove_layer:39",
                            "facts": "The layer has 1 style and no filter.",
                        }
                    ],
                },
                False,
            ),
            ToolCall(
                "ask_user",
                {
                    "questions": [
                        {
                            "question": "Remove the layer Old boundaries? A dashboard, a "
                            "workflow and a print layout use it.",
                            "header": "Remove",
                            "options": [
                                {
                                    "label": "Keep it",
                                    "value": "keep",
                                    "recommended": True,
                                },
                                {"label": "Remove it", "value": "remove_layer:39"},
                            ],
                        }
                    ]
                },
                {"card_id": "ask-1"},
                False,
            ),
        ],
    ),
    "map-26": Answer(
        lambda api: api.layer_state(39, visible=False),
        answer="I hid Old boundaries; it stays in the project.",
    ),
    "map-27": Answer(_public_transport),
    "map-28": Answer(lambda api: api.project(basemap="dark")),
    "map-29": Answer(
        calls=[
            _map_update(
                [{"op": "set_view", "mode": "3d", "pitch": 55}],
                {"camera": {"pitch": 55}, "mode": "3d"},
            )
        ]
    ),
    "map-30": Answer(_on_top_renamed),
    "map-31": Answer(_hide_land_use_light, undo=_undo_land_use_light),
    "map-32": Answer(
        answer="You may only view this project, so I cannot change the color of the "
        "districts. Someone who can edit it can make them red."
    ),
    "map-33": Answer(
        _half_transparent_result,
        calls=[*_BUILT_AND_RUN, _call("style_update")],
        saved=[CATCHMENT_WORKFLOW],
        answer="The catchments are on the map, half transparent with a thin dark "
        "outline.",
    ),
    "map-34": Answer(
        _run_saved,
        calls=list(_BUILT_AND_RUN),
        saved=[CATCHMENT_WORKFLOW],
        answer="The areas on the map reach a station within 10 minutes on foot.",
    ),
    "map-35": Answer(
        lambda api: api.edit(
            32,
            _set(render={"type": "heatmap", "radius": 30, "palette": "d3:magma"}),
        )
    ),
    "map-36": Answer(
        lambda api: api.edit(
            40,
            _symbol("marker", size=18, icon="goat:rail", icon_color="#ffffff"),
        ),
        calls=[_call("style_catalog"), _call("style_update")],
        answer="The stations show a train icon on a circle now.",
    ),
    # The breaks of the 39 features the saved filter keeps (statistics as
    # drawn), rounded, as manual classes: a computed method would class all
    # 300 features.
    "map-37": Answer(
        lambda api: api.edit(
            34,
            _set(
                classify=[
                    {
                        "field": "area_m2",
                        "method": "manual",
                        "palette": "colorbrewer:Blues",
                        "classes": [
                            {"to": 15000, "fill": {"color": "#eff3ff"}},
                            {"from": 15000, "to": 22000, "fill": {"color": "#bdd7e7"}},
                            {"from": 22000, "to": 28000, "fill": {"color": "#6baed6"}},
                            {"from": 28000, "to": 37000, "fill": {"color": "#3182bd"}},
                            {"from": 37000, "fill": {"color": "#08519c"}},
                        ],
                    }
                ]
            ),
        ),
        calls=[
            ToolCall(
                "project_field_statistics",
                {
                    "layer_project_id": 34,
                    "field": "area_m2",
                    "breaks": 4,
                    "as_drawn": True,
                },
                {"count": 39, "breaks": [15589.4, 22135.4, 28220.2, 36960.1]},
                False,
            ),
            _call("style_get"),
            _call("style_update"),
        ],
        answer=(
            "The land use is colored by area in five blue classes; the classes "
            "follow the 39 features the layer's filter keeps."
        ),
    ),
    "map-38": Answer(
        _with_area(32, _region_pieces("DEZ01")),
        calls=[
            _call(
                "catalog_find_region",
                {"regions": [{"nuts_id": "DEZ01", "name": "Auental", "level": 3}]},
            ),
            _call("map_update"),
        ],
        answer="The points of interest now show only those in Auental.",
    ),
    "map-39": Answer(
        _with_area(40, _district_pieces(4, 9)),
        calls=[_call("map_update")],
        answer="The stations now show only those in District 4 and District 9.",
    ),
    "map-40": Answer(
        _with_area(36, _view_pieces((12.36, 51.32, 12.44, 51.38))),
        calls=[_call("map_update")],
        answer="The buildings are filtered to the map view you see now.",
    ),
    "map-41": Answer(
        _without_area,
        calls=[_call("map_update")],
        answer="The land use has no area limit now; its other conditions stay.",
    ),
    "map-42": Answer(
        lambda api: api.edit(40, _symbol("label", text="{name}", min_zoom=13)),
        calls=[_call("skills_load"), _call("style_get"), _call("style_update")],
        answer="The stations now show their names from zoom 13, so the labels "
        "do not crowd the map when you zoom out.",
    ),
    "map-43": Answer(
        lambda api: api.edit(
            33,
            lambda d: (
                _symbol("line", width={"field": "frequency_per_hour", "range": [1, 6]})(
                    d
                ),
                _symbol("casing", color="#ffffff", width=1)(d),
            ),
        ),
        calls=[_call("skills_load"), _call("style_get"), _call("style_update")],
        answer="Die Buslinien sind jetzt umso breiter, je öfter sie fahren, und "
        "haben einen weißen Rand.",
    ),
    "map-44": Answer(
        lambda api: api.edit(
            32,
            _set(
                classify=[
                    {
                        "field": "category",
                        "method": "categories",
                        "count": 5,
                        "palette": "colorbrewer:Dark2",
                        "other": {"name": "Other", "marker": {"color": "#9aa3ad"}},
                    }
                ]
            ),
        ),
        calls=[
            _call("skills_load"),
            _call("project_field_statistics"),
            _call("style_update"),
        ],
        answer="The points of interest are colored by their five most common "
        "categories, the rest in grey.",
    ),
    "map-45": Answer(
        answer="I cannot draw a shape on the map. You can draw it yourself in "
        "the layer's Filter tab, under Area."
    ),
    "map-46": Answer(
        lambda api: api.edit(
            32,
            _set(
                popup={
                    "mode": "html",
                    "html": "<h3>{{ name }}</h3>{% if opening_year %}"
                    "<p>Opened in {{ opening_year }}</p>{% endif %}",
                }
            ),
        ),
        calls=[
            ToolCall("skills_load", {"name": "style-a-map"}, {}, False),
            ToolCall(
                "skills_load", {"name": "style-a-map", "file": "popups.md"}, {}, False
            ),
            _call("project_get_fields"),
            _call("style_update"),
        ],
        answer="The popup of the points of interest shows the name as a heading "
        "and the opening year where it is known.",
    ),
    # The five most frequent kinds with an icon each; the base marker's icon
    # is what the other kinds draw.
    "map-47": Answer(
        lambda api: api.edit(
            32,
            lambda d: (
                _symbol("marker", size=18, icon="goat:marker")(d),
                d.update(classify=copy.deepcopy(_ICON_CLASSES)),
            ),
        ),
        calls=[
            _call("project_field_statistics"),
            ToolCall(
                "style_catalog",
                {
                    "kind": "icons",
                    "queries": ["restaurant", "cafe", "shop", "bus", "pharmacy"],
                },
                {},
                False,
            ),
            _call("style_update"),
        ],
        answer="The five most common kinds have their own icon on a colored "
        "circle; all other kinds show a grey marker icon.",
    ),
}


def applied(task: EvalTask, answer: Answer) -> Transcript:
    """The transcript of a run that wrote what ``answer`` writes, with the
    snapshots the harness takes."""
    states, state = map_states(task)
    assert state is not None
    api = Api(state, str(task.context["project_id"]))
    before = state.snapshot()
    answer.run(api)
    before_answer = None
    if answer.after_card is not None:
        before_answer = state.snapshot()
        answer.after_card(api)
    after = state.snapshot()
    undone = None
    if answer.undo is not None:
        answer.undo(api, before)
        undone = state.snapshot()
    return Transcript(
        task_id=task.id,
        answer=answer.answer,
        tool_calls=answer.calls,
        proposals=[],
        requests={},
        error=None,
        input_tokens=0,
        output_tokens=0,
        seconds=0.0,
        first_text_seconds=None,
        saved=answer.saved,
        undo="undone" if task.undo else None,
        map_before=before,
        map_before_answer=before_answer,
        map_after=after,
        map_undone=undone,
    )
