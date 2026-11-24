"""The dock's Undo of an answer's style changes: an edited style gets the
document, the name and the layer's active style it had before the answer, a
style the answer created is removed, and nothing a person saved afterwards is
written over without asking.

The undo records are the ones the real ``style_update`` leaves, and core is
the eval stand-in of the map project, which saves as core does (merge on the
kept revisions, checks against the data, ``base_too_old``)."""

import asyncio
import copy
import json
from collections.abc import Callable, Iterator
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from goatlib.style.compute import without_stamps
from pydantic_ai.exceptions import ToolFailed

from assistant import undo as undo_module
from assistant.asks import AskHistory
from assistant.repo import Repository
from assistant.routers import conversations
from assistant.tools.http import ServiceError
from assistant.tools.runtime import execute
from assistant.tools.styles import UPDATE_STYLE
from assistant.tools.testing import Recorder, ScriptedModel, fake_clients
from assistant.undo import (
    NothingToUndo,
    UndoOutcome,
    UndoRefused,
    undo_groups,
    undo_run,
    undone,
)
from assistant.undo_styles import (
    KEPT_REVISIONS,
    ChangedStyle,
    CreatedStyle,
    RestoredStyle,
    StyleEdits,
    UnrestoredStyle,
    remove_created,
    restore_style,
    style_groups,
)
from evals import map_backends
from evals.backends import Backends, write_eval_catalog
from evals.graders import grade
from evals.harness import AuditRows, press_undo, run_task
from evals.map_backends import MapState, map_core
from evals.map_fixture import MAP_PROJECT_ID
from evals.map_graders import _looks
from evals.tasks import load_tasks
from tests.test_style_get import _Proxy, _quantile_districts
from tests.test_style_update import _picked, _run, _Services
from tests.test_undo import (
    Core,
    Stored,
    answer,
    config,
    stored_answer,
    url,
)
from tests.test_undo import edit as workflow_edit

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
Api = Any  # conftest.ApiFactory
ProjectFactory = Any  # conftest.ProjectFactory
Document = dict[str, Any]

RED = {"op": "set", "path": "/symbol/fill/color", "value": "#ff0000"}
FAINT = {"op": "set", "path": "/symbol/fill/opacity", "value": 0.2}
BLUES = {"op": "set", "path": "/classify/density/palette", "value": "colorbrewer:Blues"}
BY_POPULATION = {"op": "set", "path": "/classify/density/field", "value": "population"}
SQUARES = {
    "version": "1.0.0",
    "kind": "vector",
    "symbol": {"marker": {"shape": "square", "color": "#123456", "size": 8}},
}


async def _styled(
    state: MapState, asks: AskHistory | None = None, **args: Any
) -> dict[str, Any]:
    """The undo record the real ``style_update`` leaves for a call, as the
    audit row holds it."""
    result = await _run(_Services(state, asks=asks), **args)
    record = result.undo()
    assert record is not None, result
    stored: dict[str, Any] = json.loads(json.dumps(record))
    return stored


def _rows(*records: dict[str, Any]) -> list[tuple[UUID, dict[str, Any]]]:
    return [(uuid4(), record) for record in records]


def _edits(*records: dict[str, Any]) -> StyleEdits:
    [edits], created = style_groups(_rows(*records))
    assert created == []
    return edits


def _created(*records: dict[str, Any]) -> CreatedStyle:
    edits, [created] = style_groups(_rows(*records))
    assert edits == []
    return created


def _document(state: MapState, style_id: str) -> Document:
    return copy.deepcopy(state.styles[style_id].document)


def _user_saves(
    state: MapState, style_id: str, change: Callable[[Document], Any]
) -> None:
    """A person's save of a style through core's route, on the revision it has."""
    style = state.styles[style_id]
    document = _document(state, style_id)
    change(document)
    request = httpx.Request(
        "PUT",
        f"http://core{BASE}/layer/{style.layer_project_id}/style/{style_id}",
        json={"base_rev": style.revision, "document": document},
    )
    revision = style.revision
    response = map_core(state).answer(request)
    assert response is not None and response.status_code == 200, response
    assert state.styles[style_id].revision == revision + 1


def _opacity(value: float) -> Callable[[Document], Any]:
    def change(document: Document) -> None:
        document["symbol"]["fill"]["opacity"] = value

    return change


def _writes(core: Recorder) -> list[tuple[str, str, Any]]:
    """Core's writes of styles and map state: (method, path after ``/layer/``, body)."""
    return [
        (
            request.method,
            request.url.path.split("/layer/", 1)[1],
            json.loads(request.content) if request.content else None,
        )
        for request in core.requests
        if request.method != "GET" and "/layer/" in request.url.path
    ]


def _second_style(state: MapState, link: int, name: str = "Old look") -> str:
    """Another named style of the layer, a copy of the one the map draws."""
    document = _document(state, state.active_style_id(link))
    return state.add_style(link, name, document).id


async def _audit(*records: dict[str, Any]) -> tuple[AuditRows, UUID]:
    """An answer's audit rows in memory, as the eval harness keeps them."""
    audit, run_id = AuditRows(), uuid4()
    for record in records:
        await audit.insert_tool_call(run_id=run_id, undo=record)
    return audit, run_id


async def _undo(
    audit: AuditRows, core: Any, run_id: UUID, *, force: bool = False
) -> UndoOutcome:
    return await undo_run(
        cast(Repository, audit), fake_clients(core=core), None, run_id, force=force
    )


# ---- the groups of an answer ---------------------------------------------------------


def _record(before: int, after: int, **more: Any) -> dict[str, Any]:
    return {
        "kind": "style",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": "s-1",
        "revision_before": before,
        "revision_after": after,
        "before": {"document": {"at": before}, "name": f"Name at {before}"},
        **more,
    }


def _made(style_id: str, revision: int, active_before: str | None) -> dict[str, Any]:
    return {
        "kind": "style_created",
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": 31,
        "style_id": style_id,
        "revision": revision,
        "active_before": active_before,
    }


