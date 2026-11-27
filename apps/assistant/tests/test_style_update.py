"""style_update changes a layer's style or creates a named one: the operations
are applied in process, the result is checked by core before anything is
written, and every landed write leaves its undo record. Core, geoapi and
processes are the eval stand-ins of the map project, which answer as the
services do."""

import copy
import dataclasses
import itertools
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import ToolReturnPart

from assistant.agent import RunDeps, build_agent
from assistant.asks import AskHistory, AskUserInput, CardAnswer, QuestionAnswer
from assistant.context import parse_context
from assistant.styles.edits import (
    MAX_CHANGED,
    MODES,
    StyleUpdated,
    StyleUpdateInput,
    refusal,
    touched_classifications,
)
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.runtime import Creates, InputInvalid, ToolEnv, Undoes, execute
from assistant.tools.styles import (
    ASKED_NOT_SAID,
    CREATED_SAVE_UNKNOWN,
    MORE_CHANGES,
    NO_DATASET_DEFAULT,
    NOT_CHECKED_NOW,
    NOT_SAVED_NOW,
    NOTHING_CHANGED,
    REPEATED_STYLE_EDIT,
    SAVE_UNKNOWN,
    SKILL_BEFORE_NEXT,
    STYLE_TOOLS,
    THIRD_CHANGE,
    TOO_LARGE,
    UPDATE_STYLE,
    VIEWER_STYLES,
)
from assistant.tools.testing import Recorder, ScriptedModel, fake_clients, tool_env
from assistant.tools.toolset import earlier_writes
from evals.map_backends import MapState, map_core
from evals.map_fixture import MAP_PROJECT_ID, MAP_VIEW_PROJECT_ID, map_layer
from tests.test_style_get import (
    _all_categories,
    _geoapi,
    _processes,
    _Proxy,
    _quantile_districts,
    _save,
)

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
PAGE = {"surface": "project.map", "project_id": MAP_PROJECT_ID}
RED = {"op": "set", "path": "/symbol/fill/color", "value": "#ff0000"}
QUANTILES = {
    "op": "add",
    "path": "/classify",
    "item": {
        "field": "density",
        "method": "quantile",
        "count": 5,
        "palette": "colorbrewer:OrRd",
    },
}
POINTS = {
    "version": "1.0.0",
    "kind": "vector",
    "symbol": {"marker": {"shape": "square", "color": "#123456", "size": 8}},
}


class _Services:
    def __init__(
        self,
        state: MapState,
        *,
        core: Any = None,
        processes: Recorder | None = None,
        page: dict[str, Any] | None = None,
        asks: AskHistory | None = None,
    ) -> None:
        self.state = state
        self.core = core if core is not None else map_core(state)
        self.processes = processes if processes is not None else _processes()
        self.geoapi = _geoapi()
        self.env: ToolEnv = tool_env(
            fake_clients(core=self.core, geoapi=self.geoapi, processes=self.processes),
            page=parse_context(page or PAGE),
        )
        if asks is not None:
            self.env.asks = asks

    def calls(self) -> list[tuple[str, str]]:
        """Core's requests about styles and map state, as (method, path
        after the layer's)."""
        found = []
        for request in self.core.requests:
            path = request.url.path
            if "/style" in path or path.endswith("/map-state"):
                rest = path.split("/layer/", 1)[1].split("/", 1)[1]
                if request.url.params.get("check"):
                    rest += "?check=true"
                found.append((request.method, rest))
        return found

    def writes(self) -> list[httpx.Request]:
        return [
            r
            for r in self.core.requests
            if r.method != "GET" and not r.url.path.endswith("/check")
        ]

    def body(self, method: str, ending: str) -> Any:
        [request] = [
            r
            for r in self.core.requests
            if r.method == method and r.url.path.endswith(ending)
        ]
        return json.loads(request.content)


async def _update(services: _Services, **args: Any) -> dict[str, Any]:
    result: dict[str, Any] = await execute(UPDATE_STYLE, services.env, args)
    return result


async def _run(services: _Services, **args: Any) -> StyleUpdated:
    result = await UPDATE_STYLE.run(services.env, StyleUpdateInput.model_validate(args))
    assert isinstance(result, StyleUpdated)
    return result


def _document(state: MapState, style_id: str) -> dict[str, Any]:
    return copy.deepcopy(state.styles[style_id].document)


def _picked(*values: str) -> AskHistory:
    """A history in which the user picked an option with each value."""
    cards: dict[str, AskUserInput] = {}
    answers: dict[str, CardAnswer] = {}
    for n, value in enumerate(values):
        card_id = f"ask-c{n}"
        cards[card_id] = AskUserInput.model_validate(
            {
                "questions": [
                    {
                        "question": "Which style should be replaced?",
                        "header": "Style",
                        "options": [
                            {"label": "Replace it", "value": value},
                            {"label": "Keep all styles"},
                        ],
                    }
                ]
            }
        )
        answers[card_id] = CardAnswer(
            card_id=card_id, answers=[QuestionAnswer(question=0, options=[0])]
        )
    return AskHistory(cards=cards, answers=answers)


