"""``undo_changes``: a typed "undo that" runs the dock's Undo
(``assistant.undo.undo_run``) for the newest earlier answer whose Undo can
still act, and returns what went back, as the Undo route's reply names it.

``api``, ``repo`` and ``make_project`` are conftest fixtures; core is the
stateful workflow fake of ``test_undo``, and for the map the eval stand-in."""

import dataclasses
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import ToolReturnPart

from assistant.asks import AskHistory, AskUserInput
from assistant.context import parse_context
from assistant.repo import Repository
from assistant.tools.runtime import ToolEnv, execute
from assistant.tools.testing import fake_clients, tool_env
from assistant.tools.toolset import earlier_writes
from assistant.tools.undo import UNDO_CHANGES
from assistant.undo import NOT_ALLOWED, UNAVAILABLE
from evals.harness import AuditRows, auto_answer
from evals.map_backends import MapState, map_core
from evals.map_fixture import MAP_PROJECT_ID
from tests.test_undo import (
    ADA,
    USER,
    Core,
    Stored,
    answer,
    config,
    edit,
)
from tests.test_undo_map import CAFES, SHOPS, _filtered

Api = Any  # conftest.ApiFactory
ProjectFactory = Any  # conftest.ProjectFactory


def _named(core: Core, **names: str) -> None:
    """Core lists the project's workflows with these names, by id."""
    core.recorder.routes[("GET", f"/api/v2/project/{core.project_id}/workflow")] = [
        {"id": workflow_id, "name": name} for workflow_id, name in names.items()
    ]


def _env(
    core: Core, repo: Repository, run_id: UUID, asks: AskHistory | None = None
) -> ToolEnv:
    env = tool_env(
        fake_clients(core=core.recorder),
        page=parse_context(
            {"surface": "project.workflows", "project_id": str(core.project_id)}
        ),
        run_id=run_id,
        repo=repo,
    )
    if asks is not None:
        env.asks = asks
    return env


async def _current(repo: Repository, project_id: UUID, conversation_id: UUID) -> UUID:
    """The run of the message being answered: still running."""
    _, run_id, _ = await answer(
        repo, project_id, [], conversation_id=conversation_id, status="running"
    )
    return run_id


async def _finish(repo: Repository, run_id: UUID) -> None:
    await repo.finish_run(
        run_id, "succeeded", None, [{"type": "text", "text": "."}], []
    )


async def _undo(env: ToolEnv, **args: Any) -> dict[str, Any]:
    return await execute(UNDO_CHANGES, env, args, tool_call_id="call-undo")


async def _metadata(client: Any, conversation_id: UUID) -> dict[str, dict[str, Any]]:
    body = (await client.get(f"/conversations/{conversation_id}")).json()
    return {m["id"]: m.get("metadata", {}) for m in body["messages"]}


def _card(value: str) -> AskUserInput:
    return AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": 'The workflow "Bus" was saved since. Take it back anyway?',
                    "header": "Undo",
                    "options": [
                        {"label": "Keep it as it is", "recommended": True},
                        {"label": "Take it back anyway", "value": value},
                    ],
                }
            ]
        }
    )


def _picked(value: str, offered: str | None = None) -> AskHistory:
    """The user picked the option of ``value`` on a card of this request
    that offered ``offered`` (``value`` when not given)."""
    card = _card(offered or value)
    picked, _ = auto_answer("ask-1", card, value)
    return AskHistory(cards={"ask-1": card}, chain=frozenset()).with_answer(picked)