def test_a_styles_edits_are_one_group_from_the_oldest_document_to_the_newest_revision() -> (
    None
):
    rows = _rows(_record(5, 6), _record(4, 5), {"kind": "workflow"})
    [edits], created = style_groups(rows)
    assert created == []
    assert edits == StyleEdits(
        project_id=MAP_PROJECT_ID,
        layer_project_id=31,
        style_id="s-1",
        rows=[rows[1][0], rows[0][0]],
        before={"at": 4},
        name_before=None,
        revision=6,
        chained=True,
        undone=False,
        moved=True,
        active_before=None,
        renamed_to=None,
    )
    # The answer renamed the style twice: back from the newest name to the
    # one before the first rename. An edit in place names no rename.
    renamed = _edits(
        _record(6, 7, renamed_to="Third"), _record(4, 5), _record(5, 6, renamed_to="B")
    )
    assert (renamed.name_before, renamed.renamed_to) == ("Name at 5", "Third")
    # A rename or a switch alone moves no revision and breaks no chain.
    assert _edits(_record(4, 5), _record(5, 5), _record(5, 6)).chained
    # A save between two edits, and one that landed within a call.
    assert not _edits(_record(4, 5), _record(6, 7)).chained
    assert not _edits(_record(4, 6)).chained
    # Nothing saved: only the name or the active style is taken back.
    alone = _edits(_record(4, 4, active_before="s-0"))
    assert (alone.moved, alone.chained, alone.active_before) == (False, True, "s-0")
    done = _edits({**_record(4, 5), "undone_at": "2026-11-23T10:00:00+00:00"})
    assert done.undone


def test_records_without_what_an_undo_needs_are_left_out() -> None:
    broken = [
        {**_record(4, 5), "before": None},
        {**_record(4, 5), "before": {"name": "A"}},
        {**_record(4, 5), "revision_after": None},
        {**_record(4, 5), "layer_project_id": "31"},
        {**_made("s-2", 2, None), "revision": None},
        {"kind": "map", "project_id": MAP_PROJECT_ID, "changes": []},
    ]
    assert style_groups(_rows(*broken)) == ([], [])


def test_a_style_created_and_edited_by_the_answer_is_one_created_group() -> None:
    rows = _rows(
        _made("s-9", 2, "s-0"),
        {**_record(2, 3), "style_id": "s-9"},
        _record(4, 5),
    )
    [edits], [created] = style_groups(rows)
    assert edits.style_id == "s-1" and edits.rows == [rows[2][0]]
    assert created == CreatedStyle(
        project_id=MAP_PROJECT_ID,
        layer_project_id=31,
        style_id="s-9",
        rows=[rows[0][0], rows[1][0]],
        revision=3,
        active_before="s-0",
        undone=False,
        chained=True,
    )
    # A save between the creation and the answer's edit of it.
    broken = _created(_made("s-9", 2, None), {**_record(3, 4), "style_id": "s-9"})
    assert not broken.chained and broken.revision == 4


def test_the_style_to_go_back_to_is_the_one_drawn_before_the_answer() -> None:
    """Two new styles and a switch in one answer: each goes back to the style
    the map drew before the answer, whichever is taken back first."""
    edits, created = style_groups(
        _rows(
            _made("new-1", 2, "s-0"),
            _made("new-2", 2, "new-1"),
            _record(4, 4, active_before="new-2"),
        )
    )
    assert [item.active_before for item in created] == ["s-0", "s-0"]
    assert [item.active_before for item in edits] == ["s-0"]
    # Two switches among styles that existed: s-0 to s-1, then s-1 to s-2.
    there = {**_record(4, 4, active_before="s-0")}
    on = {**_record(7, 7, active_before="s-1"), "style_id": "s-2"}
    edits, _ = style_groups(_rows(there, on))
    assert [(e.style_id, e.active_before) for e in edits] == [
        ("s-1", "s-0"),
        ("s-2", "s-0"),
    ]
    # There and back again: the layer already draws what it drew before.
    back = {**_record(7, 7, active_before="s-1"), "style_id": "s-0"}
    edits, _ = style_groups(_rows(there, back))
    assert [(e.style_id, e.active_before) for e in edits] == [
        ("s-1", "s-0"),
        ("s-0", "s-0"),
    ]


# ---- an edited style -----------------------------------------------------------------


async def test_two_chained_edits_of_one_style_are_one_save_of_the_oldest_document_on_the_newest_revision() -> (
    None
):
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    first = await _styled(state, layer_project_id=31, operations=[RED])
    second = await _styled(state, layer_project_id=31, operations=[FAINT])
    edits = _edits(second, first)
    assert (edits.revision, edits.chained, edits.before) == (3, True, before)

    core = map_core(state)
    restored = await restore_style(fake_clients(core=core), None, edits, False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 4)
    # A save per edit, newest first, would write the first edit's look again.
    assert _writes(core) == [
        ("PUT", f"31/style/{style_id}", {"base_rev": 3, "document": before})
    ]
    assert without_stamps(state.styles[style_id].document) == without_stamps(before)


async def test_merge_takes_back_the_answers_paths_and_keeps_a_later_save_on_other_paths() -> (
    None
):
    state = MapState()
    _quantile_districts(state)
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    edits = _edits(await _styled(state, layer_project_id=31, operations=[BLUES]))
    changed = _document(state, style_id)["classify"][0]
    assert changed["palette"] == "colorbrewer:Blues"
    assert changed["classes"] != before["classify"][0]["classes"]
    # A person makes the fill fainter after the answer.
    _user_saves(state, style_id, _opacity(0.3))

    core = map_core(state)
    restored = await restore_style(fake_clients(core=core), None, edits, True)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 5)
    # The document before, on the revision the answer left: core takes back
    # what the answer changed and nothing else.
    assert _writes(core) == [
        ("PUT", f"31/style/{style_id}", {"base_rev": 3, "document": before})
    ]
    stored = state.styles[style_id].document
    assert stored["classify"][0]["palette"] == "colorbrewer:OrRd"
    assert [c["fill"] for c in stored["classify"][0]["classes"]] == [
        c["fill"] for c in before["classify"][0]["classes"]
    ]
    assert stored["symbol"]["fill"]["opacity"] == 0.3