def _answering(
    state: MapState,
    change: Callable[[httpx.Request, httpx.Response], httpx.Response | None],
    *,
    read_only: bool = False,
) -> _Proxy:
    """The stand-in core, with ``change`` deciding what a request is answered
    with: None keeps core's own answer."""
    core = map_core(state, read_only=read_only)

    def handler(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None, request.url.path
        changed = change(request, response)
        return response if changed is None else changed

    return _Proxy(handler)


def _failing(
    state: MapState, method: str, ending: str, status: int, code: str
) -> _Proxy:
    """The stand-in core, but one route answers an error without doing
    anything."""
    core = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == method and request.url.path.endswith(ending):
            return httpx.Response(status, json={"detail": {"code": code}})
        response = core.answer(request)
        assert response is not None, request.url.path
        return response

    return _Proxy(handler)


# ---- the input -------------------------------------------------------------------

_STYLE = "5f000000-0000-4000-8000-000000000001"
_GIVEN: dict[str, list[Any]] = {
    "style_id": [None, _STYLE],
    "new_style": [
        None,
        {"name": "B", "asked": "as a new style"},
        {"name": "B", "asked": "as a new style", "start": "current"},
    ],
    "operations": [None, [RED]],
    "document": [None, POINTS],
}


def test_exactly_one_of_the_four_ways_is_a_call() -> None:
    """Of every combination of what a call can give, only the contract's
    four are read; any other names the four."""
    accepted = []
    for values in itertools.product(*_GIVEN.values()):
        args = {k: v for k, v in zip(_GIVEN, values, strict=True) if v is not None}
        try:
            parsed = StyleUpdateInput.model_validate({"layer_project_id": 31, **args})
        except ValidationError as error:
            assert MODES in str(error), args
            continue
        accepted.append((parsed.mode(), tuple(sorted(args))))
    assert sorted(accepted) == [
        ("edit", ("operations",)),
        ("edit", ("operations", "style_id")),
        ("new_from", ("new_style",)),
        ("new_from", ("new_style", "operations")),
        ("new_whole", ("document", "new_style")),
        ("replace", ("document", "style_id")),
    ]
    by_mode = dict(accepted)
    assert by_mode["new_from"] and by_mode["new_whole"]
    # A new style built on a starting point takes operations or none, never
    # a document; a whole one takes no operations.
    for bad in (
        {
            "new_style": {"name": "B", "asked": "as a new style", "start": "empty"},
            "document": POINTS,
        },
        {"new_style": {"name": "B", "asked": "as a new style"}, "operations": [RED]},
    ):
        with pytest.raises(ValidationError, match="four ways"):
            StyleUpdateInput.model_validate({"layer_project_id": 31, **bad})


def test_the_input_is_shaped_for_a_model() -> None:
    def parse(**args: Any) -> StyleUpdateInput:
        return StyleUpdateInput.model_validate({"layer_project_id": 31, **args})

    # A document sent as JSON text, also encoded twice, is the object.
    for text in (json.dumps(POINTS), json.dumps(json.dumps(POINTS))):
        assert (
            parse(
                new_style={"name": "B", "asked": "as a new style"}, document=text
            ).document
            == POINTS
        )
    # name renames a replaced style, and nothing else.
    assert parse(style_id=_STYLE, document=POINTS, name="New").name == "New"
    with pytest.raises(ValidationError, match="name"):
        parse(operations=[RED], name="New")
    # A style id is a UUID, kept in its canonical form.
    assert parse(operations=[RED], style_id=_STYLE.upper()).style_id == _STYLE
    with pytest.raises(ValidationError, match="project_get_layers"):
        parse(operations=[RED], style_id="active")
    for bad in (
        {"operations": []},
        {"operations": [RED] * 31},
        {"new_style": {"name": "", "asked": "as a new style"}, "document": POINTS},
        {
            "new_style": {"name": "x", "asked": "as a new style" * 121},
            "document": POINTS,
        },
        {
            "new_style": {"name": "B", "asked": "as a new style", "start": "copy"},
            "operations": [RED],
        },
        {"operations": [RED], "project_id": MAP_PROJECT_ID},
    ):
        with pytest.raises(ValidationError):
            parse(**bad)


def test_the_schema_reaches_the_model_with_the_edit_operations() -> None:
    schema = UPDATE_STYLE.json_schema()
    assert set(schema["properties"]) == {
        "layer_project_id",
        "style_id",
        "new_style",
        "operations",
        "document",
        "name",
        "make_active",
    }
    assert schema["required"] == ["layer_project_id"]
    for name, sub in schema["properties"].items():
        assert sub.get("description"), name
    edit = schema["$defs"]["Edit"]
    assert edit["properties"]["op"]["enum"] == [
        "set",
        "remove",
        "retarget",
        "use_field",
        "round",
        "add",
        "move",
    ]
    for name, sub in schema["$defs"]["NewStyle"]["properties"].items():
        assert sub.get("description"), name
    text = json.dumps(schema) + UPDATE_STYLE.description
    assert "—" not in text and "–" not in text
    described = UPDATE_STYLE.description
    for said in ("method and count", "legend numbers", "new_style", "from 0"):
        assert said in described, said


# ---- an edit in place ------------------------------------------------------------


async def test_an_edit_reads_applies_checks_and_saves_on_the_read_revision() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    for opacity in (0.5, 0.6, 0.7):
        document = _document(state, style_id)
        document["opacity"] = opacity
        _save(state, 31, document)
    services = _Services(state)
    result = await _update(services, layer_project_id=31, operations=[RED])
    assert services.calls() == [
        ("GET", f"style/{style_id}?check=true"),
        ("POST", f"style/{style_id}/check"),
        ("PUT", f"style/{style_id}"),
    ]
    checked = services.body("POST", "/check")["document"]
    assert checked["symbol"]["fill"]["color"] == "#ff0000"
    saved = services.body("PUT", f"/style/{style_id}")
    assert saved["base_rev"] == 4 and saved["document"] == checked
    assert (result["revision_before"], result["revision_after"]) == (4, 5)
    assert state.styles[style_id].revision == 5
    assert state.styles[style_id].document["symbol"]["fill"]["color"] == "#ff0000"
    assert result["project_id"] == MAP_PROJECT_ID
    assert (result["layer_project_id"], result["style_id"]) == (31, style_id)
    assert (result["name"], result["active"]) == ("Default", True)
    assert "created" not in result or result["created"] is False
    assert result.get("made_active", False) is False


async def test_the_result_names_changed_paths_and_added_ids_and_never_the_document() -> (
    None
):
    state = MapState()
    services = _Services(state)
    result = await _update(services, layer_project_id=31, operations=[RED, QUANTILES])
    assert result["changed"] == ["/symbol/fill/color", "/classify"]
    # Indexes count from 0: the second operation added the classification.
    assert result["added"] == {"1": "density"}
    assert "document" not in result and "before" not in result
    text = json.dumps(result)
    assert "computed" not in text and '"symbol"' not in text
    assert set(result) <= {
        "project_id",
        "layer_project_id",
        "style_id",
        "name",
        "created",
        "active",
        "made_active",
        "renamed",
        "revision_before",
        "revision_after",
        "changed",
        "added",
        "issues",
        "not_saved",
        "legend",
        "legend_note",
        "note",
    }


async def test_the_result_of_an_edit_on_the_largest_style_stays_small() -> None:
    state = MapState()
    _all_categories(state)
    services = _Services(state)
    result = await _update(
        services,
        layer_project_id=32,
        operations=[
            {
                "op": "set",
                "path": f"/classify/category/classes/c{n}/marker/color",
                "value": "#000000",
            }
            for n in range(1, 31)
        ],
    )
    assert result["revision_after"] == result["revision_before"] + 1
    assert len(result["changed"]) == 30
    assert len(json.dumps(result, separators=(",", ":")).encode()) < 8_000
    [legend] = result["legend"]
    assert len(legend["classes"]) == 12 and legend["more"] == 28


def test_changed_paths_are_cut_at_fifty_with_a_note() -> None:
    from assistant.styles.edits import changed_pointers, shown_changes

    before = {"version": "1.0.0", "kind": "vector", "ext": {}}
    after = {**before, "ext": {f"k{n}": n for n in range(60)}}
    pointers = changed_pointers(before, after)
    assert len(pointers) == 60
    shown, note = shown_changes(pointers)
    assert shown == pointers[:MAX_CHANGED] and len(shown) == 50
    assert note == "changed lists the first 50 of 60 changed paths."
    assert shown_changes(pointers[:50]) == (pointers[:50], None)


async def test_an_edit_that_adds_an_error_is_not_saved_and_the_failure_names_path_message_allowed_and_fix() -> (
    None
):
    state = MapState()
    services = _Services(state)
    before = state.snapshot()
    with pytest.raises(ToolFailed) as raised:
        await _update(
            services,
            layer_project_id=31,
            operations=[
                {"op": "set", "path": "/symbol/label/text", "value": "{{ name }}"},
                {"op": "set", "path": "/opacity", "value": 0.4},
            ],
        )
    assert raised.value.message == (
        "Not saved: 1 issue(s) this edit adds must be fixed first. "
        "/symbol/label/text: Labels use {field}, not {{ field }}. "
        'Fix: set /symbol/label/text "{name}". '
        "Change the operations and call style_update again."
    )
    assert services.writes() == [] and state.snapshot() == before
    assert [method for method, _ in services.calls()] == ["GET", "POST"]


@pytest.mark.parametrize(
    ("value", "line"),
    [
        (
            {"blocks": [{"id": "b1", "type": "text", "text": "Lines: {lines}"}]},
            '/popup/blocks/b1/text: "text" is not a key here. '
            "Keys here: id, type, html.",
        ),
        (
            {"title": "Station"},
            '/popup/title: "title" is not a key here. Keys here: enabled, trigger, '
            "mode, blocks, html, layout, anchor, width, max_height, header, "
            "highlight_active_feature.",
        ),
        (5, "/popup: Input should be an object or false."),
    ],
)
async def test_a_refused_popup_names_the_keys_of_its_place_and_only_the_form_it_has(
    value: Any, line: str
) -> None:
    services = _Services(MapState())
    with pytest.raises(ToolFailed) as raised:
        await _update(
            services,
            layer_project_id=40,
            operations=[{"op": "set", "path": "/popup", "value": value}],
        )
    assert raised.value.message == (
        f"Not saved: 1 issue(s) this edit adds must be fixed first. {line} "
        "Change the operations and call style_update again."
    )
    assert services.writes() == []


def test_a_refusal_lists_five_issues_with_their_allowed_values_and_fixes() -> None:
    issues: list[dict[str, Any]] = [
        {
            "level": "error",
            "code": "invalid_value",
            "path": "/render/service_style",
            "message": "The service does not offer this style.",
            "allowed": ["default", "night", 3],
        },
        {
            "level": "error",
            "code": "overlap",
            "path": "/classify/a",
            "message": "Two classifications fill the same property",
            "fix": {"op": "retarget", "path": "/classify/a", "target": "outline.color"},
        },
        {
            "level": "error",
            "code": "unknown_field",
            "path": "/classify/k/field",
            "message": 'The dataset has no field "landuse".',
            "fix": {"op": "use_field", "path": "/classify/k/field", "field": "use"},
        },
        {
            "level": "error",
            "code": "zoom_not_whole",
            "path": "/rules/r1/min_zoom",
            "message": "A zoom is a whole number.",
            "fix": {"op": "round", "path": "/rules/r1/min_zoom"},
        },
        {
            "level": "error",
            "code": "invalid_value",
            "path": "/opacity",
            "message": "Input should be less than or equal to 1",
            "fix": {"op": "set", "path": "/opacity", "value": 1},
        },
        {"level": "error", "code": "x", "path": "/sixth", "message": "Left out."},
    ]
    assert refusal(issues, "operations") == (
        "Not saved: 6 issue(s) this edit adds must be fixed first. "
        "/render/service_style: The service does not offer this style. "
        "Allowed: default, night, 3. "
        "/classify/a: Two classifications fill the same property. "
        "Fix: retarget /classify/a outline.color. "
        '/classify/k/field: The dataset has no field "landuse". '
        "Fix: use_field /classify/k/field use. "
        "/rules/r1/min_zoom: A zoom is a whole number. "
        "Fix: round /rules/r1/min_zoom. "
        "/opacity: Input should be less than or equal to 1. "
        "Fix: set /opacity 1. "
        "Change the operations and call style_update again."
    )
    assert refusal(issues[:1], "document").endswith(
        "Change the document and call style_update again."
    )
    assert "—" not in refusal(issues, "operations")


async def test_an_error_the_style_already_had_does_not_stop_an_edit() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    # The stored style reads a field the data does not have.
    state.styles[style_id].document["symbol"]["label"]["text"] = "{inhabitants}"
    services = _Services(state)
    result = await _update(
        services,
        layer_project_id=31,
        operations=[{"op": "set", "path": "/opacity", "value": 0.4}],
    )
    assert result["revision_after"] == 2
    assert state.styles[style_id].document["opacity"] == 0.4
    [issue] = [i for i in result["issues"] if i["code"] == "unknown_field"]
    assert issue["path"] == "/symbol/label/text" and issue["existing"] is True
    assert result.get("not_saved", []) == []
    # A second error of another kind is new, and refused.
    with pytest.raises(ToolFailed, match=r"Not saved: 1 issue\(s\)"):
        await _update(
            services,
            layer_project_id=31,
            operations=[{"op": "set", "path": "/opacity", "value": 7}],
        )


async def test_an_operation_that_cannot_be_applied_is_input_invalid_and_names_its_number() -> (
    None
):
    state = MapState()
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            layer_project_id=31,
            operations=[RED, {"op": "remove", "path": "/classify/density"}],
        )
    assert raised.value.message.startswith("Operation 2: /classify has no items yet")
    assert [method for method, _ in services.calls()] == ["GET"]
    assert services.writes() == []


async def test_a_class_of_a_classification_the_server_computes_is_not_there_yet() -> (
    None
):
    """A classification set in the same call has no classes before the save:
    the refusal says where a part for every class goes and that one class is
    set in a later call, not to add class items the server would replace."""
    state = MapState()
    services = _Services(state)
    classify = {
        "op": "set",
        "path": "/classify",
        "value": [{"field": "density", "method": "quantile", "count": 5}],
    }
    outline = {
        "op": "set",
        "path": "/classify/density/classes/c1/outline/color",
        "value": "auto",
    }
    with pytest.raises(InputInvalid) as raised:
        await _update(services, layer_project_id=31, operations=[classify, outline])
    message = raised.value.message
    assert message.startswith("Operation 2: /classify/density/classes has no items")
    assert "add one with the add operation" not in message
    assert "/symbol/outline" in message and "later call" in message
    assert services.writes() == []


async def test_a_class_added_to_a_classification_the_server_rebuilds_is_said_lost() -> (
    None
):
    """A class item added to a classification the server computes, as many
    classes as its count, is rebuilt away on the save: the result names no id
    for it and says that what it held was not saved."""
    state = MapState()
    services = _Services(state)
    classify = {
        "op": "set",
        "path": "/classify",
        "value": [{"field": "density", "method": "quantile", "count": 5}],
    }
    add = {
        "op": "add",
        "path": "/classify/density/classes",
        "item": {"outline": {"color": "auto"}},
    }
    result = await _run(services, layer_project_id=31, operations=[classify, add])
    assert result.revision_after == 2
    assert result.added == {}
    assert result.note is not None and "/classify/density/classes" in result.note
    assert "not saved" in result.note and "/symbol/outline" in result.note
    # Class records written inside the classification are rebuilt the same way.
    inline = copy.deepcopy(classify)
    inline["value"][0]["classes"] = [{"outline": {"color": "auto"}}]
    again = await _run(services, layer_project_id=31, operations=[inline])
    assert again.note is not None and "not saved" in again.note
    # The classes of a computed classification that came back as written say nothing.
    width = {"op": "set", "path": "/symbol/outline/width", "value": 0.5}
    quiet = await _run(services, layer_project_id=31, operations=[width])
    assert "not saved" not in (quiet.note or "")
    # Another count rebuilds the classes as asked: no class was written.
    for count in (7, 3):
        recount = {"op": "set", "path": "/classify/density/count", "value": count}
        counted = await _run(services, layer_project_id=31, operations=[recount])
        assert counted.revision_after > counted.revision_before
        assert "not kept" not in (counted.note or ""), counted.note
    # A classification added with its classes inside is rebuilt the same way.
    added_inline = {
        "op": "add",
        "path": "/classify",
        "item": {
            "field": "population",
            "target": "outline.width",
            "method": "quantile",
            "count": 3,
            "range": [0.5, 3],
            "classes": [{"name": "Few"}],
        },
    }
    lost_add = await _run(services, layer_project_id=31, operations=[added_inline])
    assert lost_add.note is not None and "not kept" in lost_add.note, lost_add.note
    # A rule added and removed again in the same call is no lost class.
    rule_item = {
        "when": {"op": "isNull", "args": [{"property": "name"}]},
        "fill": {"color": "#cfcfcf"},
    }
    gone = await _run(
        services,
        layer_project_id=31,
        operations=[
            {"op": "add", "path": "/rules", "item": rule_item},
            {"op": "remove", "path": "/rules/r1"},
            width,
        ],
    )
    assert "not kept" not in (gone.note or ""), gone.note
    # An item that lands keeps its id in the result.
    rule = {
        "op": "add",
        "path": "/rules",
        "item": {
            "when": {"op": "isNull", "args": [{"property": "name"}]},
            "fill": {"color": "#cfcfcf"},
        },
    }
    kept = await _run(services, layer_project_id=31, operations=[rule])
    assert kept.added == {"0": "r1"} and "not saved" not in (kept.note or "")


OUTLINE_KEY = "set one of its keys, for example /symbol/outline/color"