async def test_the_newest_answer_goes_back_and_reads_undone(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    core.add("wf-2", Stored(config("tram"), revision=2))
    _named(core, **{"wf-1": "Walk", "wf-2": "Bus"})
    conversation_id, older_run, older = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    _, newer_run, newer = await answer(
        repo,
        project_id,
        [edit(project_id, "wf-2", 1, 2, "bus")],
        conversation_id=conversation_id,
    )
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result == {
        "status": "undone",
        "run_id": str(newer_run),
        "workflows": [
            {"workflow_id": "wf-2", "project_id": str(project_id), "revision": 3}
        ],
        "styles": [],
        "not_restored": [],
        "summary": 'Took back what the earlier answer changed: the workflow "Bus".',
    }
    assert core.workflows["wf-2"].config == config("bus")
    assert core.workflows["wf-1"].config == config("15 min")
    await _finish(repo, current)
    async with api(tools=fake_clients(core=core.recorder)) as client:
        metadata = await _metadata(client, conversation_id)
    assert metadata[str(newer)]["undone"] is True
    assert "undoable" not in metadata[str(newer)]
    assert metadata[str(older)]["undoable"] is True
    assert older_run != newer_run


async def test_each_call_takes_back_the_next_older_answer_until_none_is_left(
    repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    core.add("wf-2", Stored(config("tram"), revision=2))
    _named(core, **{"wf-1": "Walk", "wf-2": "Bus"})
    conversation_id, older_run, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    await answer(
        repo,
        project_id,
        [edit(project_id, "wf-2", 1, 2, "bus")],
        conversation_id=conversation_id,
    )
    taken: list[dict[str, Any]] = []
    for _ in range(3):
        current = await _current(repo, project_id, conversation_id)
        taken.append(await _undo(_env(core, repo, current)))
        await _finish(repo, current)
    first, second, third = taken
    assert first["status"] == "undone"
    assert second["status"] == "undone" and second["run_id"] == str(older_run)
    assert second["workflows"] == [
        {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
    ]
    assert core.workflows["wf-1"].config == config("10 min")
    # Null keys are left out of a tool result, as in every tool's.
    assert third == {
        "status": "nothing",
        "workflows": [],
        "styles": [],
        "not_restored": [],
        "summary": "No earlier answer of this conversation has changes left to "
        "take back.",
    }


async def test_the_current_answer_s_own_write_is_never_the_target(
    repo: Repository, make_project: ProjectFactory
) -> None:
    """A write of the answer that calls the tool stays. The answer before
    goes back, except a workflow the current answer changed since: that one
    ``undo_run`` finds saved after the earlier edit, and asks first."""
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("bus, now"), revision=3))
    core.add("wf-2", Stored(config("walk, now"), revision=7))
    _named(core, **{"wf-1": "Bus", "wf-2": "Walk"})
    conversation_id, earlier_run, _ = await answer(
        repo,
        project_id,
        [
            edit(project_id, "wf-1", 1, 2, "bus"),
            edit(project_id, "wf-2", 6, 7, "walk"),
        ],
    )
    current = await _current(repo, project_id, conversation_id)
    # The current answer edited wf-1 once more (2 -> 3) before it was asked.
    own = edit(project_id, "wf-1", 2, 3, "bus, earlier")
    await repo.insert_tool_call(
        run_id=current,
        user_id=USER,
        tool="workflow_update",
        tool_call_id="call-own",
        args_summary={},
        result_bytes=100,
        duration_ms=5,
        status="ok",
        error=None,
        undo=own,
    )
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "changed" and result["run_id"] == str(earlier_run)
    assert result["confirm"]["value"] == f"undo_anyway:{earlier_run}"
    assert result["workflows"] == [
        {"workflow_id": "wf-2", "project_id": str(project_id), "revision": 8}
    ]
    assert core.workflows["wf-2"].config == config("walk")
    assert core.workflows["wf-1"].config == config("bus, now")
    # The current answer's own record is untouched.
    [(_, record)] = await repo.undo_records(current)
    assert "undone_at" not in record and "undoing_at" not in record


async def test_a_change_made_since_asks_with_a_card_and_only_its_pick_forces(
    repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    # A person saved wf-2 after the answer's edit.
    core.add("wf-2", Stored(config("bus, moved"), revision=3, updated_by=ADA))
    _named(core, **{"wf-1": "Walk", "wf-2": "Bus"})
    conversation_id, _, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    _, run_id, _ = await answer(
        repo,
        project_id,
        [edit(project_id, "wf-2", 1, 2, "bus")],
        conversation_id=conversation_id,
    )
    current = await _current(repo, project_id, conversation_id)
    env = _env(core, repo, current)
    asked = await _undo(env)
    value = f"undo_anyway:{run_id}"
    assert asked == {
        "status": "changed",
        "run_id": str(run_id),
        "workflows": [],
        "styles": [],
        "not_restored": [],
        "summary": "Not taken back, because it was changed after the earlier "
        'answer changed it: the workflow "Bus".',
        "confirm": {"value": value, "changed": 'the workflow "Bus"'},
        "note": asked["note"],
    }
    assert "ask_user" in asked["note"] and "confirm" in asked["note"]
    # The card may offer the value: this answer's tool named it.
    assert value in env.confirm_values
    assert core.workflows["wf-2"].config == config("bus, moved")
    await _finish(repo, current)

    # A value the user did not pick, one for a run that is no earlier answer
    # of this conversation (another conversation's, the current run's) or one
    # the tool never makes, is refused before anything is written.
    puts = len(core.puts())
    elsewhere = f"undo_anyway:{uuid4()}"
    for asks, given in (
        (AskHistory(), value),
        (_picked(elsewhere), elsewhere),
        (_picked(value), "undo_anyway:anything"),
        (_picked(value), "anything"),
    ):
        current = await _current(repo, project_id, conversation_id)
        with pytest.raises(ToolFailed):
            await _undo(_env(core, repo, current, asks), confirm=given)
        await _finish(repo, current)
    current = await _current(repo, project_id, conversation_id)
    own = f"undo_anyway:{current}"
    with pytest.raises(ToolFailed):
        await _undo(_env(core, repo, current, _picked(own)), confirm=own)
    await _finish(repo, current)
    assert len(core.puts()) == puts
    # A refused pick lets no card of that answer offer the value.
    current = await _current(repo, project_id, conversation_id)
    unpicked = _env(core, repo, current)
    with pytest.raises(ToolFailed):
        await _undo(unpicked, confirm=value)
    assert unpicked.confirm_values == set()
    await _finish(repo, current)
    # A pick before the user's last typed message is no pick of this request.
    current = await _current(repo, project_id, conversation_id)
    earlier = dataclasses.replace(_picked(value), chain=frozenset())
    with pytest.raises(ToolFailed, match="did not run"):
        await _undo(_env(core, repo, current, earlier), confirm=value)
    await _finish(repo, current)
    assert len(core.puts()) == puts

    current = await _current(repo, project_id, conversation_id)
    forced = await _undo(_env(core, repo, current, _picked(value)), confirm=value)
    assert forced["status"] == "undone" and forced["run_id"] == str(run_id)
    assert forced["workflows"] == [
        {"workflow_id": "wf-2", "project_id": str(project_id), "revision": 4}
    ]
    assert core.workflows["wf-2"].config == config("bus")


async def test_what_went_back_before_a_changed_workflow_is_in_the_result(
    repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    core.add("wf-2", Stored(config("bus, moved"), revision=3, updated_by=ADA))
    _named(core, **{"wf-1": "Walk", "wf-2": "Bus"})
    conversation_id, run_id, _ = await answer(
        repo,
        project_id,
        [
            edit(project_id, "wf-1", 4, 5, "10 min"),
            edit(project_id, "wf-2", 1, 2, "bus"),
        ],
    )
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "changed"
    assert result["workflows"] == [
        {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
    ]
    assert result["summary"] == (
        'Took back what the earlier answer changed: the workflow "Walk". Not '
        "taken back, because it was changed after the earlier answer changed "
        'it: the workflow "Bus".'
    )
    assert core.workflows["wf-1"].config == config("10 min")


async def test_nothing_to_take_back_and_removed_layers_are_said(
    repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    conversation_id, _, _ = await answer(repo, project_id, [])
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "nothing" and "run_id" not in result
    await _finish(repo, current)

    removed = {
        "kind": "map",
        "project_id": str(project_id),
        "changes": [{"object": "layer_removed", "layer_project_id": 39, "name": "Old"}],
    }
    await answer(repo, project_id, [removed], conversation_id=conversation_id)
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result == {
        "status": "nothing",
        "workflows": [],
        "styles": [],
        "not_restored": [],
        "summary": "The last answer's change cannot be taken back with undo: it "
        "removed a layer. Nothing was taken back.",
    }
    assert core.puts() == []


@pytest.mark.parametrize(
    ("refuse", "time_out", "summary"),
    [(403, None, NOT_ALLOWED), (None, "before", UNAVAILABLE)],
)
async def test_a_refused_undo_returns_failed(
    repo: Repository,
    make_project: ProjectFactory,
    refuse: int | None,
    time_out: str | None,
    summary: str,
) -> None:
    """A viewer gets the refusal the route gives (core decides, as there)."""
    project_id = await make_project()
    core = Core(project_id, refuse=refuse, time_out=time_out)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result == {
        "status": "failed",
        "run_id": str(run_id),
        "workflows": [],
        "styles": [],
        "not_restored": [],
        "summary": summary,
    }


async def test_an_undo_under_way_returns_under_way(
    repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    claimed = {
        **edit(project_id, "wf-1", 4, 5, "10 min"),
        "undoing_at": datetime.now(UTC).isoformat(),
    }
    conversation_id, run_id, _ = await answer(repo, project_id, [claimed])
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "under_way" and result["run_id"] == str(run_id)
    assert result["summary"] == (
        "These changes are being taken back right now by another undo."
    )
    assert core.puts() == []


async def test_an_answer_whose_only_write_is_the_undo_offers_no_undo(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, _, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    current = await _current(repo, project_id, conversation_id)
    assert (await _undo(_env(core, repo, current)))["status"] == "undone"
    await _finish(repo, current)
    assert await repo.undo_records(current) == []
    async with api(tools=fake_clients(core=core.recorder)) as client:
        body = (await client.get(f"/conversations/{conversation_id}")).json()
    last = body["messages"][-1]
    assert last["metadata"]["run_id"] == str(current)
    assert "undoable" not in last["metadata"] and "undone" not in last["metadata"]


async def test_a_map_change_is_named_by_its_layer() -> None:
    """The eval's audit rows and map stand-in, as the eval runs the tool."""
    state = MapState()
    audit = AuditRows()
    earlier, current = uuid4(), uuid4()
    await audit.insert_tool_call(run_id=earlier, undo=_filtered(state, 32, SHOPS))
    env = tool_env(
        fake_clients(core=map_core(state)),
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
        run_id=current,
        repo=cast(Repository, audit),
    )
    result = await execute(UNDO_CHANGES, env, {})
    assert result["status"] == "undone" and result["run_id"] == str(earlier)
    assert result["map"]["layers"] == [32]
    assert result["summary"] == (
        "Took back what the earlier answer changed: the filter of the layer "
        '"Points of interest".'
    )


def test_a_later_answer_runs_the_undo_again() -> None:
    """A write is repeated from its first result only when it is not
    repeatable: a second typed undo takes back the next answer."""
    from assistant.tools.registry import BY_WIRE_NAME

    assert BY_WIRE_NAME["undo_changes"] is UNDO_CHANGES
    assert UNDO_CHANGES.repeatable is not None
    stored = [
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool",
                    "tool_name": "undo_changes",
                    "state": "output",
                    "args": {},
                    "output": {"status": "undone"},
                }
            ],
        }
    ]
    assert earlier_writes(stored) == {}


def test_the_prompt_sends_a_typed_undo_to_the_tool() -> None:
    from assistant.prompt import INSTRUCTIONS

    flat = " ".join(INSTRUCTIONS.split())
    assert (
        "On the Map and Workflows pages, when the user asks in words to undo, "
        "revert or take back what an answer changed, call undo_changes, which does what that button does, and never "
        "reverse the change by hand with the other write tools; a new value the "
        'user names ("make it 30 % instead") is an edit, not an undo.' in flat
    )


def test_the_undo_value_is_consent_only_from_a_card_that_can_keep() -> None:
    """``undo_anyway:`` is a consent value: a card offers it only as this
    answer's tool named it, and only a pick beside an option that keeps
    counts."""
    from assistant.asks import CONSENT_UNNAMED, consent_problem, consented

    value = f"undo_anyway:{uuid4()}"
    card = _card(value)
    assert consent_problem(card, {value}) is None
    assert consent_problem(card, set()) == CONSENT_UNNAMED.format(value=value)
    assert consented(_picked(value), value)
    both = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Take the changes back anyway?",
                    "header": "Undo",
                    "options": [
                        {"label": "Take them back", "value": value},
                        {"label": "Take them back now", "value": value},
                    ],
                }
            ]
        }
    )
    picked, _ = auto_answer("ask-1", both, value)
    history = AskHistory(cards={"ask-1": both}, chain=frozenset()).with_answer(picked)
    assert consent_problem(both, {value}) is not None
    assert not consented(history, value)