async def test_a_class_color_the_answer_set_goes_back_too() -> None:
    """Colors of a computed classification's classes are values a save
    writes, unlike its limits: they are restored as any other value."""
    state = MapState()
    _quantile_districts(state)
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    black = {
        "op": "set",
        "path": "/classify/density/classes/c1/fill/color",
        "value": "#000000",
    }
    edits = _edits(await _styled(state, layer_project_id=31, operations=[black]))
    core = map_core(state)
    restored = await restore_style(fake_clients(core=core), None, edits, False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 4)
    assert len(_writes(core)) == 1
    classes = state.styles[style_id].document["classify"][0]["classes"]
    assert classes[0]["fill"] == before["classify"][0]["classes"][0]["fill"]


async def test_a_save_after_the_answer_asks_first() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    edits = _edits(await _styled(state, layer_project_id=31, operations=[RED]))
    _user_saves(state, style_id, _opacity(0.3))
    core = map_core(state)
    asked = await restore_style(fake_clients(core=core), None, edits, False)
    assert asked == ChangedStyle(
        MAP_PROJECT_ID, 31, style_id, 3, between=False, too_old=False
    )
    assert _writes(core) == []
    assert state.styles[style_id].document["symbol"]["fill"]["color"] == "#ff0000"


async def test_a_save_between_two_edits_asks_first_with_between() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    first = await _styled(state, layer_project_id=31, operations=[RED])
    _user_saves(state, style_id, _opacity(0.3))
    second = await _styled(state, layer_project_id=31, operations=[FAINT])
    edits = _edits(first, second)
    assert not edits.chained and edits.revision == 4
    core = map_core(state)
    clients = fake_clients(core=core)
    asked = await restore_style(clients, None, edits, False)
    assert asked == ChangedStyle(MAP_PROJECT_ID, 31, style_id, 4, between=True)
    assert _writes(core) == []
    # "Undo anyway" takes the save in between back too.
    forced = await restore_style(clients, None, edits, True)
    assert forced == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 5)
    assert _writes(core) == [
        ("PUT", f"31/style/{style_id}", {"base_rev": 4, "document": before})
    ]
    assert without_stamps(state.styles[style_id].document) == without_stamps(before)


async def test_base_too_old_asks_and_force_restores_on_the_current_revision() -> None:
    assert KEPT_REVISIONS == map_backends.KEPT_REVISIONS
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    edits = _edits(await _styled(state, layer_project_id=31, operations=[RED]))
    # Core still keeps the answer's revision: a save after it, as any other.
    for n in range(KEPT_REVISIONS - 1):
        _user_saves(state, style_id, _opacity(0.1 + n / 100))
    core = map_core(state)
    clients = fake_clients(core=core)
    kept = await restore_style(clients, None, edits, False)
    assert isinstance(kept, ChangedStyle) and not kept.too_old
    # One save more, and core has dropped it.
    _user_saves(state, style_id, _opacity(0.9))
    current = state.styles[style_id].revision
    assert current == edits.revision + KEPT_REVISIONS
    asked = await restore_style(clients, None, edits, False)
    assert asked == ChangedStyle(MAP_PROJECT_ID, 31, style_id, current, too_old=True)
    assert _writes(core) == []

    forced = await restore_style(clients, None, edits, True)
    assert forced == RestoredStyle(MAP_PROJECT_ID, 31, style_id, current + 1)
    # Core says that the revision is too old, never the count here: the
    # document then goes on the current revision, which restores it whole.
    assert _writes(core) == [
        ("PUT", f"31/style/{style_id}", {"base_rev": 2, "document": before}),
        ("PUT", f"31/style/{style_id}", {"base_rev": current, "document": before}),
    ]
    assert without_stamps(state.styles[style_id].document) == without_stamps(before)


async def test_a_deleted_style_and_a_removed_layer_count_as_nothing_left() -> None:
    state = MapState()
    other = _second_style(state, 31)
    edits = _edits(
        await _styled(state, layer_project_id=31, style_id=other, operations=[RED])
    )
    made = _created(
        await _styled(
            state,
            layer_project_id=31,
            new_style={"name": "New", "asked": "as a new style", "start": "current"},
        )
    )
    # The edited style was deleted in the style list.
    del state.styles[other]
    core = map_core(state)
    clients = fake_clients(core=core)
    assert await restore_style(clients, None, edits, False) is None
    # The layer left the project, and its styles with it.
    state.remove_layer(31)
    assert await restore_style(clients, None, edits, True) is None
    assert await remove_created(clients, None, made, False) is None
    assert _writes(core) == []


async def test_a_replace_gets_its_old_name_back() -> None:
    state = MapState()
    active = state.active_style_id(32)
    other = _second_style(state, 32)
    before = _document(state, other)
    record = await _styled(
        state,
        _picked(f"replace_style:{other}"),
        layer_project_id=32,
        style_id=other,
        document=SQUARES,
        name="Squares",
    )
    assert record["before"]["name"] == "Old look" and record["active_before"] == active
    assert record["renamed_to"] == "Squares"
    assert state.styles[other].name == "Squares"
    assert state.layers[32]["active_style_id"] == other

    core = map_core(state)
    restored = await restore_style(fake_clients(core=core), None, _edits(record), False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 32, other, 3)
    assert _writes(core) == [
        ("PUT", f"32/style/{other}", {"base_rev": 2, "document": before}),
        ("PATCH", f"32/style/{other}", {"name": "Old look"}),
        ("PATCH", "32/map-state", {"active_style_id": active}),
    ]
    assert state.styles[other].name == "Old look"
    assert without_stamps(state.styles[other].document) == without_stamps(before)
    assert state.layers[32]["active_style_id"] == active