async def test_a_part_switched_off_says_so_and_a_key_set_under_it_switches_it_on() -> (
    None
):
    """Setting a part to false switches it off: the result states it and names
    a key that draws it again, without asking for it. Setting it to false again
    changes nothing, and the note names the operation and the value the path
    holds. A key set under the switched-off part switches it on, and says so."""
    state = MapState()
    services = _Services(state)
    off = {"op": "set", "path": "/symbol/outline", "value": False}
    first = await _run(services, layer_project_id=31, operations=[off, off])
    assert first.revision_after == 2
    assert first.note == (
        "/symbol/outline is now switched off (false). To draw it again, "
        f"{OUTLINE_KEY}."
    )
    again = await _run(services, layer_project_id=31, operations=[off])
    assert again.note is not None and again.note.startswith(NOTHING_CHANGED)
    assert (
        "Operation 1 sets /symbol/outline to false, the value it holds: the part "
        f"is switched off; to draw it, {OUTLINE_KEY}."
    ) in again.note
    color = {"op": "set", "path": "/symbol/outline/color", "value": "auto"}
    on = await _run(services, layer_project_id=31, operations=[color])
    assert on.revision_after == 3
    assert on.note == (
        "/symbol/outline was switched off (false); operation 1 switched it on by "
        "setting /symbol/outline/color."
    )
    style = state.styles[state.active_style_id(31)].document
    assert style["symbol"]["outline"] == {"color": "auto"}
    # Setting a part to {} resets it to its defaults, and the note says so.
    reset = {"op": "set", "path": "/symbol/outline", "value": {}}
    cleared = await _run(services, layer_project_id=31, operations=[reset])
    assert cleared.note is not None
    assert "resets it to its defaults" in cleared.note and OUTLINE_KEY in cleared.note
    # A value equal to the stored one that is no part is named as well.
    same = {"op": "set", "path": "/symbol/fill/color", "value": "#deebf7"}
    plain = await _run(services, layer_project_id=31, operations=[same])
    note = plain.note or ""
    assert (
        'Operation 1 sets /symbol/fill/color to "#deebf7", the value it holds' in note
    )
    assert "switched off" not in note


async def test_a_part_switched_on_in_a_rule_stays_off_while_the_symbol_holds_false() -> (
    None
):
    """A key set under a rule's part that holds false switches the rule's part
    on, and the note says so. While the layer's own part is false the part
    draws nowhere, and the note says that too; with the layer's part on, it
    does not."""
    state = MapState()
    services = _Services(state)
    rule = {
        "op": "add",
        "path": "/rules",
        "item": {
            "when": {"op": "isNull", "args": [{"property": "name"}]},
            "outline": False,
        },
    }
    off = {"op": "set", "path": "/symbol/outline", "value": False}
    made = await _run(services, layer_project_id=31, operations=[off, rule])
    assert made.added == {"1": "r1"}, made.note
    color = {"op": "set", "path": "/rules/r1/outline/color", "value": "auto"}
    on = await _run(services, layer_project_id=31, operations=[color])
    assert on.note == (
        "/rules/r1/outline was switched off (false); operation 1 switched it on by "
        "setting /rules/r1/outline/color; it stays off while /symbol/outline is "
        "false."
    )
    # The same call switching the layer's outline on as well: no such clause.
    rule_off = {"op": "set", "path": "/rules/r1/outline", "value": False}
    await _run(services, layer_project_id=31, operations=[rule_off])
    base_on = {"op": "set", "path": "/symbol/outline/color", "value": "auto"}
    both = await _run(services, layer_project_id=31, operations=[base_on, color])
    assert both.note is not None
    assert (
        "/rules/r1/outline was switched off (false); operation 2 switched it on by "
        "setting /rules/r1/outline/color."
    ) in both.note
    assert "stays off" not in both.note
    # With the layer's own outline on, the rule's outline draws: no such clause.
    await _run(services, layer_project_id=31, operations=[rule_off])
    again = await _run(services, layer_project_id=31, operations=[color])
    assert again.note is not None and again.note.endswith(
        "/rules/r1/outline was switched off (false); operation 1 switched it on by "
        "setting /rules/r1/outline/color."
    )


def test_a_cluster_symbol_part_switched_on_does_not_stay_off_with_the_layer_part() -> (
    None
):
    """The cluster symbol is a symbol of its own: its part switched on draws
    while the layer's own part is false, so the note has no clause about it."""
    from goatlib.style.edit import Edit

    from assistant.styles.edits import operation_notes

    base = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"marker": {"color": "#3969ac"}, "outline": False},
        "render": {"type": "cluster", "symbol": {"outline": False}},
    }
    edited = copy.deepcopy(base)
    edited["render"]["symbol"]["outline"] = {"color": "auto"}
    color = Edit(op="set", path="/render/symbol/outline/color", value="auto")
    assert operation_notes(base, edited, [color]) == [
        "/render/symbol/outline was switched off (false); operation 1 switched it on "
        "by setting /render/symbol/outline/color."
    ]


def test_a_key_set_under_an_absent_hexagon_outline_switches_the_outline_on() -> None:
    """Hexagons draw no outline while `render.outline` is absent; setting one of
    its keys creates the outline, which then draws with defaults for the rest."""
    from goatlib.style.edit import Edit

    from assistant.styles.edits import edited

    base = {"version": "1.0.0", "kind": "vector", "render": {"type": "h3"}}
    width = Edit(op="set", path="/render/outline/width", value=2)
    assert edited(base, [width]).document["render"] == {
        "type": "h3",
        "outline": {"width": 2},
    }
    color = Edit(op="set", path="/render/outline/color", value="auto")
    assert edited(base, [color]).document["render"]["outline"] == {"color": "auto"}
    assert base["render"] == {"type": "h3"}


async def test_a_part_switched_on_in_a_class_stays_off_while_the_symbol_holds_false() -> (
    None
):
    """As in a rule: a class record's part switched on by a key set under it
    stays off while the layer's own part is false, and the note says so."""
    state = MapState()
    services = _Services(state)
    classes = {
        "op": "set",
        "path": "/classify",
        "value": [{"field": "density", "method": "quantile", "count": 5}],
    }
    off = {"op": "set", "path": "/symbol/outline", "value": False}
    class_off = {
        "op": "set",
        "path": "/classify/density/classes/c1/outline",
        "value": False,
    }
    await _run(services, layer_project_id=31, operations=[classes, off])
    await _run(services, layer_project_id=31, operations=[class_off])
    color = {
        "op": "set",
        "path": "/classify/density/classes/c1/outline/color",
        "value": "auto",
    }
    on = await _run(services, layer_project_id=31, operations=[color])
    assert on.note is not None
    assert (
        "/classify/density/classes/c1/outline was switched off (false); operation 1 "
        "switched it on by setting /classify/density/classes/c1/outline/color; it "
        "stays off while /symbol/outline is false."
    ) in on.note


def test_a_repeated_style_change_says_to_change_the_call() -> None:
    from assistant.tools.styles import REPEATED_STYLE_EDIT

    assert REPEATED_STYLE_EDIT.startswith("You made this style change earlier")
    assert "Sending it again changes nothing" in REPEATED_STYLE_EDIT
    assert "note" in REPEATED_STYLE_EDIT


async def test_nothing_changed_has_no_undo_record() -> None:
    state = MapState()
    services = _Services(state)
    same = {"op": "set", "path": "/symbol/fill/color", "value": "#deebf7"}
    result = await _run(services, layer_project_id=31, operations=[same])
    assert result.revision_before == result.revision_after == 1
    assert result.note is not None and result.note.startswith(NOTHING_CHANGED)
    assert result.changed == []
    assert result.undo() is None
    assert services.processes.requests == []


async def test_core_kept_a_path_at_its_stored_value() -> None:
    """The check passes, and the save still answers an error on a path: core
    kept its stored value there and saved the rest."""
    state = MapState()
    style_id = state.active_style_id(31)

    def unchecked(
        request: httpx.Request, response: httpx.Response
    ) -> httpx.Response | None:
        if request.url.path.endswith("/check"):
            return httpx.Response(200, json={**response.json(), "issues": []})
        return None

    services = _Services(state, core=_answering(state, unchecked))
    result = await _run(
        services,
        layer_project_id=31,
        operations=[
            {"op": "set", "path": "/symbol/label/text", "value": "{inhabitants}"},
            {"op": "set", "path": "/opacity", "value": 0.4},
        ],
    )
    assert result.not_saved == ["/symbol/label/text"]
    assert result.changed == ["/opacity"]
    assert (result.revision_before, result.revision_after) == (1, 2)
    stored = state.styles[style_id].document
    assert stored["symbol"]["label"]["text"] == "{name}" and stored["opacity"] == 0.4
    assert result.note is not None and "not_saved" in result.note
    [issue] = [i for i in result.issues if i.level == "error"]
    assert issue.path == "/symbol/label/text" and issue.existing is None
    undo = result.undo()
    assert undo is not None and undo["kind"] == "style"


async def test_an_edit_keeps_the_document_before_it_for_undo() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    result = await _run(_Services(state), layer_project_id=31, operations=[RED])
    assert result.undo() == {
        "kind": "style",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": style_id,
        "revision_before": 1,
        "revision_after": 2,
        "before": {"document": before, "name": "Default"},
    }
    dumped = result.model_dump(mode="json")
    assert not {"before", "name_before", "active_before"} & set(dumped)
    # The result says ``created``, and the runtime still reads it as a change
    # to take back, not as a tool's record of what it created.
    assert dumped["created"] is False and "was_created" not in dumped
    assert isinstance(result, Undoes) and not isinstance(result, Creates)


async def test_an_edit_names_another_style_of_the_layer_and_can_make_it_active() -> (
    None
):
    state = MapState()
    active = state.active_style_id(31)
    other = state.add_style(31, "Night", _document(state, active))
    services = _Services(state)
    quiet = await _run(
        services, layer_project_id=31, style_id=other.id, operations=[RED]
    )
    assert (quiet.style_id, quiet.active, quiet.made_active) == (other.id, False, False)
    assert state.active_style_id(31) == active
    assert "active_before" not in (quiet.undo() or {})
    blue = {"op": "set", "path": "/symbol/fill/color", "value": "#0000ff"}
    shown = await _run(
        services,
        layer_project_id=31,
        style_id=other.id,
        operations=[blue],
        make_active=True,
    )
    assert (shown.active, shown.made_active) == (True, True)
    assert state.active_style_id(31) == other.id
    assert services.body("PATCH", "/layer/31/map-state") == {
        "active_style_id": other.id
    }
    undo = shown.undo()
    assert undo is not None and undo["active_before"] == active
    # On the style the map draws, make_active changes nothing.
    again = await _run(
        services, layer_project_id=31, operations=[RED], make_active=True
    )
    assert (again.style_id, again.active, again.made_active) == (other.id, True, False)


async def test_a_style_of_another_layer_or_project_is_never_written() -> None:
    state = MapState()
    services = _Services(state)
    other_layers = state.active_style_id(32)
    own = state.active_style_id(31)
    for args in (
        {"operations": [RED]},
        {"document": POINTS},
    ):
        with pytest.raises(ToolFailed) as raised:
            await _update(services, layer_project_id=31, style_id=other_layers, **args)
        assert raised.value.message == (
            "This style does not belong to the layer; its styles are: "
            f"Default ({own})."
        )
    assert services.calls() == []


# ---- a new style -----------------------------------------------------------------