async def _call(
    repo: Repository,
    run_id: UUID,
    tool: str,
    *,
    status: str = "ok",
    args: dict[str, Any] | None = None,
    created: dict[str, Any] | None = None,
) -> None:
    """An audit row of a call that left no undo record."""
    await repo.insert_tool_call(
        run_id=run_id,
        user_id=USER,
        tool=tool,
        tool_call_id=f"call-{uuid4()}",
        args_summary=args or {},
        result_bytes=10,
        duration_ms=1,
        status=status,
        error=None if status == "ok" else "failed",
        created=created,
    )


async def _answered(
    repo: Repository,
    project_id: UUID,
    conversation_id: UUID,
    *calls: tuple[str, dict[str, Any]],
) -> UUID:
    """A finished answer whose calls left no undo record."""
    run_id = await _current(repo, project_id, conversation_id)
    for tool, more in calls:
        await _call(repo, run_id, tool, **more)
    await _finish(repo, run_id)
    return run_id


async def test_a_pick_takes_back_the_asked_answer_after_the_asking_answer_wrote(
    repo: Repository, make_project: ProjectFactory
) -> None:
    """The answer that showed the card changed wf-1 itself; the pick in the
    next message forces the answer the card asked about, and nothing of the
    asking answer goes back."""
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("bus, now"), revision=3))
    core.add("wf-2", Stored(config("walk, now"), revision=7))
    _named(core, **{"wf-1": "Bus", "wf-2": "Walk"})
    conversation_id, asked_run, _ = await answer(
        repo,
        project_id,
        [
            edit(project_id, "wf-1", 1, 2, "bus"),
            edit(project_id, "wf-2", 6, 7, "walk"),
        ],
    )
    asking = await _current(repo, project_id, conversation_id)
    await repo.insert_tool_call(
        run_id=asking,
        user_id=USER,
        tool="workflow_update",
        tool_call_id="call-own",
        args_summary={},
        result_bytes=100,
        duration_ms=5,
        status="ok",
        error=None,
        undo=edit(project_id, "wf-1", 2, 3, "bus, earlier"),
    )
    asked = await _undo(_env(core, repo, asking))
    value = f"undo_anyway:{asked_run}"
    assert asked["status"] == "changed" and asked["confirm"]["value"] == value
    await _finish(repo, asking)

    current = await _current(repo, project_id, conversation_id)
    forced = await _undo(_env(core, repo, current, _picked(value)), confirm=value)
    assert forced["status"] == "undone" and forced["run_id"] == str(asked_run)
    assert core.workflows["wf-1"].config == config("bus")
    [(_, own)] = await repo.undo_records(asking)
    assert "undone_at" not in own and "undoing_at" not in own