async def test_a_name_the_user_gave_after_an_edit_in_place_stays() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    record = await _styled(state, layer_project_id=31, operations=[RED])
    assert "renamed_to" not in record and record["before"]["name"] == "Default"
    # A rename moves no revision: nothing tells the Undo but the record.
    state.styles[style_id].name = "Districts, red"
    core = map_core(state)
    restored = await restore_style(fake_clients(core=core), None, _edits(record), False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 3)
    assert _writes(core) == [
        ("PUT", f"31/style/{style_id}", {"base_rev": 2, "document": before})
    ]
    assert state.styles[style_id].name == "Districts, red"
    assert without_stamps(state.styles[style_id].document) == without_stamps(before)


async def test_a_name_the_user_gave_after_a_replace_stays_also_with_force() -> None:
    for force in (False, True):
        state = MapState()
        other = _second_style(state, 32)
        before = _document(state, other)
        record = await _styled(
            state,
            _picked(f"replace_style:{other}"),
            layer_project_id=32,
            style_id=other,
            document=SQUARES,
            name="Squares",
            make_active=False,
        )
        assert record["renamed_to"] == "Squares"
        state.styles[other].name = "My squares"
        core = map_core(state)
        restored = await restore_style(
            fake_clients(core=core), None, _edits(record), force
        )
        assert restored == RestoredStyle(MAP_PROJECT_ID, 32, other, 3)
        # The document goes back; the name is the user's by now.
        assert _writes(core) == [
            ("PUT", f"32/style/{other}", {"base_rev": 2, "document": before})
        ]
        assert state.styles[other].name == "My squares"


async def test_a_switch_alone_goes_back_without_a_save_and_never_asks() -> None:
    state = MapState()
    active = state.active_style_id(31)
    other = _second_style(state, 31)
    same = {"op": "set", "path": "/symbol/fill/color", "value": "#deebf7"}
    record = await _styled(
        state, layer_project_id=31, style_id=other, operations=[same], make_active=True
    )
    assert record["revision_before"] == record["revision_after"] == 1
    assert record["active_before"] == active
    # A person edits the style afterwards: its document is not the Undo's.
    _user_saves(state, other, _opacity(0.3))
    core = map_core(state)
    clients = fake_clients(core=core)
    restored = await restore_style(clients, None, _edits(record), False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 31, other, 2)
    assert _writes(core) == [("PATCH", "31/map-state", {"active_style_id": active})]
    assert state.styles[other].document["symbol"]["fill"]["opacity"] == 0.3

    # The user switched to a third style by now: the layer stays on it.
    third = _second_style(state, 31, "Third")
    state.layers[31]["active_style_id"] = third
    core.requests.clear()
    assert await restore_style(clients, None, _edits(record), False) == restored
    assert _writes(core) == []
    assert state.layers[31]["active_style_id"] == third


async def test_a_failed_switch_back_is_no_failed_undo() -> None:
    state = MapState()
    other = _second_style(state, 32)
    record = await _styled(
        state,
        _picked(f"replace_style:{other}"),
        layer_project_id=32,
        style_id=other,
        document=SQUARES,
    )
    inner = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/map-state"):
            return httpx.Response(503, json={"detail": "down"})
        response = inner.answer(request)
        assert response is not None
        return response

    core = _Proxy(handler)
    restored = await restore_style(fake_clients(core=core), None, _edits(record), False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 32, other, 3)
    assert state.layers[32]["active_style_id"] == other


def _timing_out(state: MapState, *, landed: bool) -> _Proxy:
    """Core whose answer to a style save never comes, written or not."""
    inner = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and "/style/" in request.url.path:
            if landed:
                inner.answer(request)
            raise httpx.ReadTimeout("no answer", request=request)
        response = inner.answer(request)
        assert response is not None
        return response

    return _Proxy(handler)


async def test_a_restore_whose_answer_timed_out_counts_when_it_landed() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    edits = _edits(await _styled(state, layer_project_id=31, operations=[RED]))
    clients = fake_clients(core=_timing_out(state, landed=True))
    restored = await restore_style(clients, None, edits, False)
    assert restored == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 3)
    assert without_stamps(state.styles[style_id].document) == without_stamps(before)

    state = MapState()
    style_id = state.active_style_id(31)
    edits = _edits(await _styled(state, layer_project_id=31, operations=[RED]))
    core = _timing_out(state, landed=False)
    with pytest.raises(ToolFailed) as raised:
        await restore_style(fake_clients(core=core), None, edits, False)
    assert not isinstance(raised.value, ServiceError)
    assert state.styles[style_id].revision == 2
    # Tried again once core answers: the style is as the answer left it.
    again = await restore_style(fake_clients(core=map_core(state)), None, edits, False)
    assert again == RestoredStyle(MAP_PROJECT_ID, 31, style_id, 3)


async def test_a_restore_that_landed_but_was_not_finished_is_finished_without_asking() -> (
    None
):
    """The save landed and the rename after it failed: the next Undo finds
    the document as it was before the answer, on a revision the answer never
    saw, and goes on where the first one stopped."""
    state = MapState()
    other = _second_style(state, 32)
    record = await _styled(
        state,
        _picked(f"replace_style:{other}"),
        layer_project_id=32,
        style_id=other,
        document=SQUARES,
        name="Squares",
        make_active=False,
    )
    inner = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PATCH" and "/style/" in request.url.path:
            return httpx.Response(503, json={"detail": "down"})
        response = inner.answer(request)
        assert response is not None
        return response

    with pytest.raises(ServiceError):
        await restore_style(
            fake_clients(core=_Proxy(handler)), None, _edits(record), False
        )
    assert (state.styles[other].revision, state.styles[other].name) == (3, "Squares")
    core = map_core(state)
    again = await restore_style(fake_clients(core=core), None, _edits(record), False)
    assert again == RestoredStyle(MAP_PROJECT_ID, 32, other, 3)
    assert _writes(core) == [("PATCH", f"32/style/{other}", {"name": "Old look"})]
    assert state.styles[other].name == "Old look"