async def test_a_new_style_from_the_current_one_is_created_saved_and_made_active() -> (
    None
):
    state = MapState()
    active = state.active_style_id(31)
    services = _Services(state)
    result = await _run(
        services,
        layer_project_id=31,
        new_style={"name": "Density", "asked": "as a new style", "start": "current"},
        operations=[QUANTILES],
    )
    new = result.style_id
    assert new != active and state.styles[new].name == "Density"
    assert services.calls() == [
        ("GET", f"style/{active}?check=true"),
        ("POST", f"style/{active}/check"),
        ("POST", "style"),
        ("PUT", f"style/{new}"),
        ("PATCH", "map-state"),
    ]
    assert services.body("POST", "/layer/31/style") == {
        "name": "Density",
        "copy_from": active,
    }
    assert services.body("PUT", f"/style/{new}")["base_rev"] == 1
    assert services.body("PATCH", "/map-state") == {"active_style_id": new}
    assert state.active_style_id(31) == new
    [classification] = state.styles[new].document["classify"]
    assert classification["id"] == "density" and len(classification["classes"]) == 5
    # The style the map drew before is as it was.
    assert state.styles[active].revision == 1
    assert "classify" not in state.styles[active].document
    assert (result.was_created, result.active, result.made_active) == (True, True, True)
    assert (result.revision_before, result.revision_after) == (None, 2)
    assert result.changed == [] and result.added == {"0": "density"}
    assert result.undo() == {
        "kind": "style_created",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": new,
        "revision": 2,
        "active_before": active,
    }
    [legend] = result.legend
    assert legend.classification == "/classify/density" and legend.features == 60
    dumped = await _update(
        services,
        layer_project_id=31,
        new_style={"name": "Quiet", "asked": "as a new style", "start": "current"},
        operations=[RED],
        make_active=False,
    )
    assert dumped["created"] is True and dumped["active"] is False
    assert "revision_before" not in dumped and dumped["made_active"] is False
    assert state.active_style_id(31) == new


async def test_a_new_style_from_the_dataset_default_and_from_empty() -> None:
    state = MapState()
    _quantile_districts(state)
    services = _Services(state)
    size = {"op": "set", "path": "/opacity", "value": 0.5}
    default = await _run(
        services,
        layer_project_id=31,
        new_style={
            "name": "Plain",
            "asked": "as a new style",
            "start": "dataset_default",
        },
        operations=[size],
    )
    layer_id = map_layer(31).layer_id
    assert f"/api/v2/layer/{layer_id}/style" in services.core.paths()
    stored = state.styles[default.style_id].document
    # The dataset's default has no classification; the drawn style's is gone.
    assert "classify" not in stored and stored["opacity"] == 0.5
    assert stored["symbol"]["outline"] == {"color": "auto", "width": 1}
    empty = await _run(
        services,
        layer_project_id=32,
        new_style={"name": "Bare", "asked": "as a new style", "start": "empty"},
        operations=[{"op": "set", "path": "/symbol/marker/size", "value": 14}],
    )
    marker = state.styles[empty.style_id].document["symbol"]["marker"]
    assert marker["shape"] == "circle" and marker["size"] == 14
    assert empty.undo() is not None and empty.undo()["kind"] == "style_created"  # type: ignore[index]
    # A raster starts from an image.
    raster = await _run(
        services,
        layer_project_id=37,
        new_style={"name": "Faint", "asked": "as a new style", "start": "empty"},
        operations=[size],
    )
    assert state.styles[raster.style_id].document == {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "image"},
        "opacity": 0.5,
    }
    assert raster.legend == [] and raster.legend_note is None
    # And is edited in place like any style, without numbers to count.
    edited = await _run(
        services,
        layer_project_id=38,
        operations=[{"op": "set", "path": "/opacity", "value": 0.3}],
    )
    assert (edited.revision_before, edited.revision_after) == (1, 2)
    assert state.styles[state.active_style_id(38)].document["opacity"] == 0.3
    assert edited.changed == ["/opacity"] and edited.legend == []


async def test_a_new_style_from_the_current_one_keeps_the_errors_it_had() -> None:
    state = MapState()
    active = state.active_style_id(31)
    state.styles[active].document["symbol"]["label"]["text"] = "{inhabitants}"
    services = _Services(state)
    result = await _run(
        services,
        layer_project_id=31,
        new_style={"name": "Faint", "asked": "as a new style", "start": "current"},
        operations=[{"op": "set", "path": "/opacity", "value": 0.4}],
    )
    assert result.was_created and state.styles[result.style_id].revision == 2
    assert result.not_saved == []
    [issue] = [i for i in result.issues if i.level == "error"]
    assert issue.existing is True


async def test_a_dataset_default_the_user_cannot_read_stops_before_any_write() -> None:
    state = MapState()

    def hidden(
        request: httpx.Request, response: httpx.Response
    ) -> httpx.Response | None:
        if request.url.path.startswith("/api/v2/layer/"):
            return httpx.Response(404, json={"detail": {"code": "not_found"}})
        return None

    services = _Services(state, core=_answering(state, hidden))
    with pytest.raises(ToolFailed) as raised:
        await _update(
            services,
            layer_project_id=31,
            new_style={
                "name": "Plain",
                "asked": "as a new style",
                "start": "dataset_default",
            },
            operations=[RED],
        )
    assert raised.value.message == NO_DATASET_DEFAULT
    assert services.writes() == []


async def test_a_whole_document_becomes_a_new_style() -> None:
    state = MapState()
    active = state.active_style_id(32)
    services = _Services(state)
    result = await _run(
        services,
        layer_project_id=32,
        new_style={"name": "Squares", "asked": "as a new style"},
        document=json.dumps(POINTS),
    )
    assert services.calls() == [
        ("POST", f"style/{active}/check"),
        ("POST", "style"),
        ("PUT", f"style/{result.style_id}"),
        ("PATCH", "map-state"),
    ]
    assert services.body("POST", "/check") == {"document": POINTS}
    assert state.styles[result.style_id].document == POINTS
    assert (result.was_created, result.name, result.revision_after) == (
        True,
        "Squares",
        2,
    )
    assert state.active_style_id(32) == result.style_id


async def test_the_check_of_a_new_style_runs_before_it_is_created() -> None:
    state = MapState()
    services = _Services(state)
    before = state.snapshot()
    bad = copy.deepcopy(POINTS)
    bad["symbol"]["label"] = {"text": "{nope}"}
    with pytest.raises(ToolFailed) as raised:
        await _update(
            services,
            layer_project_id=32,
            new_style={"name": "Bad", "asked": "as a new style"},
            document=bad,
        )
    assert raised.value.message.startswith("Not saved: 1 issue(s)")
    assert raised.value.message.endswith(
        "Change the document and call style_update again."
    )
    assert services.writes() == [] and state.snapshot() == before
    # An error the drawn style has does not excuse a new document's.
    active = state.active_style_id(32)
    state.styles[active].document["symbol"]["label"] = {"text": "{nope}"}
    with pytest.raises(ToolFailed, match=r"Not saved: 1 issue\(s\)"):
        await _update(
            services,
            layer_project_id=32,
            new_style={"name": "Bad", "asked": "as a new style"},
            document=bad,
        )
    assert services.writes() == []


async def test_the_tenth_style_is_refused_before_any_write_and_offers_the_replace_values() -> (
    None
):
    state = MapState()
    active = state.active_style_id(31)
    made = [
        state.add_style(31, f"Variant {n}", _document(state, active))
        for n in range(1, 10)
    ]
    services = _Services(state)
    for args in (
        {
            "new_style": {
                "name": "One more",
                "asked": "as a new style",
                "start": "current",
            },
            "operations": [RED],
        },
        {
            "new_style": {"name": "One more", "asked": "as a new style"},
            "document": POINTS,
        },
    ):
        with pytest.raises(ToolFailed) as raised:
            await _update(services, layer_project_id=31, **args)
        message = raised.value.message
        assert message.startswith("This layer has 10 styles, the most a layer takes.")
        assert f"Default (replace_style:{active})" in message
        for style in made:
            assert f"{style.name} (replace_style:{style.id})" in message
        assert "ask_user" in message and "style_id" in message
    assert services.calls() == [] and len(state.styles_of(31)) == 10


async def test_core_refusing_an_eleventh_style_says_the_same() -> None:
    """Another session filled the layer between the read and the create."""
    state = MapState()
    services = _Services(
        state, core=_failing(state, "POST", "/style", 409, "too_many_styles")
    )
    with pytest.raises(ToolFailed) as raised:
        await _update(
            services,
            layer_project_id=31,
            new_style={"name": "B", "asked": "as a new style"},
            document=POINTS,
        )
    assert raised.value.message.startswith("This layer has 10 styles")


# ---- replacing a style -----------------------------------------------------------


async def test_replace_needs_the_card_pick_and_keeps_the_old_name_and_document_for_undo() -> (
    None
):
    state = MapState()
    active = state.active_style_id(32)
    other = state.add_style(32, "Old look", _document(state, active))
    before = _document(state, other.id)
    services = _Services(state)
    with pytest.raises(ToolFailed) as raised:
        await _update(services, layer_project_id=32, style_id=other.id, document=POINTS)
    assert f"replace_style:{other.id}" in raised.value.message
    assert "ask_user" in raised.value.message
    assert "single-select" in raised.value.message
    assert "keeps the style" in raised.value.message
    assert services.calls() == []
    # The pick of another style is no consent for this one.
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    with pytest.raises(ToolFailed, match="ask_user"):
        await _update(services, layer_project_id=32, style_id=other.id, document=POINTS)
    services = _Services(state, asks=_picked(f"replace_style:{other.id}"))
    result = await _run(
        services,
        layer_project_id=32,
        style_id=other.id,
        document=POINTS,
        name="Squares",
    )
    assert services.calls() == [
        ("GET", f"style/{other.id}"),
        ("POST", f"style/{other.id}/check"),
        ("PUT", f"style/{other.id}"),
        ("PATCH", f"style/{other.id}"),
        ("PATCH", "map-state"),
    ]
    assert services.body("PATCH", f"/style/{other.id}") == {"name": "Squares"}
    stored = state.styles[other.id]
    assert (stored.name, stored.document, stored.revision) == ("Squares", POINTS, 2)
    assert state.active_style_id(32) == other.id
    assert (result.was_created, result.name, result.made_active) == (
        False,
        "Squares",
        True,
    )
    assert result.undo() == {
        "kind": "style",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 32,
        "style_id": other.id,
        "revision_before": 1,
        "revision_after": 2,
        "before": {"document": before, "name": "Old look"},
        "renamed_to": "Squares",
        "active_before": active,
    }


async def test_a_replace_pick_counts_only_for_the_request_it_answered() -> None:
    """A pick from before the user's last typed message allows no later
    replace; the refusal lets this answer's card offer the value."""
    state = MapState()
    active = state.active_style_id(32)
    other = state.add_style(32, "Old look", _document(state, active))
    picked = _picked(f"replace_style:{other.id}")
    earlier = dataclasses.replace(picked, chain=frozenset())
    services = _Services(state, asks=earlier)
    with pytest.raises(ToolFailed, match="ask_user"):
        await _update(services, layer_project_id=32, style_id=other.id, document=POINTS)
    assert services.env.confirm_values == {f"replace_style:{other.id}"}
    assert services.calls() == []
    now = dataclasses.replace(picked, chain=frozenset(picked.answers))
    result = await _run(
        _Services(state, asks=now),
        layer_project_id=32,
        style_id=other.id,
        document=POINTS,
    )
    assert result.revision_after == 2


# ---- fit in a whole document -----------------------------------------------------

FITTED = {
    "id": "density",
    "field": "density",
    "method": "quantile",
    "count": 7,
    "fit": True,
    "palette": "colorbrewer:OrRd",
}