@pytest.mark.parametrize(
    ("calls", "said"),
    [
        (
            [
                (
                    "project_add_catalog_layer",
                    {"created": {"kind": "layer", "ids": [7]}},
                )
            ],
            "added a dataset from the catalog to the project",
        ),
        (
            [("map_update", {"args": {"operations": [{"op": "set_view"}]}})],
            "moved the map's view",
        ),
        (
            [
                ("workflow_run", {"created": {"kind": "workflow_run", "ids": ["j1"]}}),
                ("workflow_create", {}),
            ],
            "ran a workflow and created a workflow",
        ),
    ],
    ids=["dataset", "view", "workflow"],
)
async def test_the_last_answer_s_change_undo_cannot_take_back_is_said(
    repo: Repository,
    make_project: ProjectFactory,
    calls: list[tuple[str, dict[str, Any]]],
    said: str,
) -> None:
    """The user means the last answer that changed something: one whose
    change leaves no undo record is not passed over, and nothing is written."""
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, older, older_message = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    await _answered(repo, project_id, conversation_id, *calls)
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result == {
        "status": "nothing",
        "workflows": [],
        "styles": [],
        "not_restored": [],
        "summary": "The last answer's change cannot be taken back with undo: it "
        f"{said}. Nothing was taken back.",
    }
    assert core.puts() == []
    [(_, record)] = await repo.undo_records(older)
    assert "undone_at" not in record