# ---- a created style -----------------------------------------------------------------


async def test_a_created_style_is_deleted_and_the_active_style_put_back() -> None:
    state = MapState()
    # The map drew the layer's second style: deleting the active style alone
    # would hand over to the first.
    drawn = _second_style(state, 35, "Drawn")
    state.layers[35]["active_style_id"] = drawn
    before = state.snapshot()
    record = await _styled(
        state,
        layer_project_id=35,
        new_style={"name": "Turnout", "asked": "as a new style", "start": "current"},
        operations=[{"op": "set", "path": "/symbol/marker/color", "value": "#00ff00"}],
    )
    made = _created(record)
    assert made.active_before == drawn and made.revision == 2
    assert state.layers[35]["active_style_id"] == made.style_id

    core = map_core(state)
    removed = await remove_created(fake_clients(core=core), None, made, False)
    assert removed == RestoredStyle(
        MAP_PROJECT_ID, 35, made.style_id, None, removed=True
    )
    assert _writes(core) == [
        ("PATCH", "35/map-state", {"active_style_id": drawn}),
        ("DELETE", f"35/style/{made.style_id}", None),
    ]
    assert state.snapshot() == before


async def test_a_created_style_the_user_switched_away_from_is_deleted_without_a_switch() -> (
    None
):
    state = MapState()
    default = state.active_style_id(35)
    made = _created(
        await _styled(
            state,
            layer_project_id=35,
            new_style={"name": "New", "asked": "as a new style", "start": "current"},
        )
    )
    state.layers[35]["active_style_id"] = default
    core = map_core(state)
    removed = await remove_created(fake_clients(core=core), None, made, False)
    assert isinstance(removed, RestoredStyle) and removed.removed
    assert _writes(core) == [("DELETE", f"35/style/{made.style_id}", None)]
    assert state.layers[35]["active_style_id"] == default


async def test_a_created_style_the_user_edited_asks_first() -> None:
    state = MapState()
    default = state.active_style_id(35)
    record = await _styled(
        state,
        layer_project_id=35,
        new_style={"name": "New", "asked": "as a new style", "start": "current"},
    )
    made = _created(record)

    def bigger(document: Document) -> None:
        document["symbol"]["marker"]["size"] = 14

    _user_saves(state, made.style_id, bigger)
    core = map_core(state)
    clients = fake_clients(core=core)
    asked = await remove_created(clients, None, made, False)
    assert asked == ChangedStyle(MAP_PROJECT_ID, 35, made.style_id, 2)
    assert _writes(core) == [] and made.style_id in state.styles

    forced = await remove_created(clients, None, made, True)
    assert isinstance(forced, RestoredStyle) and forced.removed
    assert made.style_id not in state.styles
    assert state.layers[35]["active_style_id"] == default


async def test_a_delete_whose_answer_timed_out_counts_when_the_style_is_gone() -> None:
    def timing_out(state: MapState, *, landed: bool) -> _Proxy:
        inner = map_core(state)

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "DELETE":
                if landed:
                    inner.answer(request)
                raise httpx.ReadTimeout("no answer", request=request)
            response = inner.answer(request)
            assert response is not None
            return response

        return _Proxy(handler)

    for landed in (True, False):
        state = MapState()
        made = _created(
            await _styled(
                state,
                layer_project_id=35,
                new_style={
                    "name": "New",
                    "asked": "as a new style",
                    "start": "current",
                },
            )
        )
        clients = fake_clients(core=timing_out(state, landed=landed))
        if landed:
            removed = await remove_created(clients, None, made, False)
            assert isinstance(removed, RestoredStyle) and removed.removed
            assert made.style_id not in state.styles
        else:
            with pytest.raises(ToolFailed):
                await remove_created(clients, None, made, False)
            assert made.style_id in state.styles


async def test_a_created_style_that_is_the_layers_last_stays() -> None:
    state = MapState()
    default = state.active_style_id(35)
    made = _created(
        await _styled(
            state,
            layer_project_id=35,
            new_style={"name": "New", "asked": "as a new style", "start": "current"},
        )
    )
    # The user deleted the style the layer had before.
    del state.styles[default]
    clients = fake_clients(core=map_core(state))
    asked = await remove_created(clients, None, made, False)
    assert asked == ChangedStyle(MAP_PROJECT_ID, 35, made.style_id, 1)
    # Asking again would not help: said as not restored.
    forced = await remove_created(clients, None, made, True)
    assert forced == UnrestoredStyle(MAP_PROJECT_ID, 35, made.style_id)
    assert made.style_id in state.styles


# ---- what core stored decides --------------------------------------------------------


async def _reclassified(
    state: MapState, *operations: dict[str, Any]
) -> tuple[str, Document, dict[str, Any]]:
    """Districts classified by density, then an answer's edit of it: the
    style, its document before the edit and the edit's undo record."""
    _quantile_districts(state)
    style_id = state.active_style_id(31)
    before = _document(state, style_id)
    record = await _styled(state, layer_project_id=31, operations=list(operations))
    return style_id, before, record


def _drop_density(state: MapState) -> None:
    """The dataset loses the field the style read before the answer."""
    state.connection().execute("ALTER TABLE layer_31 DROP COLUMN density")