def _fitted_districts(state: MapState) -> str:
    """Districts with a tool's classes fitted to the data, stored; the style's id."""
    document = _document(state, state.active_style_id(31))
    document["classify"] = [dict(FITTED)]
    _save(state, 31, document)
    return state.active_style_id(31)


def _as_written(document: dict[str, Any]) -> dict[str, Any]:
    """A stored document as the model writes it whole: no computed values, no
    classes of a computed method."""
    out = copy.deepcopy(document)
    for c in out.get("classify") or []:
        c.pop("computed", None)
        if c.get("method") != "manual":
            c.pop("classes", None)
    return out


async def test_a_whole_new_style_never_carries_fit() -> None:
    state = MapState()
    services = _Services(state)
    document = _document(state, state.active_style_id(31))
    document["classify"] = [dict(FITTED)]
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            layer_project_id=31,
            new_style={"name": "Fitted", "asked": "as a new style"},
            document=document,
        )
    assert "/classify/density/fit" in raised.value.message
    assert services.writes() == []


async def test_a_replace_never_adds_fit_where_the_stored_style_has_none() -> None:
    state = MapState()
    active = state.active_style_id(31)
    document = _document(state, active)
    document["classify"] = [{**FITTED, "fit": False}]
    _save(state, 31, document)
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    replacement = _as_written(_document(state, active))
    replacement["classify"][0]["fit"] = True
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services, layer_project_id=31, style_id=active, document=replacement
        )
    assert "/classify/density/fit" in raised.value.message
    assert services.writes() == []
    # A classification the stored style has not, by id or by place.
    replacement = _as_written(_document(state, active))
    replacement["classify"].append({**FITTED, "id": "more", "target": "outline.width"})
    with pytest.raises(InputInvalid, match="/classify/more/fit"):
        await _update(
            services, layer_project_id=31, style_id=active, document=replacement
        )
    assert services.writes() == []


async def test_a_replace_of_fitted_classes_settles_fit_as_an_edit_does() -> None:
    state = MapState()
    active = _fitted_districts(state)
    stored = _document(state, active)
    assert stored["classify"][0]["fit"] is True
    # A new count: the classes compute as asked, without fit.
    replacement = _as_written(stored)
    replacement["classify"][0]["count"] = 5
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    await _run(services, layer_project_id=31, style_id=active, document=replacement)
    saved = state.styles[active].document["classify"][0]
    assert (saved["count"], "fit" in saved) == (5, False)
    assert "fit" not in services.body("POST", "/check")["document"]["classify"][0]


async def test_a_replace_that_keeps_the_fitted_classes_keeps_fit() -> None:
    state = MapState()
    active = _fitted_districts(state)
    replacement = _as_written(_document(state, active))
    replacement["classify"][0]["title"] = "Density"
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    await _run(services, layer_project_id=31, style_id=active, document=replacement)
    saved = state.styles[active].document["classify"][0]
    assert (saved["title"], saved["fit"], saved["count"]) == ("Density", True, 7)


async def test_a_replace_that_recolors_one_fitted_class_keeps_every_class() -> None:
    """One class listed with a change and no bounds lies over the stored
    classes by id, as an operation would: the classes stay as they are,
    manual, with that one color changed."""
    state = MapState()
    active = _fitted_districts(state)
    stored = _document(state, active)["classify"][0]
    first = stored["classes"][0]["id"]
    replacement = _as_written(_document(state, active))
    replacement["classify"][0]["classes"] = [
        {"id": first, "fill": {"color": "#ff0000"}}
    ]
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    await _run(services, layer_project_id=31, style_id=active, document=replacement)
    saved = state.styles[active].document["classify"][0]
    assert (saved["method"], saved["fit"]) == ("manual", True)
    expected = copy.deepcopy(stored["classes"])
    expected[0]["fill"]["color"] = "#ff0000"
    assert saved["classes"] == expected


async def test_a_replace_listing_a_class_id_the_stored_style_has_not_is_taken_as_written() -> (
    None
):
    state = MapState()
    active = _fitted_districts(state)
    count = len(_document(state, active)["classify"][0]["classes"])
    replacement = _as_written(_document(state, active))
    replacement["classify"][0]["classes"] = [
        {"id": "nope", "fill": {"color": "#ff0000"}}
    ]
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    await _run(services, layer_project_id=31, style_id=active, document=replacement)
    saved = state.styles[active].document["classify"][0]
    # No stored class changed: the classes stay fitted and the server computes them.
    assert (saved["method"], saved["fit"], len(saved["classes"])) == (
        "quantile",
        True,
        count,
    )
    assert "nope" not in [k["id"] for k in saved["classes"]]


async def test_a_replace_with_classes_of_its_own_bounds_is_taken_as_written() -> None:
    state = MapState()
    active = _fitted_districts(state)
    stored = _document(state, active)["classify"][0]["classes"]
    replacement = _as_written(_document(state, active))
    own = [
        {"id": stored[0]["id"], "to": 2000, "fill": {"color": "#ff0000"}},
        {"id": stored[1]["id"], "from": 2000, "to": 4000, "fill": {"color": "#00ff00"}},
        {"id": stored[2]["id"], "from": 4000, "fill": {"color": "#0000ff"}},
    ]
    replacement["classify"][0]["classes"] = own
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    await _run(services, layer_project_id=31, style_id=active, document=replacement)
    saved = state.styles[active].document["classify"][0]
    assert (saved["method"], saved["fit"]) == ("manual", True)
    assert saved["classes"] == own


async def test_computed_values_in_a_whole_document_are_the_servers() -> None:
    """A whole document's computed values are not stored: the server computes
    its own, `single` included, for a new style and a replaced one."""
    state = MapState()
    active = state.active_style_id(31)
    document = _document(state, active)
    stamp = {"at": "2026-01-01T00:00:00Z", "data": "elsewhere", "scope": "dataset"}
    document["classify"] = [
        {
            "id": "density",
            "field": "density",
            "method": "manual",
            "classes": [{"id": "a", "to": 1000}, {"id": "b", "from": 1000}],
            "computed": {**stamp, "domain": [0, 1], "single": {"a": 1.0}},
        }
    ]
    created = await _run(
        _Services(state),
        layer_project_id=31,
        new_style={"name": "Copied", "asked": "as a new style"},
        document=document,
    )
    services = _Services(state, asks=_picked(f"replace_style:{active}"))
    await _run(services, layer_project_id=31, style_id=active, document=document)
    for style_id in (created.style_id, active):
        computed = state.styles[style_id].document["classify"][0]["computed"]
        assert "single" not in computed
        assert computed["data"] != "elsewhere" and computed["domain"] != [0, 1]


async def test_too_many_styles_lets_the_card_offer_each_replacement() -> None:
    state = MapState()
    for n in range(9):
        state.add_style(31, f"Look {n}", _document(state, state.active_style_id(31)))
    services = _Services(state)
    with pytest.raises(ToolFailed, match="10 styles"):
        await _update(
            services,
            layer_project_id=31,
            new_style={"name": "B", "asked": "as a new style"},
            document=POINTS,
        )
    assert services.env.confirm_values == {
        f"replace_style:{style.id}" for style in state.styles_of(31)
    }


async def test_a_rename_alone_still_leaves_an_undo_record() -> None:
    state = MapState()
    style_id = state.active_style_id(32)
    before = _document(state, style_id)
    services = _Services(state, asks=_picked(f"replace_style:{style_id}"))
    result = await _run(
        services, layer_project_id=32, style_id=style_id, document=before, name="Base"
    )
    assert result.revision_before == result.revision_after == 1
    assert state.styles[style_id].name == "Base"
    undo = result.undo()
    assert undo is not None and undo["before"]["name"] == "Default"
    assert undo["renamed_to"] == "Base"
    assert "active_before" not in undo
    # The web shows Undo and refreshes the style list on this field.
    assert result.renamed is True
    assert result.model_dump(mode="json")["renamed"] is True
    edited = await _run(_Services(state), layer_project_id=31, operations=[RED])
    assert edited.renamed is False


# ---- after the first write -------------------------------------------------------


async def test_a_failed_save_after_create_still_has_an_undo_record() -> None:
    state = MapState()
    active = state.active_style_id(31)
    services = _Services(
        state, core=_failing(state, "PUT", "", 503, "check_unavailable")
    )
    result = await _run(
        services,
        layer_project_id=31,
        new_style={"name": "Density", "asked": "as a new style", "start": "current"},
        operations=[QUANTILES],
    )
    assert result.was_created is True
    assert result.incomplete == (
        "The style was created but its content could not be saved: "
        "The style could not be saved right now. Try once more. "
        "It holds a copy of the current style."
    )
    assert result.revision_after == 1 and result.made_active is False
    assert result.active is False and state.active_style_id(31) == active
    assert result.undo() == {
        "kind": "style_created",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": result.style_id,
        "revision": 1,
        "active_before": None,
    }
    assert [m for m, _ in services.calls()][-2:] == ["POST", "PUT"]
    assert result.legend == [] and services.processes.requests == []


async def test_a_failed_make_active_is_said_and_the_style_is_saved() -> None:
    state = MapState()
    active = state.active_style_id(31)
    services = _Services(
        state, core=_failing(state, "PATCH", "/map-state", 503, "unavailable")
    )
    result = await _run(
        services,
        layer_project_id=31,
        new_style={"name": "Density", "asked": "as a new style", "start": "current"},
        operations=[QUANTILES],
    )
    assert result.was_created and result.revision_after == 2
    assert state.styles[result.style_id].document["classify"]
    assert (result.active, result.made_active) == (False, False)
    assert state.active_style_id(31) == active
    assert result.incomplete is not None
    assert result.incomplete.startswith(
        "The style was saved but the layer still shows the style it showed before: "
    )
    undo = result.undo()
    assert undo is not None and undo["active_before"] is None
    assert undo["revision"] == 2


async def test_a_failed_rename_is_said_and_the_document_is_saved() -> None:
    state = MapState()
    style_id = state.active_style_id(32)
    services = _Services(
        state,
        core=_failing(state, "PATCH", f"/style/{style_id}", 503, "unavailable"),
        asks=_picked(f"replace_style:{style_id}"),
    )
    result = await _run(
        services, layer_project_id=32, style_id=style_id, document=POINTS, name="New"
    )
    assert result.revision_after == 2 and result.name == "Default"
    assert result.incomplete is not None
    assert result.incomplete.startswith("The style was saved but not renamed: ")
    undo = result.undo()
    assert undo is not None and undo["before"]["name"] == "Default"


async def test_a_failed_rename_in_a_replace_still_makes_the_style_active() -> None:
    state = MapState()
    active = state.active_style_id(32)
    other = state.add_style(32, "Old look", _document(state, active))
    services = _Services(
        state,
        core=_failing(state, "PATCH", f"/style/{other.id}", 503, "unavailable"),
        asks=_picked(f"replace_style:{other.id}"),
    )
    result = await _run(
        services, layer_project_id=32, style_id=other.id, document=POINTS, name="New"
    )
    assert result.made_active and state.active_style_id(32) == other.id
    assert result.incomplete is not None
    assert result.incomplete.startswith("The style was saved but not renamed: ")
    assert "still shows" not in result.incomplete

    # Neither the rename nor the switch: the note names both.
    state = MapState()
    active = state.active_style_id(32)
    other = state.add_style(32, "Old look", _document(state, active))
    core = map_core(state)

    def refusing(request: httpx.Request) -> httpx.Response:
        if request.method == "PATCH":
            return httpx.Response(503, json={"detail": {"code": "unavailable"}})
        response = core.answer(request)
        assert response is not None
        return response

    services = _Services(
        state, core=_Proxy(refusing), asks=_picked(f"replace_style:{other.id}")
    )
    result = await _run(
        services, layer_project_id=32, style_id=other.id, document=POINTS, name="New"
    )
    assert not result.made_active and state.active_style_id(32) == active
    assert result.incomplete is not None
    assert "not renamed" in result.incomplete and "still shows" in result.incomplete


