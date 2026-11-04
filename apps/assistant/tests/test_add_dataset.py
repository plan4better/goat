"""project_add_dataset (spec 3.4): one of the user's own datasets into the open
project, after a pick in a card; core links it, the assistant checks the user
can read it first."""

from typing import Any

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import AskHistory, AskUserInput, CardAnswer, QuestionAnswer
from assistant.context import parse_context
from assistant.login import Login
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.runtime import ToolEnv, execute
from assistant.tools.testing import Recorder, fake_clients, signed_in, tool_env
from assistant.tools.workflows import (
    ADD_DATASET,
    CANNOT_READ_DATASET,
    MAX_BUNDLE_LOOKUPS,
    NO_PROJECT,
    NOT_PICKED_DATASET,
    NOT_READABLE,
    VIEWER_LAYERS,
    catalog_dataset,
)

PROJECT = "00000000-0000-0000-0000-0000000005e4"
PAGE = parse_context({"surface": "project.map", "project_id": PROJECT})
DATASET = "d1000000-0000-0000-0000-000000000001"
BUNDLE = "b0000000-0000-0000-0000-0000000000b1"
READ = f"/api/v2/layer/{DATASET}"
ADD = f"/api/v2/project/{PROJECT}/layer"
LINKED = [
    {
        "id": 12,
        "layer_id": DATASET,
        "name": "Schools",
        "type": "feature",
        "feature_layer_geometry_type": "point",
    }
]


def _core(**routes: Any) -> Recorder:
    recorder = Recorder(
        {
            ("GET", READ): {"id": DATASET, "name": "Schools", "type": "feature"},
            ("POST", ADD): LINKED,
        }
    )
    for key, answer in routes.items():
        method, path = key.split(" ", 1)
        recorder.routes[(method, path)] = answer
    return recorder


def _picked(*values: str, adds: list[str] | None = None) -> AskHistory:
    """One answered card per value, in this order, each picking the option
    with that value (the last one also with ``adds``)."""
    cards: dict[str, AskUserInput] = {}
    answers: dict[str, CardAnswer] = {}
    for n, value in enumerate(values):
        option: dict[str, Any] = {"label": "Picked", "value": value}
        if adds is not None and n == len(values) - 1:
            option["adds"] = adds
        card_id = f"ask-c{n}"
        cards[card_id] = AskUserInput.model_validate(
            {
                "questions": [
                    {
                        "question": "Which data should the workflow use?",
                        "header": "Data",
                        "options": [option, {"label": "Leave it open"}],
                    }
                ]
            }
        )
        answers[card_id] = CardAnswer(
            card_id=card_id, answers=[QuestionAnswer(question=0, options=[0])]
        )
    return AskHistory(cards=cards, answers=answers)


def _env(
    core: Recorder, asks: AskHistory | None, login: Login | None = None
) -> ToolEnv:
    env = tool_env(fake_clients(core=core), page=PAGE, login=login)
    if asks is not None:
        env.asks = asks
    return env


def _posted(core: Recorder) -> bool:
    return any(
        (request.method, request.url.path) == ("POST", ADD) for request in core.requests
    )


async def test_added_after_a_pick() -> None:
    core = _core()
    out = await execute(
        ADD_DATASET, _env(core, _picked(DATASET)), {"dataset_id": DATASET}
    )
    assert out["layers"] == [
        {
            "layer_project_id": 12,
            "name": "Schools",
            "type": "feature",
            "geometry_type": "point",
        }
    ]
    assert out["project_id"] == PROJECT
    assert out["note"] == "Added to the project."
    # The read check comes first; core links the one dataset.
    read, add = core.requests
    assert (read.method, read.url.path) == ("GET", READ)
    assert (add.method, add.url.path) == ("POST", ADD)
    assert add.url.params.get_list("layer_ids") == [DATASET]


async def test_a_pick_with_adds_authorises_its_dataset() -> None:
    core = _core()
    env = _env(core, _picked("schools", adds=[DATASET]))
    out = await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert [layer["layer_project_id"] for layer in out["layers"]] == [12]