async def test_a_restore_core_did_not_store_is_not_reported_as_undone() -> None:
    state = MapState()
    style_id, _, record = await _reclassified(state, BY_POPULATION)
    _drop_density(state)
    audit, run_id = await _audit(record)
    core = map_core(state)
    outcome = await _undo(audit, core, run_id)
    assert outcome.styles == [] and outcome.changed_styles == []
    assert outcome.not_restored == ["style"]
    # Core kept what it had: the style still reads the answer's field.
    assert len(_writes(core)) == 1
    assert state.styles[style_id].revision == 3
    assert state.styles[style_id].document["classify"][0]["field"] == "population"
    # The rows stay as they were, so the Undo can be pressed again.
    records = await audit.undo_records(run_id)
    assert not any("undone_at" in r or "undoing_at" in r for _, r in records)
    assert not undone(records)
    assert await press_undo(audit, fake_clients(core=core), run_id) == "not_restored"


async def test_a_restore_core_stored_in_part_says_partial() -> None:
    state = MapState()
    style_id, before, record = await _reclassified(state, BY_POPULATION, FAINT)
    _drop_density(state)
    audit, run_id = await _audit(record)
    outcome = await _undo(audit, map_core(state), run_id)
    # The opacity went back; the field that no longer exists did not.
    assert outcome.styles == [
        RestoredStyle(MAP_PROJECT_ID, 31, style_id, 4, partial=True)
    ]
    assert outcome.not_restored == []
    stored = state.styles[style_id].document
    assert stored["symbol"]["fill"]["opacity"] == before["symbol"]["fill"]["opacity"]
    assert stored["classify"][0]["field"] == "population"
    assert undone(await audit.undo_records(run_id))


async def test_a_forced_restore_core_refused_onto_later_saves_is_not_undone() -> None:
    """The data changed and a person saved since: the user confirms, core
    merges the old field onto the current style, refuses it and stores
    nothing."""
    state = MapState()
    style_id, _, record = await _reclassified(state, BY_POPULATION)
    _user_saves(state, style_id, _opacity(0.3))
    _drop_density(state)
    audit, run_id = await _audit(record)
    core = map_core(state)
    asked = await _undo(audit, core, run_id)
    assert [item.revision for item in asked.changed_styles] == [4]
    forced = await _undo(audit, core, run_id, force=True)
    assert forced.styles == [] and forced.changed_styles == []
    assert forced.not_restored == ["style"]
    assert _writes(core) == [
        (
            "PUT",
            f"31/style/{style_id}",
            {"base_rev": 3, "document": record["before"]["document"]},
        )
    ]
    stored = state.styles[style_id]
    assert stored.revision == 4
    assert stored.document["classify"][0]["field"] == "population"
    assert stored.document["symbol"]["fill"]["opacity"] == 0.3
    records = await audit.undo_records(run_id)
    assert not any("undone_at" in r or "undoing_at" in r for _, r in records)


async def test_a_forced_undo_with_nothing_left_to_take_back_is_done() -> None:
    """The user put the answer's change back by hand and changed something
    else: core stores nothing of the forced restore, and nothing is missing."""
    state = MapState()
    style_id = state.active_style_id(31)
    record = await _styled(state, layer_project_id=31, operations=[RED])

    def by_hand(document: Document) -> None:
        document["symbol"]["fill"]["color"] = "#deebf7"
        document["symbol"]["fill"]["opacity"] = 0.3

    _user_saves(state, style_id, by_hand)
    audit, run_id = await _audit(record)
    core = map_core(state)
    asked = await _undo(audit, core, run_id)
    assert [item.revision for item in asked.changed_styles] == [3]
    forced = await _undo(audit, core, run_id, force=True)
    assert forced.styles == [RestoredStyle(MAP_PROJECT_ID, 31, style_id, 3)]
    assert forced.not_restored == []
    assert state.styles[style_id].document["symbol"]["fill"]["opacity"] == 0.3
    assert undone(await audit.undo_records(run_id))


# ---- the whole answer ----------------------------------------------------------------


async def test_an_answer_with_only_a_style_change_is_undoable_and_then_reads_undone() -> (
    None
):
    state = MapState()
    style_id = state.active_style_id(31)
    before = state.snapshot()
    record = await _styled(state, layer_project_id=31, operations=[RED])
    audit, run_id = await _audit(record)
    assert [type(group) for group in undo_groups(await audit.undo_records(run_id))] == [
        StyleEdits
    ]
    assert not undone(await audit.undo_records(run_id))
    core = map_core(state)
    outcome = await _undo(audit, core, run_id)
    assert outcome == UndoOutcome(
        restored=[],
        changed=[],
        styles=[RestoredStyle(MAP_PROJECT_ID, 31, style_id, 3)],
        changed_styles=[],
        not_restored=[],
    )
    assert _looks(state.snapshot()) == _looks(before)
    assert undone(await audit.undo_records(run_id))
    with pytest.raises(NothingToUndo) as raised:
        await _undo(audit, core, run_id)
    assert raised.value.undone
    assert await press_undo(audit, fake_clients(core=core), run_id) == "already_undone"


# ---- a call stopped after a write landed ---------------------------------------------


def _stopping_at(state: MapState, stop: Callable[[httpx.Request], bool]) -> _Proxy:
    """The stand-in core, but the request ``stop`` names ends the call as a
    Stop does, before core sees it."""
    core = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if stop(request):
            raise asyncio.CancelledError()
        response = core.answer(request)
        assert response is not None, request.url.path
        return response

    return _Proxy(handler)


async def _stopped_call(services: _Services, **args: Any) -> tuple[AuditRows, UUID]:
    """``style_update`` through the runtime, ended by a Stop; its audit row."""
    audit, run_id = AuditRows(), uuid4()
    services.env.repo = cast(Repository, audit)
    services.env.run_id = run_id
    with pytest.raises(asyncio.CancelledError):
        await execute(UPDATE_STYLE, services.env, args)
    return audit, run_id