async def test_an_unexpected_failure_after_a_write_still_returns_the_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from assistant.styles import edits

    async def broken(*args: Any) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(edits, "make_active", broken)
    state = MapState()
    result = await _run(
        _Services(state),
        layer_project_id=31,
        new_style={"name": "Density", "asked": "as a new style", "start": "current"},
        operations=[QUANTILES],
    )
    assert result.incomplete == (
        "The style was saved but the layer still shows the style it showed "
        "before: An unexpected error stopped the call."
    )
    undo = result.undo()
    assert undo is not None and undo["revision"] == 2
    assert undo["active_before"] is None


async def test_a_save_that_fails_first_changes_nothing_and_fails_the_call() -> None:
    state = MapState()
    before = state.snapshot()
    for status, code, said in (
        (503, "save_conflict", NOT_SAVED_NOW),
        (503, "check_unavailable", NOT_SAVED_NOW),
        (422, "document_too_large", TOO_LARGE),
        (403, "forbidden", VIEWER_STYLES),
        (403, "locked", "The user has no access to this layer."),
    ):
        services = _Services(state, core=_failing(state, "PUT", "", status, code))
        with pytest.raises(ToolFailed) as raised:
            await _update(services, layer_project_id=31, operations=[RED])
        assert raised.value.message == said, code
    assert state.snapshot() == before


async def test_a_check_that_cannot_run_stops_before_any_write() -> None:
    state = MapState()
    for status, code, said in (
        (503, "check_unavailable", NOT_CHECKED_NOW),
        (422, "document_too_large", TOO_LARGE),
    ):
        services = _Services(
            state, core=_failing(state, "POST", "/check", status, code)
        )
        with pytest.raises(ToolFailed) as raised:
            await _update(services, layer_project_id=31, operations=[RED])
        assert raised.value.message == said
        assert services.writes() == []
    services = _Services(
        state, core=_failing(state, "POST", "/check", 422, "check_failed")
    )
    with pytest.raises(ToolFailed, match="could not be checked"):
        await _update(services, layer_project_id=31, operations=[RED])
    assert services.writes() == []


# ---- who may not ------------------------------------------------------------------


async def test_a_viewer_a_locked_layer_and_a_table_are_refused_in_plain_words_before_any_write() -> (
    None
):
    viewer_state = MapState()
    before = viewer_state.snapshot()
    viewer_page = {"surface": "project.map", "project_id": MAP_VIEW_PROJECT_ID}
    for args in (
        {"operations": [RED]},
        {
            "new_style": {"name": "B", "asked": "as a new style", "start": "current"},
            "operations": [RED],
        },
    ):
        viewer = _Services(
            viewer_state,
            core=map_core(viewer_state, read_only=True),
            page=viewer_page,
        )
        with pytest.raises(ToolFailed) as raised:
            await _update(viewer, layer_project_id=31, **args)
        assert raised.value.message == VIEWER_STYLES
        assert VIEWER_STYLES == "The user can view this project but not change it."
    assert viewer_state.snapshot() == before

    state = MapState()

    def rows(request: httpx.Request, response: httpx.Response) -> httpx.Response | None:
        if request.url.path == f"{BASE}/layer":
            listed = response.json()
            for row in listed:
                if row["id"] == 39:
                    row["type"] = "table"
                if row["id"] in (33, 38):
                    row["locked"] = True
                if row["id"] == 36:
                    row["other_properties"] = {
                        "catalog_materialize": {"status": "running"}
                    }
            return httpx.Response(200, json=listed)
        return None

    services = _Services(state, core=_answering(state, rows))
    with pytest.raises(ToolFailed, match="A table has no style."):
        await _update(services, layer_project_id=39, operations=[RED])
    for link in (33, 38):
        with pytest.raises(ToolFailed, match="no access"):
            await _update(services, layer_project_id=link, operations=[RED])
    with pytest.raises(ToolFailed, match="still being copied"):
        await _update(services, layer_project_id=36, operations=[RED])
    with pytest.raises(InputInvalid, match="There is no layer 99"):
        await _update(services, layer_project_id=99, operations=[RED])
    assert services.calls() == []

    def locked(
        request: httpx.Request, response: httpx.Response
    ) -> httpx.Response | None:
        if "/style/" in request.url.path:
            return httpx.Response(403, json={"detail": {"code": "locked"}})
        return None

    services = _Services(state, core=_answering(state, locked))
    with pytest.raises(ToolFailed, match="The user has no access to this layer."):
        await _update(services, layer_project_id=31, operations=[RED])
    assert services.writes() == []


async def test_without_an_open_project_nothing_is_changed() -> None:
    state = MapState()
    services = _Services(state, page={"surface": "none"})
    with pytest.raises(ToolFailed):
        await _update(services, layer_project_id=31, operations=[RED])
    assert services.core.requests == []


# ---- the legend numbers ----------------------------------------------------------


async def test_legend_numbers_come_for_the_touched_classification_only() -> None:
    state = MapState()
    style_id = state.active_style_id(34)
    document = _document(state, style_id)
    document["classify"].append(
        {
            "field": "area_m2",
            "method": "quantile",
            "count": 4,
            "palette": "colorbrewer:Blues",
            "target": "outline.color",
        }
    )
    document["symbol"]["outline"] = {"color": "#000000", "width": 1}
    _save(state, 34, document)
    services = _Services(state)
    result = await _update(
        services,
        layer_project_id=34,
        operations=[{"op": "set", "path": "/classify/area_m2/count", "value": 5}],
    )
    [legend] = result["legend"]
    assert legend["classification"] == "/classify/area_m2"
    assert len(legend["classes"]) == 5
    # The numbers are counted under the layer's saved filter.
    assert 0 < legend["features"] < len(map_layer(34).features)
    asked = {r.url.path.split("/")[2] for r in services.processes.requests}
    assert asked == {"feature-count", "histogram"}
    # An edit outside the classifications asks for no numbers.
    quiet = _Services(state)
    result = await _update(
        quiet,
        layer_project_id=34,
        operations=[{"op": "set", "path": "/opacity", "value": 0.5}],
    )
    assert result.get("legend", []) == [] and "legend_note" not in result
    assert quiet.processes.requests == []


def test_the_touched_classifications_are_read_from_the_changed_paths() -> None:
    assert touched_classifications(
        [
            "/opacity",
            "/classify/density/count",
            "/classify/density/classes/c7",
            "/classify/use",
            "/render/classify/classes/c1",
            "/render/type",
        ]
    ) == ["/classify/density", "/classify/use", "/render/classify"]
    assert touched_classifications(["/symbol/fill/color"]) == []
    # The whole list was written: every classification counts.
    assert touched_classifications(["/opacity", "/classify"]) is None


async def test_legend_numbers_never_fail_the_call() -> None:
    state = MapState()
    processes = _processes()
    processes.routes[("POST", "/processes/histogram/execution")] = httpx.Response(
        500, json={"detail": "boom"}
    )
    services = _Services(state, processes=processes)
    result = await _update(services, layer_project_id=31, operations=[QUANTILES])
    assert result["revision_after"] == 2
    assert result.get("legend", []) == [] and result["legend_note"]


# ---- repeats and the registry ----------------------------------------------------


async def test_the_same_edit_in_a_later_answer_runs_again() -> None:
    """Repeat protection is per answer: a later answer runs the same edit
    again, and within one answer the second call gets the first's result."""
    state = MapState()
    args = {"layer_project_id": 31, "operations": [RED]}
    services = _Services(state)
    first = await _update(services, **args)
    stored = [
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool",
                    "tool_name": "style_update",
                    "tool_call_id": "c1",
                    "args": args,
                    "state": "output",
                    "output": first,
                    "error": None,
                }
            ],
        }
    ]
    assert earlier_writes(stored) == {}

    services = _Services(MapState())
    read = ("style_get", {"layer_project_id": 31})
    edit = ("style_update", args)
    script = ScriptedModel([read, edit, read, edit])

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=services.env)
    await build_agent(script.model).run("make it red", deps=deps)
    before, edited, after, repeated = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]
    assert before["revision"] == 1 and edited["revision_after"] == 2
    # The edit made the earlier read stale: the same read runs again.
    assert after["revision"] == 2 and "repeated_call" not in after
    assert repeated["repeated_call"] == REPEATED_STYLE_EDIT
    assert len([r for r in services.core.requests if r.method == "PUT"]) == 1


def test_the_registry_lists_it_as_a_write_that_makes_style_get_and_project_get_layers_stale() -> (
    None
):
    assert UPDATE_STYLE in STYLE_TOOLS
    assert BY_WIRE_NAME["style_update"] is UPDATE_STYLE
    assert UPDATE_STYLE.name == "style.update"
    assert (UPDATE_STYLE.risk, UPDATE_STYLE.scope) == ("write", "goat:write")
    assert UPDATE_STYLE.surfaces == frozenset({"project.map"})
    assert not UPDATE_STYLE.mcp
    assert (
        UPDATE_STYLE.repeatable
        == REPEATED_STYLE_EDIT
        == (
            "You made this style change earlier in this answer; this is its result "
            "again. Sending it again changes nothing: change the call as its note or "
            "refusal says."
        )
    )
    assert UPDATE_STYLE.invalidates == frozenset(
        {"style_get", "project_get_layers", "style_update"}
    )
    # What a change makes stale is everything read or changed of its layer.
    assert UPDATE_STYLE.same == frozenset({"layer_project_id"})
    assert UPDATE_STYLE.output_model is StyleUpdated


# ---- what a landed change makes stale --------------------------------------------


async def _answer(services: _Services, *calls: tuple[str, dict[str, Any]]) -> list[Any]:
    """One answer that makes ``calls`` in order: what each returned."""
    script = ScriptedModel(list(calls))

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=services.env)
    await build_agent(script.model).run("style it", deps=deps)
    return [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]


async def test_an_edit_made_again_after_another_one_runs_again() -> None:
    """Red, blue, red in one answer: the third call is no repeat, because the
    second changed the style in between. Red twice in a row is one."""
    state = MapState()
    services = _Services(state)
    red = ("style_update", {"layer_project_id": 31, "operations": [RED]})
    blue_op = {"op": "set", "path": "/symbol/fill/color", "value": "#0000ff"}
    blue = ("style_update", {"layer_project_id": 31, "operations": [blue_op]})
    first, second, third, fourth = await _answer(services, red, blue, red, red)
    assert [r["revision_after"] for r in (first, second, third)] == [2, 3, 4]
    assert "repeated_call" not in third
    assert fourth["repeated_call"] == REPEATED_STYLE_EDIT
    assert fourth["revision_after"] == 4
    style = state.styles[state.active_style_id(31)]
    assert style.document["symbol"]["fill"]["color"] == "#ff0000"
    assert len([r for r in services.core.requests if r.method == "PUT"]) == 3