async def test_refused_without_a_pick() -> None:
    core = _core()
    with pytest.raises(ToolFailed, match="not picked") as caught:
        await execute(ADD_DATASET, _env(core, None), {"dataset_id": DATASET})
    assert caught.value.message == NOT_PICKED_DATASET
    assert core.requests == []


async def test_a_pick_of_another_dataset_is_no_pick() -> None:
    core = _core()
    other = "d1000000-0000-0000-0000-000000000002"
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, _env(core, _picked(other)), {"dataset_id": DATASET})
    assert caught.value.message == NOT_PICKED_DATASET
    assert not _posted(core)


async def test_without_a_project_nothing_is_asked() -> None:
    core = _core()
    env = tool_env(fake_clients(core=core))
    env.asks = _picked(DATASET)
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == NO_PROJECT
    assert core.requests == []


async def test_refused_for_a_dataset_the_user_cannot_read() -> None:
    """Plan Review Focus: core's add does not check that the user can read
    the layer, so the tool refuses it before core links it."""
    for status in (403, 404, 422):
        core = _core(**{f"GET {READ}": httpx.Response(status, json={"detail": "no"})})
        with pytest.raises(ToolFailed, match="cannot read") as caught:
            await execute(
                ADD_DATASET, _env(core, _picked(DATASET)), {"dataset_id": DATASET}
            )
        assert caught.value.message == CANNOT_READ_DATASET
        assert not _posted(core)


async def test_a_401_for_a_valid_sign_in_is_a_dataset_the_user_cannot_read() -> None:
    """Core answers 401 when its authorization denies the read."""
    core = _core(
        **{f"GET {READ}": httpx.Response(401, json={"detail": "Unauthorized"})}
    )
    env = _env(core, _picked(DATASET), login=signed_in(3600))
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == CANNOT_READ_DATASET
    assert not _posted(core)


async def test_a_401_for_an_expired_sign_in_says_so() -> None:
    core = _core(
        **{f"GET {READ}": httpx.Response(401, json={"detail": "Unauthorized"})}
    )
    env = _env(core, _picked(DATASET), login=signed_in(-60))
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == SIGN_IN_EXPIRED
    assert not _posted(core)


async def test_a_viewer_cannot_add() -> None:
    core = _core(
        **{
            f"POST {ADD}": httpx.Response(
                403,
                json={
                    "detail": "Adding layers to a project requires editor access "
                    "to the project"
                },
            )
        }
    )
    with pytest.raises(ToolFailed, match="view this project") as caught:
        await execute(
            ADD_DATASET, _env(core, _picked(DATASET)), {"dataset_id": DATASET}
        )
    assert caught.value.message == VIEWER_LAYERS


async def test_a_401_on_the_add_for_a_valid_sign_in_is_a_viewer() -> None:
    core = _core(
        **{f"POST {ADD}": httpx.Response(401, json={"detail": "Unauthorized"})}
    )
    env = _env(core, _picked(DATASET), login=signed_in(3600))
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == VIEWER_LAYERS


async def test_a_401_on_the_add_for_an_expired_sign_in_says_so() -> None:
    core = _core(
        **{f"POST {ADD}": httpx.Response(401, json={"detail": "Unauthorized"})}
    )
    env = _env(core, _picked(DATASET), login=signed_in(-60))
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == SIGN_IN_EXPIRED


async def test_a_project_that_is_gone() -> None:
    """Core answers 404 for a trashed project."""
    core = _core(
        **{f"POST {ADD}": httpx.Response(404, json={"detail": "Project not found"})}
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_DATASET, _env(core, _picked(DATASET)), {"dataset_id": DATASET}
        )
    assert caught.value.message == NOT_READABLE


async def test_a_picked_bundle_authorises_its_members() -> None:
    members = [
        {"layer_id": DATASET, "role": "stops", "name": "Schools"},
        {"layer_id": "d1000000-0000-0000-0000-000000000002", "role": None},
    ]
    core = _core(**{f"GET /api/v2/bundle/{BUNDLE}/layers": members})
    out = await execute(
        ADD_DATASET, _env(core, _picked(BUNDLE)), {"dataset_id": DATASET}
    )
    assert out["layers"]
    assert core.paths() == [f"/api/v2/bundle/{BUNDLE}/layers", READ, ADD]