async def test_a_stop_while_the_legend_is_counted_keeps_the_saved_edit_undoable() -> (
    None
):
    state = MapState()
    _quantile_districts(state)
    style_id = state.active_style_id(31)

    def stopped(request: httpx.Request) -> httpx.Response:
        raise asyncio.CancelledError()

    services = _Services(state, processes=_Proxy(stopped))
    audit, run_id = await _stopped_call(
        services, layer_project_id=31, operations=[BLUES]
    )
    palette = state.styles[style_id].document["classify"][0]["palette"]
    assert palette == "colorbrewer:Blues"
    [row] = audit.rows
    assert row["error"] == "cancelled" and row["undo"]["kind"] == "style"
    outcome = await _undo(audit, map_core(state), run_id)
    assert [style.style_id for style in outcome.styles] == [style_id]
    palette = state.styles[style_id].document["classify"][0]["palette"]
    assert palette == "colorbrewer:OrRd"


async def test_a_stop_between_creating_a_style_and_filling_it_keeps_the_created_style_undoable() -> (
    None
):
    state = MapState()
    before = state.snapshot()

    def fill(request: httpx.Request) -> bool:
        return request.method == "PUT" and "/style/" in request.url.path

    services = _Services(state, core=_stopping_at(state, fill))
    audit, run_id = await _stopped_call(
        services,
        layer_project_id=35,
        new_style={"name": "Turnout", "asked": "as a new style", "start": "current"},
        operations=[{"op": "set", "path": "/symbol/marker/color", "value": "#00ff00"}],
    )
    [row] = audit.rows
    assert row["undo"]["kind"] == "style_created" and row["undo"]["revision"] == 1
    assert len(state.styles) > len(before["styles"])
    await _undo(audit, map_core(state), run_id)
    assert state.snapshot() == before


async def test_a_stop_before_any_write_leaves_no_undo_record() -> None:
    state = MapState()

    def check(request: httpx.Request) -> bool:
        return request.url.path.endswith("/check")

    services = _Services(state, core=_stopping_at(state, check))
    audit, _ = await _stopped_call(services, layer_project_id=31, operations=[RED])
    [row] = audit.rows
    assert row["undo"] is None


async def test_the_kept_record_is_the_returned_result_s_record() -> None:
    state = MapState()
    _quantile_districts(state)
    services = _Services(state)
    result = await _run(services, layer_project_id=31, operations=[BLUES])
    assert services.env.landed.read() == result.undo() is not None


async def test_a_viewer_is_refused_in_words_for_every_kind() -> None:
    state = MapState()
    record = await _styled(state, layer_project_id=31, operations=[RED])
    audit, run_id = await _audit(record)
    inner = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method != "GET":
            return httpx.Response(403, json={"detail": {"code": "forbidden"}})
        response = inner.answer(request)
        assert response is not None
        return response

    with pytest.raises(UndoRefused) as raised:
        await _undo(audit, _Proxy(handler), run_id)
    assert (raised.value.status, raised.value.code) == (403, "undo_not_allowed")
    assert raised.value.message == (
        "You cannot change this project's content, so these changes cannot be undone."
    )
    for text in (
        undo_module.NOT_ALLOWED,
        undo_module.UNAVAILABLE,
        conversations.CHANGED_SINCE,
    ):
        assert "workflow" not in text.casefold()
        assert "\N{EM DASH}" not in text and "\N{EN DASH}" not in text
    # Not undone, and not left under way.
    records = await audit.undo_records(run_id)
    assert not any("undone_at" in r or "undoing_at" in r for _, r in records)


# ---- the route -----------------------------------------------------------------------


async def _mixed_answer(
    state: MapState, repo: Repository, project_id: UUID
) -> tuple[Core, str, str, UUID, UUID]:
    """An answer that edited a workflow, created a style of the polling
    stations and edited the districts' style: core, the two styles, the
    conversation and the run."""
    core = Core(project_id, recorder=map_core(state))
    core.add("wf-1", Stored(config("15 min"), revision=5))
    made = await _styled(
        state,
        layer_project_id=35,
        new_style={"name": "New", "asked": "as a new style", "start": "current"},
    )
    edited = await _styled(state, layer_project_id=31, operations=[RED])
    conversation_id, run_id, _ = await answer(
        repo,
        project_id,
        [workflow_edit(project_id, "wf-1", 4, 5, "10 min"), made, edited],
    )
    return core, made["style_id"], edited["style_id"], conversation_id, run_id


def _workflow_saves(core: Core) -> list[httpx.Request]:
    return [
        request
        for request in core.recorder.requests
        if request.method == "PUT" and "/workflow/" in request.url.path
    ]


def _style_row(link: int, style_id: str, revision: int | None, **more: Any) -> Any:
    return {
        "project_id": MAP_PROJECT_ID,
        "layer_project_id": link,
        "style_id": style_id,
        "revision": revision,
        **more,
    }