async def test_the_third_change_of_a_layers_style_in_an_answer_says_to_finish() -> None:
    """Counted per layer, by the changes that landed: a repeated call is
    answered from the first, and a change of another layer counts for that
    one."""
    state = MapState()
    services = _Services(state)
    red = ("style_update", {"layer_project_id": 31, "operations": [RED]})
    blue_op = {"op": "set", "path": "/symbol/fill/color", "value": "#0000ff"}
    blue = ("style_update", {"layer_project_id": 31, "operations": [blue_op]})
    lines = (
        "style_update",
        {
            "layer_project_id": 33,
            "operations": [{"op": "set", "path": "/symbol/line/width", "value": 3}],
        },
    )
    first, again, other, second, third, fourth = await _answer(
        services, red, red, lines, blue, red, blue
    )
    for result in (first, again, other, second):
        assert "answer:" not in result.get("note", ""), result
    assert "repeated_call" in again
    assert third["revision_after"] == 4
    assert third["note"].endswith(THIRD_CHANGE)
    assert fourth["note"].endswith(MORE_CHANGES.format(count=4))
    assert THIRD_CHANGE == (
        "This is the third style change of this layer in this answer: finish "
        "with this one unless an error is left."
    )


async def test_variants_the_user_asked_for_are_not_counted() -> None:
    state = MapState()
    services = _Services(state)
    made = [
        (
            "style_update",
            {
                "layer_project_id": 31,
                "new_style": {
                    "name": f"Look {n}",
                    "asked": "as a new style",
                    "start": "current",
                },
                "operations": [{**RED, "value": color}],
                "make_active": n == 1,
            },
        )
        for n, color in ((1, "#ff0000"), (2, "#00ff00"), (3, "#0000ff"))
    ]
    results = await _answer(services, *made)
    assert [r["created"] for r in results] == [True, True, True]
    for result in results:
        assert "answer:" not in result.get("note", ""), result


async def test_a_refused_change_is_not_counted() -> None:
    state = MapState()
    services = _Services(state)
    red = ("style_update", {"layer_project_id": 31, "operations": [RED]})
    wrong_op = {"op": "set", "path": "/symbol/fill/color", "value": {"field": "nope"}}
    wrong = ("style_update", {"layer_project_id": 31, "operations": [wrong_op]})
    blue_op = {"op": "set", "path": "/symbol/fill/color", "value": "#0000ff"}
    blue = ("style_update", {"layer_project_id": 31, "operations": [blue_op]})
    _, refused, second = await _answer(services, red, wrong, blue)
    assert isinstance(refused, str)
    assert THIRD_CHANGE not in second.get("note", "")


def test_the_description_asks_for_one_call_per_request() -> None:
    described = " ".join(UPDATE_STYLE.description.split())
    for said in (
        "Put every operation of a request into one call (each variant the user "
        "asked for is its own call)",
        "at most two corrections",
        "The legend numbers are the class counts",
        "never count classes with project_count_features or "
        "project_group_statistics",
        "do not read the style back with style_get",
        "Never set the colors of a computed classification class by class",
    ):
        assert said in described, said


async def test_a_read_is_stale_after_a_change_however_either_call_names_the_style() -> (
    None
):
    state = MapState()
    active = state.active_style_id(31)
    services = _Services(state)
    read = ("style_get", {"layer_project_id": 31})
    read_named = ("style_get", {"layer_project_id": 31, "style_id": active})
    read_other = ("style_get", {"layer_project_id": 32})
    named = {"layer_project_id": 31, "style_id": active, "operations": [RED]}
    blue_op = {"op": "set", "path": "/symbol/fill/color", "value": "#0000ff"}
    results = await _answer(
        services,
        read,
        read_named,
        read_other,
        ("style_update", named),
        read,
        read_named,
        read_other,
        ("style_update", {"layer_project_id": 31, "operations": [blue_op]}),
        read_named,
    )
    assert [results[n]["revision"] for n in (0, 1, 4, 5, 8)] == [1, 1, 2, 2, 3]
    for n in (4, 5, 8):
        assert "repeated_call" not in results[n]
    # Another layer's read is as good as it was.
    assert "repeated_call" in results[6]


# ---- a value the call itself writes ----------------------------------------------


async def test_an_error_the_style_had_does_not_excuse_a_new_value_at_its_path() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    state.styles[style_id].document["symbol"]["label"]["text"] = "{nope}"
    services = _Services(state)
    with pytest.raises(ToolFailed) as raised:
        await _update(
            services,
            layer_project_id=31,
            operations=[
                {"op": "set", "path": "/symbol/label/text", "value": "{also_nope}"}
            ],
        )
    assert raised.value.message.startswith(
        "Not saved: 1 issue(s) this edit adds must be fixed first. "
        '/symbol/label/text: The dataset has no field "also_nope".'
    )
    assert services.writes() == []
    # The same holds for a part written whole above the path.
    with pytest.raises(ToolFailed, match="also_nope"):
        await _update(
            services,
            layer_project_id=31,
            operations=[
                {
                    "op": "set",
                    "path": "/symbol/label",
                    "value": {"text": "{also_nope}"},
                }
            ],
        )
    # An edit elsewhere in the style goes through, and so does a good value.
    elsewhere = await _update(
        services,
        layer_project_id=31,
        operations=[{"op": "set", "path": "/opacity", "value": 0.4}],
    )
    assert elsewhere["revision_after"] == 2
    fixed = await _update(
        services,
        layer_project_id=31,
        operations=[{"op": "set", "path": "/symbol/label/text", "value": "{name}"}],
    )
    assert fixed["revision_after"] == 3 and fixed["issues"] == []


def test_the_paths_a_call_writes_are_named_by_id() -> None:
    from goatlib.style.edit import Edit

    from assistant.styles.edits import added_errors, written_pointers

    document = {
        "classify": [
            {"id": "density", "field": "density", "classes": [{"id": "c1"}]},
            {"id": "k1", "field": "use"},
        ],
        "rules": [{"id": "r1", "min_zoom": 3}],
        "symbol": {"fill": {"color": "#fff"}},
    }
    operations = [
        Edit.model_validate(o)
        for o in (
            {"op": "set", "path": "/symbol/fill/color", "value": "#000"},
            {"op": "use_field", "path": "/classify/0/field", "field": "density"},
            {"op": "retarget", "path": "/classify/k1", "target": "outline.color"},
            {"op": "round", "path": "/rules/r1/min_zoom"},
            {"op": "add", "path": "/classify/density/classes", "item": {}},
            {"op": "remove", "path": "/symbol/outline"},
            {"op": "move", "path": "/rules/r1"},
        )
    ]
    written = written_pointers(document, operations, {4: "c1"})
    assert written == [
        "/symbol/fill/color",
        "/classify/density/field",
        "/classify/k1",
        "/rules/r1/min_zoom",
        "/classify/density/classes/c1",
    ]

    def error(path: str) -> dict[str, Any]:
        return {"level": "error", "code": "x", "path": path, "message": "m"}

    known = {("x", "/classify/k1/field"), ("x", "/classify/density/palette")}
    issues = [
        error("/classify/k1/field"),
        error("/classify/density/palette"),
        error("/classify/density/fieldname"),
        {**error("/symbol/fill/color"), "level": "warning"},
    ]
    assert [i["path"] for i in added_errors(issues, known, written)] == [
        "/classify/k1/field",
        "/classify/density/fieldname",
    ]


# ---- a plain copy ----------------------------------------------------------------


async def test_a_new_style_without_operations_is_the_starting_point_as_it_is() -> None:
    state = MapState()
    _quantile_districts(state)
    active = state.active_style_id(31)
    services = _Services(state)
    result = await _run(
        services,
        layer_project_id=31,
        new_style={"name": "Copy", "asked": "as a new style", "start": "current"},
    )
    assert [method for method, _ in services.calls()] == [
        "GET",
        "POST",
        "POST",
        "PUT",
        "PATCH",
    ]
    copy_ = state.styles[result.style_id]
    assert copy_.name == "Copy" and state.active_style_id(31) == result.style_id
    assert copy_.document["classify"] == state.styles[active].document["classify"]
    assert (result.was_created, result.made_active, result.added) == (True, True, {})
    undo = result.undo()
    assert undo is not None and undo["kind"] == "style_created"
    assert undo["revision"] == copy_.revision and undo["active_before"] == active
    plain = await _run(
        services,
        layer_project_id=31,
        new_style={
            "name": "Plain",
            "asked": "as a new style",
            "start": "dataset_default",
        },
        make_active=False,
    )
    assert "classify" not in state.styles[plain.style_id].document


# ---- a save that got no answer ---------------------------------------------------


def _slow(
    state: MapState,
    *,
    lands: bool,
    readable: bool = True,
    method: str = "PUT",
    gateway: int | None = None,
    between: Callable[[], None] | None = None,
) -> _Proxy:
    """The stand-in core, whose answer to a save never arrives: with
    ``lands`` core saved it all the same. Without ``readable`` the style
    cannot be read afterwards either. ``gateway``: a proxy answers this
    status in place of core's answer. ``between``: a person's save, made
    right before this one reaches core."""
    core = map_core(state)
    timed_out: list[bool] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == method and "/style/" in request.url.path:
            if between is not None:
                between()
            if lands:
                assert core.answer(request) is not None
            timed_out.append(True)
            if gateway is not None:
                return httpx.Response(gateway, text="Bad Gateway")
            raise httpx.ReadTimeout("no answer", request=request)
        if timed_out and not readable and "/style/" in request.url.path:
            raise httpx.ConnectError("gone", request=request)
        response = core.answer(request)
        assert response is not None, request.url.path
        return response

    return _Proxy(handler)


async def test_a_save_that_landed_without_an_answer_is_read_back() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    services = _Services(state, core=_slow(state, lands=True))
    result = await _run(services, layer_project_id=31, operations=[RED, QUANTILES])
    # Read back without the check against the data, which is what was slow.
    assert services.calls()[-2:] == [
        ("PUT", f"style/{style_id}"),
        ("GET", f"style/{style_id}"),
    ]
    assert (result.revision_before, result.revision_after) == (1, 2)
    assert result.changed == ["/symbol/fill/color", "/classify"]
    assert result.added == {"1": "density"} and result.incomplete is None
    [legend] = result.legend
    assert len(legend.classes) == 5
    assert result.undo() == {
        "kind": "style",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": style_id,
        "revision_before": 1,
        "revision_after": 2,
        "before": {"document": before, "name": "Default"},
    }


async def test_a_changed_class_count_that_landed_without_an_answer_is_read_back() -> (
    None
):
    """The server writes a computed classification's classes anew, under new
    ids: they are no difference between what was sent and what is stored."""
    state = MapState()
    _quantile_districts(state)
    services = _Services(state, core=_slow(state, lands=True))
    result = await _run(
        services,
        layer_project_id=31,
        operations=[{"op": "set", "path": "/classify/density/count", "value": 7}],
    )
    assert (result.revision_before, result.revision_after) == (2, 3)
    assert result.undo() is not None
    [legend] = result.legend
    assert len(legend.classes) == 7


async def test_a_save_without_an_answer_that_is_not_held_may_still_land() -> None:
    """Core may still be saving when the style is read back: the call says
    the save may have landed, never to try again."""
    state = MapState()
    before = state.snapshot()
    services = _Services(state, core=_slow(state, lands=False))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, layer_project_id=31, operations=[RED])
    assert raised.value.message == SAVE_UNKNOWN
    assert state.snapshot() == before

    # Another save landed in between, not this one: its content is not held.
    state = MapState()
    style_id = state.active_style_id(31)
    core = map_core(state)

    def other_save(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            document = _document(state, style_id)
            document["opacity"] = 0.2
            _save(state, 31, document)
            raise httpx.ReadTimeout("no answer", request=request)
        response = core.answer(request)
        assert response is not None
        return response

    services = _Services(state, core=_Proxy(other_save))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, layer_project_id=31, operations=[RED])
    assert raised.value.message == SAVE_UNKNOWN
    assert state.styles[style_id].document["symbol"]["fill"]["color"] == "#deebf7"