async def test_answers_without_a_change_are_passed_over(
    repo: Repository, make_project: ProjectFactory
) -> None:
    """Reads, failed writes, a map change that waited for a pick, a style
    call that changed nothing and a workflow run that started nothing are no
    change of the answer."""
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    _named(core, **{"wf-1": "Walk"})
    conversation_id, older, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    await _answered(
        repo,
        project_id,
        conversation_id,
        ("project_get_layers", {}),
        ("project_add_dataset", {"status": "error"}),
        (
            "map_update",
            {"args": {"operations": [{"op": "remove_layer", "layer_project_id": 39}]}},
        ),
        ("style_update", {}),
        # A run processes refused, or a wait on a run already going.
        ("workflow_run", {}),
    )
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "undone" and result["run_id"] == str(older)


async def test_what_the_answer_also_did_that_undo_cannot_take_back_is_said(
    repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    _named(core, **{"wf-1": "Walk"})
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    await _call(repo, run_id, "project_add_dataset", created={"kind": "layer"})
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "undone"
    assert result["summary"] == (
        'Took back what the earlier answer changed: the workflow "Walk". It also '
        "added a dataset to the project, which undo does not take back."
    )


async def test_a_race_with_the_button_says_the_changes_went_back_already(
    repo: Repository, make_project: ProjectFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    from assistant.tools import undo as tool_module
    from assistant.undo import NothingToUndo

    async def taken(*args: Any, **kwargs: Any) -> Any:
        raise NothingToUndo(undone=True)

    monkeypatch.setattr(tool_module, "undo_run", taken)
    project_id = await make_project()
    core = Core(project_id)
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "nothing" and result["run_id"] == str(run_id)
    assert result["summary"] == "These changes were taken back already."


async def test_a_summary_that_cannot_be_built_still_returns_what_went_back(
    repo: Repository, make_project: ProjectFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    from assistant.tools import undo as tool_module

    def broken(*args: Any) -> list[str]:
        raise RuntimeError("no words")

    monkeypatch.setattr(tool_module, "_went_back", broken)
    project_id = await make_project()
    core = Core(project_id)
    core.add("wf-1", Stored(config("15 min"), revision=5))
    conversation_id, run_id, _ = await answer(
        repo, project_id, [edit(project_id, "wf-1", 4, 5, "10 min")]
    )
    current = await _current(repo, project_id, conversation_id)
    result = await _undo(_env(core, repo, current))
    assert result["status"] == "undone" and result["run_id"] == str(run_id)
    assert result["workflows"] == [
        {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
    ]
    assert result["summary"] == "Took back what the earlier answer changed."


async def test_a_map_change_made_since_asks_with_the_card() -> None:
    state = MapState()
    audit = AuditRows()
    earlier, current = uuid4(), uuid4()
    await audit.insert_tool_call(run_id=earlier, undo=_filtered(state, 32, SHOPS))
    # A person set another filter since.
    state.layers[32]["query"] = CAFES
    env = tool_env(
        fake_clients(core=map_core(state)),
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
        run_id=current,
        repo=cast(Repository, audit),
    )
    result = await execute(UNDO_CHANGES, env, {})
    assert result["status"] == "changed" and result["run_id"] == str(earlier)
    assert result["confirm"] == {
        "value": f"undo_anyway:{earlier}",
        "changed": 'the filter of the layer "Points of interest"',
    }
    assert state.layers[32]["query"] == CAFES


async def test_a_second_call_in_the_same_answer_takes_back_nothing_more() -> None:
    from assistant.agent import RunDeps, build_agent
    from assistant.tools.testing import ScriptedModel
    from assistant.tools.undo import REPEATED_UNDO

    state = MapState()
    audit = AuditRows()
    older, newer, current = uuid4(), uuid4(), uuid4()
    await audit.insert_tool_call(run_id=older, undo=_filtered(state, 34, SHOPS))
    await audit.insert_tool_call(run_id=newer, undo=_filtered(state, 32, SHOPS))
    env = tool_env(
        fake_clients(core=map_core(state)),
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
        run_id=current,
        repo=cast(Repository, audit),
    )
    script = ScriptedModel([("undo_changes", {}), ("undo_changes", {})])

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=env)
    await build_agent(script.model).run("undo the last two changes", deps=deps)
    first, second = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]
    assert first["run_id"] == second["run_id"] == str(newer)
    assert second["repeated_call"] == REPEATED_UNDO
    assert state.layers[34]["query"] == SHOPS


def test_every_write_tool_but_the_undo_says_what_it_did() -> None:
    """An answer's change that leaves no undo record is named by its tool: a
    write tool without words would be passed over."""
    from assistant.tools.registry import ALL_TOOLS
    from assistant.tools.undo import DID

    writes = {spec.wire_name for spec in ALL_TOOLS if spec.risk == "write"}
    assert set(DID) == writes - {"undo_changes"}


@pytest.mark.parametrize(
    ("kind", "started"), [("started", True), ("refused", False), ("waited", False)]
)
async def test_a_workflow_run_is_recorded_as_created_only_when_it_started_one(
    kind: str, started: bool
) -> None:
    """What the typed undo reads to tell a run it started from one that
    started nothing."""
    import httpx

    from assistant.tools.workflow_runs import RUN
    from assistant.workflows.runs import ConversationRuns
    from tests.test_workflow_run import RUNNING, WF, _env, _services

    if kind == "refused":
        services = _services(
            execute_answer=httpx.Response(
                422, json={"detail": {"message": "No.", "issues": []}}
            )
        )
    elif kind == "waited":
        services = _services(jobs={"jobs": [RUNNING]}, statuses=[RUNNING])
    else:
        services = _services()
    audit = AuditRows()
    env = dataclasses.replace(
        _env(services, runs=ConversationRuns(created={WF}), clock=None),
        repo=cast(Repository, audit),
        run_id=uuid4(),
    )
    await execute(RUN, env, {"workflow_id": WF})
    [row] = audit.rows
    assert row["status"] == "ok"
    assert (row["created"] is not None) is started
    if started:
        assert row["created"]["kind"] == "workflow_run"


async def test_a_changed_card_is_kept_when_the_summary_cannot_be_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from assistant.tools import undo as tool_module

    def broken(*args: Any) -> list[str]:
        raise RuntimeError("no words")

    monkeypatch.setattr(tool_module, "_went_back", broken)
    state = MapState()
    audit = AuditRows()
    earlier, current = uuid4(), uuid4()
    await audit.insert_tool_call(run_id=earlier, undo=_filtered(state, 32, SHOPS))
    state.layers[32]["query"] = CAFES
    env = tool_env(
        fake_clients(core=map_core(state)),
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
        run_id=current,
        repo=cast(Repository, audit),
    )
    result = await execute(UNDO_CHANGES, env, {})
    value = f"undo_anyway:{earlier}"
    assert result["status"] == "changed" and result["run_id"] == str(earlier)
    assert result["confirm"]["value"] == value and result["confirm"]["changed"]
    assert result["note"] == tool_module.CHANGED_NOTE
    assert value in env.confirm_values