async def test_a_bundle_the_user_cannot_read_authorises_nothing() -> None:
    core = _core(
        **{
            f"GET /api/v2/bundle/{BUNDLE}/layers": httpx.Response(
                403, json={"detail": "no access"}
            )
        }
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, _env(core, _picked(BUNDLE)), {"dataset_id": DATASET})
    assert caught.value.message == NOT_PICKED_DATASET
    assert not _posted(core)


async def test_only_ids_are_looked_up_as_bundles() -> None:
    """A picked value is any short key: a catalog slug, a layer_project_id or
    a run is no bundle of the user's."""
    core = _core()
    env = _env(core, _picked("31", "eval-supermaerkte-bayern", "two words", "run:x"))
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == NOT_PICKED_DATASET
    assert core.requests == []


async def test_newer_picks_that_name_no_bundle_leave_an_older_bundle_pick() -> None:
    """Catalog slugs and layer_project_ids picked after a bundle are no
    bundle of the user's, so they do not count against the lookups."""
    newer = [f"slug-{n}" if n % 2 else str(30 + n) for n in range(MAX_BUNDLE_LOOKUPS)]
    members = [{"layer_id": DATASET, "role": None, "name": "Schools"}]
    core = _core(**{f"GET /api/v2/bundle/{BUNDLE}/layers": members})
    out = await execute(
        ADD_DATASET, _env(core, _picked(BUNDLE, *newer)), {"dataset_id": DATASET}
    )
    assert [layer["layer_project_id"] for layer in out["layers"]] == [12]
    assert core.paths() == [f"/api/v2/bundle/{BUNDLE}/layers", READ, ADD]


async def test_bundle_lookups_are_capped() -> None:
    picks = [f"b0000000-0000-0000-0000-{n:012d}" for n in range(20)]
    core = _core()
    with pytest.raises(ToolFailed):
        await execute(ADD_DATASET, _env(core, _picked(*picks)), {"dataset_id": DATASET})
    assert 0 < len(core.requests) <= MAX_BUNDLE_LOOKUPS
    assert not _posted(core)


CATALOG_RESOLVE = f"/stac/resolve/{DATASET}"


async def test_a_catalog_dataset_is_sent_to_the_catalog_add_tool() -> None:
    """A catalog id picked in a card's adds and given to this tool: the
    error names the tool that adds it."""
    core = _core(**{f"GET {READ}": httpx.Response(404, json={"detail": "no"})})
    catalog = Recorder(
        {("GET", CATALOG_RESOLVE): {"kind": "item", "item": {"id": DATASET}}}
    )
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    env.asks = _picked("boundary", adds=[DATASET])
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == catalog_dataset(DATASET)
    # The catalog resolves a bundle's id as well.
    assert "is a catalog dataset or bundle" in caught.value.message
    assert "project_add_catalog_layer adds it" in caught.value.message
    assert not _posted(core)


@pytest.mark.parametrize("status", [403, 404])
async def test_an_id_neither_service_knows_stays_unreadable(status: int) -> None:
    """Another user's private dataset (403) reads as an unknown id (404)."""
    core = _core(**{f"GET {READ}": httpx.Response(status, json={"detail": "no"})})
    catalog = Recorder(
        {("GET", CATALOG_RESOLVE): httpx.Response(404, json={"detail": "no"})}
    )
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    env.asks = _picked(DATASET)
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert caught.value.message == CANNOT_READ_DATASET
    assert catalog.paths() == [CATALOG_RESOLVE]


async def test_an_add_the_user_can_read_asks_the_catalog_nothing() -> None:
    core = _core()
    catalog = Recorder()
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    env.asks = _picked(DATASET)
    await execute(ADD_DATASET, env, {"dataset_id": DATASET})
    assert catalog.requests == []