async def test_the_route_answers_styles_beside_workflows(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    before = state.snapshot()
    core, made, edited, conversation_id, run_id = await _mixed_answer(
        state, repo, project_id
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json() == {
            "workflows": [
                {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
            ],
            "styles": [
                _style_row(35, made, None, removed=True),
                _style_row(31, edited, 3, removed=False),
            ],
            "map": None,
            "not_restored": [],
        }
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
        again = await client.post(url(conversation_id, run_id), json={})
        assert again.status_code == 409
        assert again.json()["detail"]["code"] == "already_undone"
    assert core.workflows["wf-1"].config == config("10 min")
    assert _looks(state.snapshot()) == _looks(before)


async def test_the_route_says_partial_and_not_restored(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    style_id, _, partly = await _reclassified(state, BY_POPULATION, FAINT)
    conversation_id, run_id, _ = await answer(repo, project_id, [partly])
    other = MapState()
    _, _, nothing = await _reclassified(other, BY_POPULATION)
    _, second, _ = await answer(
        repo, project_id, [nothing], conversation_id=conversation_id
    )
    _drop_density(state)
    _drop_density(other)
    async with api(tools=fake_clients(core=map_core(state))) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json()["styles"] == [
            _style_row(31, style_id, 4, removed=False, partial=True)
        ]
    async with api(tools=fake_clients(core=map_core(other))) as client:
        response = await client.post(url(conversation_id, second), json={})
        assert response.status_code == 200, response.text
        assert response.json() == {
            "workflows": [],
            "styles": [],
            "map": None,
            "not_restored": ["style"],
        }
        # Not undone: the button stays.
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )


async def test_changed_since_carries_styles_and_what_was_undone(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    core, made, edited, conversation_id, run_id = await _mixed_answer(
        state, repo, project_id
    )
    # A person changed the districts' style after the answer.
    _user_saves(state, edited, _opacity(0.3))
    async with api(tools=fake_clients(core=core.recorder)) as client:
        asked = await client.post(url(conversation_id, run_id), json={})
        assert asked.status_code == 409, asked.text
        assert asked.json()["detail"] == {
            "code": "changed_since",
            "message": "Something was changed after this answer edited it.",
            "workflows": [],
            "styles": [_style_row(31, edited, 3, between=False, too_old=False)],
            "map": [],
            "undone": [
                {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
            ],
            "undone_styles": [_style_row(35, made, None, removed=True)],
            "undone_map": None,
            "not_restored": [],
        }
        assert state.styles[edited].document["symbol"]["fill"]["color"] == "#ff0000"
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )

        forced = await client.post(url(conversation_id, run_id), json={"force": True})
        assert forced.status_code == 200, forced.text
        # Only what was left: the workflow and the created style went back
        # with the first request.
        assert forced.json() == {
            "workflows": [],
            "styles": [_style_row(31, edited, 4, removed=False)],
            "map": None,
            "not_restored": [],
        }
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
    stored = state.styles[edited].document
    assert stored["symbol"]["fill"] == {"color": "#deebf7", "opacity": 0.3}


class _Gated(httpx.AsyncBaseTransport):
    """Core, whose answers wait until the test lets them through."""

    def __init__(self, core: Recorder) -> None:
        self.inner = core.transport()
        self.reached = asyncio.Event()
        self.open = asyncio.Event()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.reached.set()
        await self.open.wait()
        return await self.inner.handle_async_request(request)


async def test_two_undo_requests_at_once_one_wins(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    core, _, _, conversation_id, run_id = await _mixed_answer(state, repo, project_id)
    gated = _Gated(core.recorder)
    async with api(tools=fake_clients(core=gated)) as client:
        first = asyncio.create_task(client.post(url(conversation_id, run_id), json={}))
        await asyncio.wait_for(gated.reached.wait(), timeout=10)
        # The first request waits for core on the workflow: the rows of every
        # kind are its own by now.
        records = await repo.undo_records(run_id)
        assert len(records) == 3
        assert all("undoing_at" in record for _, record in records)
        second = await client.post(url(conversation_id, run_id), json={})
        assert second.status_code == 409, second.text
        assert second.json()["detail"]["code"] == "undo_in_progress"
        gated.open.set()
        won = await first
        assert won.status_code == 200, won.text
        assert len(won.json()["styles"]) == 2
    assert len(_workflow_saves(core)) == 1
    assert [write[0] for write in _writes(core.recorder)] == ["PATCH", "DELETE", "PUT"]


async def test_a_refusal_half_way_leaves_the_rest_free_for_the_next_undo(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    core, made, edited, conversation_id, run_id = await _mixed_answer(
        state, repo, project_id
    )
    inner = core.recorder
    down = True

    def handler(request: httpx.Request) -> httpx.Response:
        if down and request.method == "DELETE":
            return httpx.Response(503, json={"detail": "down"})
        return inner(request)

    async with api(tools=fake_clients(core=_Proxy(handler))) as client:
        refused = await client.post(url(conversation_id, run_id), json={})
        assert refused.status_code == 503, refused.text
        assert refused.json()["detail"] == {
            "code": "undo_unavailable",
            "message": "The changes could not be undone right now. Try again later.",
        }
        # The workflow went back; the styles are neither undone nor under way.
        marks = [
            ("undone_at" in record, "undoing_at" in record)
            for _, record in await repo.undo_records(run_id)
        ]
        assert marks == [(True, False), (False, False), (False, False)]
        down = False
        again = await client.post(url(conversation_id, run_id), json={})
        assert again.status_code == 200, again.text
        assert again.json()["workflows"] == []
        assert [style["style_id"] for style in again.json()["styles"]] == [made, edited]
    assert len(_workflow_saves(core)) == 1


# ---- the eval user's Undo ------------------------------------------------------------


@pytest.fixture(scope="module")
def backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-undo")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


@pytest.mark.parametrize(
    ("task_id", "call"),
    [
        (
            "map-20",
            {
                "layer_project_id": 31,
                "operations": [
                    {"op": "set", "path": "/symbol/fill/color", "value": "#f3f8fc"},
                    {"op": "set", "path": "/symbol/fill/opacity", "value": 0.5},
                ],
            },
        ),
        (
            "map-21",
            {
                "layer_project_id": 35,
                "new_style": {
                    "name": "Turnout change",
                    "asked": "Save a new style",
                    "start": "current",
                },
                "operations": [
                    {
                        "op": "add",
                        "path": "/classify",
                        "item": {
                            "field": "turnout_change",
                            "method": "quantile",
                            "count": 5,
                            "palette": "colorbrewer:RdBu",
                        },
                    }
                ],
            },
        ),
    ],
)
async def test_the_eval_users_undo_brings_the_styles_back(
    task_id: str, call: dict[str, Any], backends: Backends, settings: Any
) -> None:
    task = next(t for t in load_tasks("map") if t.id == task_id)
    model = ScriptedModel(calls=[("style_update", call)], answer="Done.")
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert transcript.undo == "undone"
    before, after, back = (
        transcript.map_before,
        transcript.map_after,
        transcript.map_undone,
    )
    assert before is not None and after is not None and back is not None
    assert _looks(after) != _looks(before)
    assert _looks(back) == _looks(before)
    grades = await grade(task, transcript, backends)
    [style] = [g for g in grades if g.check == "style"]
    assert style.passed is True, style.detail