async def test_a_lost_save_merged_onto_another_save_counts_as_landed() -> None:
    """A person saved another path between the read and this save; core
    merged them. The paths this call wrote hold its values: it landed, and
    the added classification is there once, with the call's undo record."""
    state = MapState()
    style_id = state.active_style_id(31)

    def person() -> None:
        document = _document(state, style_id)
        document["symbol"]["fill"]["opacity"] = 0.2
        _save(state, 31, document)

    services = _Services(state, core=_slow(state, lands=True, between=person))
    result = await _run(services, layer_project_id=31, operations=[RED, QUANTILES])
    stored = state.styles[style_id].document
    assert stored["symbol"]["fill"]["opacity"] == 0.2
    assert [item["field"] for item in stored["classify"]] == ["density"]
    assert (result.revision_before, result.revision_after) == (1, 3)
    assert result.incomplete is None and result.added == {"1": "density"}
    assert result.undo() is not None


@pytest.mark.parametrize("status", [502, 503, 504])
async def test_a_save_behind_a_gateway_error_is_read_back(status: int) -> None:
    state = MapState()
    services = _Services(state, core=_slow(state, lands=True, gateway=status))
    result = await _run(services, layer_project_id=31, operations=[RED])
    assert (result.revision_before, result.revision_after) == (1, 2)
    assert result.undo() is not None

    state = MapState()
    services = _Services(state, core=_slow(state, lands=False, gateway=status))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, layer_project_id=31, operations=[RED])
    assert raised.value.message == SAVE_UNKNOWN


async def test_a_save_without_an_answer_and_no_read_after_it_says_it_is_not_known() -> (
    None
):
    state = MapState()
    services = _Services(state, core=_slow(state, lands=True, readable=False))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, layer_project_id=31, operations=[RED])
    assert raised.value.message == SAVE_UNKNOWN
    assert "may have" in SAVE_UNKNOWN and "style_get" in SAVE_UNKNOWN


async def test_a_created_styles_save_without_an_answer_is_read_back_too() -> None:
    state = MapState()
    active = state.active_style_id(31)
    new = {"name": "Density", "asked": "as a new style", "start": "current"}
    services = _Services(state, core=_slow(state, lands=True))
    landed = await _run(
        services, layer_project_id=31, new_style=new, operations=[QUANTILES]
    )
    assert (landed.revision_after, landed.incomplete) == (2, None)
    assert landed.made_active and state.active_style_id(31) == landed.style_id
    assert landed.undo() == {
        "kind": "style_created",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": landed.style_id,
        "revision": 2,
        "active_before": active,
    }

    state = MapState()
    services = _Services(state, core=_slow(state, lands=False))
    lost = await _run(
        services, layer_project_id=31, new_style=new, operations=[QUANTILES]
    )
    assert lost.was_created and lost.revision_after == 1
    assert lost.incomplete == CREATED_SAVE_UNKNOWN

    state = MapState()
    services = _Services(state, core=_slow(state, lands=True, readable=False))
    unknown = await _run(
        services, layer_project_id=31, new_style=new, operations=[QUANTILES]
    )
    assert unknown.was_created and unknown.incomplete == CREATED_SAVE_UNKNOWN
    assert unknown.made_active is False
    undo = unknown.undo()
    assert undo is not None and undo["kind"] == "style_created"


async def test_a_save_answered_without_its_revision_is_read_back() -> None:
    state = MapState()

    def bare(request: httpx.Request, response: httpx.Response) -> httpx.Response | None:
        if request.method == "PUT":
            return httpx.Response(200, json={"id": "x"})
        return None

    services = _Services(state, core=_answering(state, bare))
    result = await _run(services, layer_project_id=31, operations=[RED])
    assert (result.revision_before, result.revision_after) == (1, 2)
    assert result.undo() is not None

    # A created style whose save core answered so, and did not store: the
    # read cannot tell whether core is still saving.
    state = MapState()
    core = map_core(state)

    def unsaved(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            return httpx.Response(200, json={"id": "x"})
        response = core.answer(request)
        assert response is not None
        return response

    services = _Services(state, core=_Proxy(unsaved))
    result = await _run(
        services,
        layer_project_id=31,
        new_style={"name": "Density", "asked": "as a new style", "start": "current"},
        operations=[QUANTILES],
    )
    assert result.incomplete == CREATED_SAVE_UNKNOWN


# ---- more classifications than are counted ---------------------------------------


async def test_more_than_three_classifications_say_where_to_read_the_others() -> None:
    state = MapState()
    services = _Services(state)
    document = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {
            "fill": {"color": "#cccccc", "opacity": 0.8},
            "outline": {"color": "#000000", "width": 1, "opacity": 1},
        },
        "classify": [
            {
                "field": "density",
                "method": "quantile",
                "count": 3,
                "palette": p,
                "target": t,
            }
            for p, t in (
                ("colorbrewer:OrRd", "fill.color"),
                ("colorbrewer:Blues", "outline.color"),
                ("colorbrewer:Greens", "fill.opacity"),
                ("colorbrewer:Purples", "outline.width"),
            )
        ],
    }
    document["classify"][2].pop("palette")
    document["classify"][2]["range"] = [0.2, 1]
    document["classify"][3].pop("palette")
    document["classify"][3]["range"] = [1, 4]
    result = await _update(
        services,
        layer_project_id=31,
        new_style={"name": "Four", "asked": "as a new style"},
        document=document,
    )
    assert len(result["legend"]) == 3
    assert result["legend_note"] == (
        "Legend numbers are given for the first 3 classifications; read the "
        "others with style_get."
    )
    assert "part" not in result["legend_note"]


# ---- a new style needs the user's words ------------------------------------------

ASKED = "as a new style"


def _typed(services: _Services, *texts: str) -> None:
    """What the user typed in the conversation, as a run fills it."""
    services.env.typed = texts


async def test_a_new_style_quoting_the_users_words_is_created() -> None:
    state = MapState()
    services = _Services(state)
    _typed(
        services, "Hello", "Color the districts by density,\n  AS A   new style please."
    )
    result = await _update(
        services,
        layer_project_id=31,
        new_style={"name": "Density", "start": "current", "asked": "As a new style"},
        operations=[QUANTILES],
    )
    assert result["created"] is True
    # Typed card answers count as the user's words as well.
    _typed(services, "Color the districts.", "keep the current one and add a second")
    result = await _update(
        services,
        layer_project_id=31,
        new_style={
            "name": "Second",
            "start": "current",
            "asked": "“add a second”",
        },
        operations=[RED],
    )
    assert result["created"] is True


@pytest.mark.parametrize(
    "asked", ["give me two options", "new style", "a", "  as  ", "as a new style."]
)
async def test_a_new_style_without_the_users_words_is_refused_before_any_write(
    asked: str,
) -> None:
    state = MapState()
    services = _Services(state)
    _typed(services, "can we improve styling for this layer", "a")
    with pytest.raises(ToolFailed) as refused:
        await _run(
            services,
            layer_project_id=31,
            new_style={"name": "Better", "start": "current", "asked": asked},
            operations=[RED],
        )
    assert refused.value.message == ASKED_NOT_SAID
    assert ASKED_NOT_SAID == (
        "new_style.asked must quote the user's own words exactly as typed, and "
        "these are not in the conversation. If the user asked for a new style or "
        "for options, send the call again with their exact words; if not, edit "
        "the active style in place: send the operations without new_style."
    )
    assert services.core.requests == [] and services.writes() == []


async def test_without_the_conversations_text_only_the_length_is_checked() -> None:
    """Unit tests and callers that give no conversation leave typed None."""
    state = MapState()
    services = _Services(state)
    assert services.env.typed is None
    result = await _update(
        services,
        layer_project_id=31,
        new_style={"name": "Density", "start": "current", "asked": "anything long"},
        operations=[QUANTILES],
    )
    assert result["created"] is True
    with pytest.raises(ToolFailed, match="exactly as typed"):
        await _run(
            services,
            layer_project_id=31,
            new_style={"name": "Short", "start": "current", "asked": "new"},
            operations=[RED],
        )


@pytest.mark.parametrize(
    ("typed", "asked"),
    [
        ("Save it as a new style, please.", "as a new-style"),
        ("Save it as a new-style, please.", "as a new style"),
        ('Call it "Density" and keep the current one!', "Density, and keep"),
        ("Keep the user's own look as well", "the user’s own look"),
        ("Bitte als neuen Stil für die Bezirke", "Stil fu\u0308r die Bezirke"),
        ("Bitte als neuen Stil fu\u0308r die Bezirke", "Stil für die Bezirke"),
    ],
)
async def test_a_quote_differing_only_outside_its_letters_and_digits_passes(
    typed: str, asked: str
) -> None:
    services = _Services(MapState())
    _typed(services, typed)
    result = await _update(
        services,
        layer_project_id=31,
        new_style={"name": "Copy", "start": "current", "asked": asked},
    )
    assert result["created"] is True


@pytest.mark.parametrize(
    ("typed", "asked"),
    [
        # A typo the model corrected, a word form it changed, a dropped word.
        ("give me two optoins for the districts", "two options"),
        ("show me alternative looks", "alternatives looks"),
        ("save it as a new style", "save as a new style"),
        # Part of a word is no quote of the user's words.
        ("add a second style", "dd a second sty"),
        # Fewer than six letters and digits, whatever surrounds them.
        ("a new style", "- n-e-w -"),
    ],
)
async def test_a_quote_that_changes_the_users_words_is_refused(
    typed: str, asked: str
) -> None:
    services = _Services(MapState())
    _typed(services, typed)
    with pytest.raises(ToolFailed) as refused:
        await _run(
            services,
            layer_project_id=31,
            new_style={"name": "Copy", "start": "current", "asked": asked},
        )
    assert refused.value.message == ASKED_NOT_SAID
    assert services.core.requests == []


def test_asked_is_required_and_described_for_the_model() -> None:
    schema = UPDATE_STYLE.json_schema()["$defs"]["NewStyle"]
    assert "asked" in schema["required"]
    described = " ".join(schema["properties"]["asked"]["description"].split())
    assert described == (
        "The user's words that ask for a new style or for options, word for "
        "word and exactly as typed, typos included, in their language. Without "
        "such words do not create a style: edit the active one in place."
    )
    with pytest.raises(ValidationError, match="asked"):
        StyleUpdateInput.model_validate(
            {"layer_project_id": 31, "new_style": {"name": "B", "start": "current"}}
        )
    # Over MCP there is no style tool, so the conversation is always known
    # where style_update runs.
    assert not UPDATE_STYLE.mcp


# ---- the skill is read before a change -------------------------------------------


async def test_the_first_change_without_the_skill_says_to_load_it_once() -> None:
    state = MapState()
    services = _Services(state)
    services.env.skills = set()
    first = await _update(services, layer_project_id=31, operations=[RED])
    assert first["note"] == SKILL_BEFORE_NEXT
    assert SKILL_BEFORE_NEXT == (
        "Load the skill style-a-map with skills_load before the next change: it "
        "holds the forms and the rules."
    )
    second = await _update(
        services,
        layer_project_id=31,
        operations=[{"op": "set", "path": "/opacity", "value": 0.7}],
    )
    assert "note" not in second


@pytest.mark.parametrize("skills", [None, {"style-a-map"}])
async def test_with_the_skill_or_without_a_conversation_no_note(
    skills: set[str] | None,
) -> None:
    state = MapState()
    services = _Services(state)
    services.env.skills = skills
    result = await _update(services, layer_project_id=31, operations=[RED])
    assert "note" not in result
