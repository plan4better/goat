"""The map suite: its tasks and the checks that grade them on what core
stored (``style``, ``map``) and on the view the answer set (``view``). No
model: every transcript is made by hand, and the right answers are applied
to the stand-in through its own routes."""

import copy
import dataclasses
import json
from collections.abc import Iterator
from typing import Any

import pytest
from goatlib.style.catalog import icon_libraries

from assistant.asks import AskOption, AskQuestion, AskUserInput
from assistant.context import parse_context
from assistant.tools.styles import ASKED_NOT_SAID
from assistant.tools.testing import ScriptedModel, TurnModel
from evals.backends import (
    RESULT_LAYER,
    Backends,
    selected_features,
    write_eval_catalog,
)
from evals.graders import grade
from evals.harness import ToolCall, Transcript, auto_answer, map_states, run_task
from evals.map_backends import MapState
from evals.map_fixture import (
    LAND_USE_QUERY,
    MAP_LAYERS,
    MAP_PROJECT_ID,
    MAP_RESULT_LAYER,
    MAP_VIEW_PROJECT_ID,
    map_layer,
)
from evals.map_graders import class_shares, grade_map, grade_style
from evals.tasks import (
    EVAL_SET_VERSION,
    AnswerCheck,
    AskedCheck,
    ClassRule,
    ColorRule,
    EvalTask,
    JudgeCheck,
    LayerRule,
    LegendRule,
    MapCheck,
    PathRule,
    StyleCheck,
    ToolsCheck,
    ViewCheck,
    load_tasks,
)
from tests.eval_map_answers import (
    _ICON_CLASSES,
    ANSWERS,
    FIRST_MADE,
    SECOND_MADE,
    Answer,
    Api,
    _call,
    _symbol,
    applied,
    played,
)


@pytest.fixture(scope="module")
def backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-map")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


def _transcript(answer: str = "Done.", **fields: Any) -> Transcript:
    values: dict[str, Any] = {
        "task_id": "map-00",
        "answer": answer,
        "tool_calls": [],
        "proposals": [],
        "requests": {},
        "error": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "seconds": 0.0,
        "first_text_seconds": None,
    }
    values.update(fields)
    return Transcript(**values)


def _run(change: Any, layer: int = 31) -> tuple[MapState, Transcript]:
    """A fresh map project, its snapshot, ``change`` applied through the
    stand-in's routes, and the transcript with both snapshots."""
    state = MapState()
    before = state.snapshot()
    change(Api(state))
    return state, _transcript(map_before=before, map_after=state.snapshot())


def _density(method: str, count: int) -> Any:
    def change(api: Api) -> None:
        api.edit(
            31,
            lambda d: d.update(
                classify=[
                    {
                        "field": "density",
                        "method": method,
                        "count": count,
                        "palette": "colorbrewer:OrRd",
                    }
                ]
            ),
        )

    return change


def _density_check(**changes: Any) -> StyleCheck:
    rule = {
        "field": "density",
        "target": "fill.color",
        "methods": ["quantile", "natural_breaks", "heads_and_tails"],
        "min_classes": 4,
        "max_classes": 7,
        "palette_kind": "sequential",
    }
    return StyleCheck(
        kind="style",
        layer_project_id=31,
        where="any",
        classification=ClassRule(**{**rule, **changes}),
        legend=LegendRule(max_share=0.6),
    )


# ---- the task set ------------------------------------------------------------------


def test_the_map_suite_loads_fifty_six_tasks_on_the_map_page() -> None:
    tasks = load_tasks("map")
    assert len(tasks) == 56
    assert [t.id for t in tasks] == [f"map-{n:02d}" for n in range(1, 57)]
    assert {t.context["surface"] for t in tasks} == {"project.map"}
    assert {t.context["project_id"] for t in tasks} <= {
        MAP_PROJECT_ID,
        MAP_VIEW_PROJECT_ID,
    }
    for task in tasks:
        parse_context(task.context)
        assert any(c.kind == "language" for c in task.checks), task.id
    assert sorted(t.id for t in tasks if t.critical) == [
        "map-01",
        "map-11",
        "map-15",
        "map-22",
        "map-24",
        "map-25",
    ]
    assert sorted(t.id for t in tasks if t.undo) == ["map-20", "map-21", "map-31"]
    assert [t.id for t in tasks if t.answer_card] == ["map-17", "map-25", "map-51"]
    assert [t.id for t in tasks if t.conversation] == [
        "map-48",
        "map-49",
        "map-50",
        "map-51",
    ]
    assert [t.id for t in tasks if any(r.cold_requests for r in t.messages)] == [
        "map-49"
    ]
    assert EVAL_SET_VERSION == 33


def test_only_a_request_that_asks_for_a_new_style_accepts_one() -> None:
    """A style is changed in place. The two tasks whose style check wants a
    new style ask for one in words; no check takes either."""
    wants: dict[str, list[str]] = {}
    for task in load_tasks("map"):
        for check in task.checks:
            if isinstance(check, StyleCheck):
                wants.setdefault(check.where, []).append(task.id)
    assert "any" not in wants
    assert wants["new"] == ["map-17", "map-21"]
    assert len(wants["same"]) == 37
    prompts = {t.id: t.prompt.casefold() for t in load_tasks("map")}
    assert "as separate styles" in prompts["map-17"]
    assert "two style options" in prompts["map-17"]
    assert "new style" in prompts["map-21"]
    assert "keep the current one" in prompts["map-21"]
    # Their right answers quote those words in new_style.asked.
    for task_id in ("map-17", "map-21"):
        quoted = [
            c.args["new_style"]["asked"].casefold()
            for c in ANSWERS[task_id].calls
            if c.name == "style_update"
        ]
        assert quoted and all(q in prompts[task_id] for q in quoted), task_id


def test_a_map_task_must_be_on_the_map_page() -> None:
    line = {
        "id": "map-90",
        "suite": "map",
        "context": {"surface": "project.workflows", "project_id": MAP_PROJECT_ID},
        "prompt": "Color the districts.",
        "checks": [{"kind": "language", "expected": "en"}],
    }
    with pytest.raises(ValueError, match="map suite"):
        EvalTask.model_validate(line)
    with pytest.raises(ValueError, match="answer_card"):
        EvalTask.model_validate(
            {
                **line,
                "context": {"surface": "project.map", "project_id": MAP_PROJECT_ID},
                "answer_value": "remove_layer:39",
            }
        )


def test_a_path_rule_says_what_it_expects() -> None:
    with pytest.raises(ValueError):
        PathRule(path="/symbol/fill/color")


def test_the_literal_numbers_of_the_tasks_follow_the_fixture() -> None:
    tasks = {t.id: t for t in load_tasks("map")}
    bus = sum(f["frequency_per_hour"] >= 6 for f in map_layer(33).features)
    (check,) = [c for c in tasks["map-23"].checks if isinstance(c, MapCheck)]
    assert check.layers[33].filter_count == bus
    residential_left_out = {
        "op": "and",
        "args": [
            *LAND_USE_QUERY["cql"]["args"],
            {"op": "<>", "args": [{"property": "use"}, "residential"]},
        ],
    }
    land_use = len(selected_features(map_layer(34), residential_left_out))
    (check,) = [c for c in tasks["map-24"].checks if isinstance(c, MapCheck)]
    assert check.layers[34].filter_count == land_use
    (style,) = [c for c in tasks["map-05"].checks if isinstance(c, StyleCheck)]
    width = MapState().styles[MapState().active_style_id(31)].document["symbol"]
    assert style.paths[0].below == width["outline"]["width"]
    (style,) = [c for c in tasks["map-08"].checks if isinstance(c, StyleCheck)]
    icons = {
        f"{prefix}:{name}"
        for prefix, names in icon_libraries().items()
        for name in names
    }
    assert style.paths[0].one_of and set(style.paths[0].one_of) <= icons


# ---- style -------------------------------------------------------------------------


def test_a_style_check_passes_on_a_quantile_classification() -> None:
    _, transcript = _run(_density("quantile", 5))
    passed, detail = grade_style(_density_check(), transcript)
    assert passed, detail


def test_a_style_check_fails_when_one_class_holds_most_features() -> None:
    # Equal intervals over the long tail of density put most districts into
    # the first of three classes.
    _, transcript = _run(_density("equal_interval", 3))
    check = _density_check(methods=["equal_interval"], min_classes=3)
    passed, detail = grade_style(check, transcript)
    assert not passed and "share" in detail, detail
    document = transcript.map_after["styles"][
        transcript.map_after["layers"][31]["active_style_id"]
    ]["document"]
    shares, other, no_value = class_shares(
        document, "/classify/density", map_layer(31).features
    )
    assert max(shares) == pytest.approx(0.8, abs=0.01)
    assert (other, no_value) == (0.0, 0.0)


@pytest.mark.parametrize(
    "method",
    ["quantile", "natural_breaks", "equal_interval", "std_dev", "geometric_interval"],
)
def test_every_method_map_01_allows_passes_it_on_the_fixture(method: str) -> None:
    task = next(t for t in load_tasks("map") if t.id == "map-01")
    (check,) = [c for c in task.checks if isinstance(c, StyleCheck)]
    assert check.classification is not None
    assert sorted(check.classification.methods) == sorted(
        [
            "quantile",
            "natural_breaks",
            "equal_interval",
            "std_dev",
            "geometric_interval",
        ]
    )
    for count in (4, 5, 6):
        passed, detail = grade_style(check, _run(_density(method, count))[1])
        assert passed, (count, detail)


def test_heads_and_tails_cannot_split_density_into_four_classes() -> None:
    task = next(t for t in load_tasks("map") if t.id == "map-01")
    (check,) = [c for c in task.checks if isinstance(c, StyleCheck)]
    rule = check.classification
    assert rule is not None and "heads_and_tails" not in rule.methods
    widened = check.model_copy(
        update={
            "classification": rule.model_copy(update={"methods": ["heads_and_tails"]})
        }
    )
    passed, detail = grade_style(widened, _run(_density("heads_and_tails", 5))[1])
    assert not passed and "2 classes" in detail


def test_a_style_check_fails_on_a_wrong_method_count_target_or_palette_kind() -> None:
    _, transcript = _run(_density("quantile", 3))
    assert "classes" in grade_style(_density_check(), transcript)[1]
    _, transcript = _run(_density("equal_interval", 5))
    assert "method" in grade_style(_density_check(), transcript)[1]
    _, transcript = _run(_density("quantile", 5))
    passed, detail = grade_style(_density_check(target="outline.color"), transcript)
    assert not passed and "target" in detail
    passed, detail = grade_style(_density_check(palette_kind="diverging"), transcript)
    assert not passed and "palette" in detail


def test_a_style_check_fails_on_a_stored_error() -> None:
    state = MapState()
    before = state.snapshot()
    style_id = state.active_style_id(31)
    # Core never stores an error; a stand-in bug or a direct write would.
    state.styles[style_id].document["symbol"]["label"] = {"text": "{missing}"}
    transcript = _transcript(map_before=before, map_after=state.snapshot())
    check = StyleCheck(kind="style", layer_project_id=31, where="same")
    passed, detail = grade_style(check, transcript)
    assert not passed and "unknown_field" in detail, detail


def test_same_fails_when_a_new_style_was_made_and_new_fails_when_edited_in_place() -> (
    None
):
    def lighter(document: dict[str, Any]) -> None:
        document["symbol"]["fill"]["opacity"] = 0.4

    _, in_place = _run(lambda api: api.edit(31, lighter))
    _, made = _run(lambda api: api.new_style(31, "Lighter", lighter))
    _, unused = _run(lambda api: api.new_style(31, "Lighter", lighter, activate=False))
    same = StyleCheck(kind="style", layer_project_id=31, where="same")
    new = StyleCheck(kind="style", layer_project_id=31, where="new", variants=1)
    any_ = StyleCheck(kind="style", layer_project_id=31, where="any")
    assert grade_style(same, in_place)[0]
    assert not grade_style(same, made)[0]
    assert grade_style(new, made)[0]
    assert not grade_style(new, in_place)[0]
    assert grade_style(any_, made)[0] and grade_style(any_, in_place)[0]
    # A style made but left inactive while the active one is unchanged.
    assert not grade_style(same, unused)[0] and not grade_style(any_, unused)[0]
    two = StyleCheck(kind="style", layer_project_id=31, where="new", variants=2)
    assert "variant" in grade_style(two, made)[1]


def _map_task(task_id: str) -> EvalTask:
    return next(t for t in load_tasks("map") if t.id == task_id)


def _style_check(task: EvalTask) -> StyleCheck:
    [check] = [c for c in task.checks if isinstance(c, StyleCheck)]
    return check


class _NewStyleApi(Api):
    """An answer that makes a new named style where the right one edits in
    place."""

    def edit(self, link: int, change: Any) -> None:
        self.new_style(link, "Another look", change)


@pytest.mark.parametrize(
    "task_id",
    [
        "map-01",
        "map-02",
        "map-07",
        "map-09",
        "map-10",
        "map-12",
        "map-15",
        "map-16",
        "map-19",
        "map-35",
    ],
)
def test_a_new_style_nobody_asked_for_fails_the_task(task_id: str) -> None:
    task = _map_task(task_id)
    check = _style_check(task)
    assert check.where == "same"
    assert grade_style(check, applied(task, ANSWERS[task_id]))[0]
    states, state = map_states(task)
    assert state is not None
    before = state.snapshot()
    ANSWERS[task_id].run(_NewStyleApi(state))
    made = _transcript(map_before=before, map_after=state.snapshot())
    passed, detail = grade_style(check, made)
    assert not passed and "not edited in place" in detail, detail


def test_the_ids_of_the_styles_made_in_a_task_follow_the_fixture() -> None:
    """map-17 names the styles its answer makes by their ids: the first two
    a task makes in the map project."""
    task = _map_task("map-17")
    states, state = map_states(task)
    assert state is not None
    api = Api(state)
    first = api.new_style(31, "One", lambda d: d["symbol"]["fill"].update(opacity=0.4))
    second = api.new_style(
        31, "Two", lambda d: d["symbol"]["fill"].update(opacity=0.3), activate=False
    )
    assert (first, second) == (FIRST_MADE, SECOND_MADE)
    assert task.answer_value == f"use_style:{second}"
    [asked] = [c for c in task.checks if isinstance(c, AskedCheck)]
    assert asked.offers == [f"use_style:{first}", f"use_style:{second}"]


async def test_variants_need_two_created_styles_and_a_card(backends: Backends) -> None:
    task = _map_task("map-17")
    check = _style_check(task)
    assert (check.where, check.variants, check.active_variant) == ("new", 2, 2)
    right = ANSWERS["map-17"]
    good = applied(task, right)
    grades = await grade(task, good, backends)
    assert all(g.passed for g in grades), [(g.check, g.detail) for g in grades]
    # The card was shown while the first style was the active one.
    assert good.map_before_answer is not None
    assert good.map_before_answer["layers"][31]["active_style_id"] == FIRST_MADE
    assert good.map_after is not None
    assert good.map_after["layers"][31]["active_style_id"] == SECOND_MADE

    def lighter(document: dict[str, Any]) -> None:
        document["symbol"]["fill"]["opacity"] = 0.4

    # One style only.
    _, one = _run(lambda api: api.new_style(31, "One", lighter))
    assert "1 variant(s) made, expected 2" in grade_style(check, one)[1]

    # Two styles, and the pick was never made the active one.
    def two(api: Api) -> None:
        api.new_style(31, "One", lighter)
        api.new_style(31, "Two", lighter, activate=False)

    passed, detail = grade_style(check, _run(two)[1])
    assert not passed and "the style made 1st is active, expected the 2nd" in detail
    # The pick made active, but no card was shown.
    silent = applied(task, dataclasses.replace(right, calls=[]))
    grades = await grade(task, silent, backends)
    failed = [g.check for g in grades if not g.passed]
    assert failed == ["asked"]
    # Variants made of one style edited in place twice are no variants.
    _, in_place = _run(lambda api: api.edit(31, lighter))
    assert not grade_style(check, in_place)[0]


async def test_a_heatmap_asked_for_is_an_edit_without_a_card(
    backends: Backends,
) -> None:
    task = _map_task("map-35")
    good = applied(task, ANSWERS["map-35"])
    assert all(g.passed for g in await grade(task, good, backends))
    asked = dataclasses.replace(
        good, tool_calls=[ToolCall("ask_user", {"questions": []}, {}, False)]
    )
    failed = [g.check for g in await grade(task, asked, backends) if not g.passed]
    assert failed == ["tools"]


#: The open requests: no change named, the layer selected on the page.
OPEN_REQUESTS = {"map-42": 40, "map-43": 33, "map-44": 32}
#: About 50 words and a possible line before the tools; German words are longer.
OPEN_REQUEST_CHARS = {"map-42": 520, "map-43": 600, "map-44": 520}


def test_the_open_requests_edit_in_place_with_the_skill_and_no_card() -> None:
    for task_id, link in OPEN_REQUESTS.items():
        task = _map_task(task_id)
        assert task.context["selected_layer_project_id"] == link, task_id
        check = _style_check(task)
        assert (check.layer_project_id, check.where) == (link, "same"), task_id
        [tools] = [c for c in task.checks if isinstance(c, ToolsCheck)]
        assert tools.called == ["skills_load", "style_update"], task_id
        assert tools.not_called == ["ask_user"], task_id
        # A palette lookup may help; the fixtures need no icon.
        assert tools.at_most == {"style_update": 2, "style_catalog": 1}, task_id
        [answer] = [c for c in task.checks if isinstance(c, AnswerCheck)]
        # Text written before the tool calls counts toward the answer.
        assert answer.max_chars == OPEN_REQUEST_CHARS[task_id], task_id
        assert len(ANSWERS[task_id].answer) <= 300, task_id
    assert _map_task("map-43").locale == "de"
    assert _map_task("map-42").prompt == "Can we improve the styling of this layer?"


async def test_two_new_styles_and_a_card_fail_the_open_request(
    backends: Backends,
) -> None:
    """The answer the open request must not get: two named styles, the
    second left for a card, after a long answer that lists every class."""
    task = _map_task("map-42")
    right = ANSWERS["map-42"]
    assert all(g.passed for g in await grade(task, applied(task, right), backends))

    def two_styles(api: Api) -> None:
        api.new_style(40, "Stations by lines", _symbol("marker", size=10))
        api.new_style(40, "Stations as icons", _symbol("marker", size=14), False)

    card = ToolCall("ask_user", {"questions": []}, {"card_id": "ask-1"}, False)
    wrong = Answer(
        two_styles,
        calls=[
            _call("style_get"),
            ToolCall("style_update", {}, {}, False),
            ToolCall("style_update", {}, {}, False),
            card,
        ],
        answer="Here are two styles. " + "One class holds 12 stations. " * 30,
    )
    failed = {
        g.check
        for g in await grade(task, applied(task, wrong), backends)
        if not g.passed
    }
    assert failed == {"style", "tools", "answer"}


async def test_the_refusal_is_short_and_writes_nothing(backends: Backends) -> None:
    task = _map_task("map-45")
    [tools] = [c for c in task.checks if isinstance(c, ToolsCheck)]
    assert {"ask_user", "map_update", "style_update"} <= set(tools.not_called)
    [answer] = [c for c in task.checks if isinstance(c, AnswerCheck)]
    assert answer.max_chars == 500
    [judge] = [c for c in task.checks if isinstance(c, JudgeCheck)]
    for said in (
        "at most three sentences",
        "one next step the user can take in the interface",
        "one alternative the tools can do",
        "a how-to list of more than one sequence of steps",
        "remarks about earlier turns",
        "explanations of the tools",
    ):
        assert said in judge.rubric, said
    assert any(isinstance(c, MapCheck) and c.writes == "none" for c in task.checks)
    right = applied(task, ANSWERS["map-45"])
    long = dataclasses.replace(
        right, answer="You cannot draw here. Step one: open the layer. " * 12
    )
    failed = [g.check for g in await grade(task, long, backends) if g.passed is False]
    assert failed == ["answer"]


BLUES = [
    "colorbrewer:Blues",
    "colorbrewer:PuBu",
    "colorbrewer:GnBu",
    "colorbrewer:YlGnBu",
]


def test_the_two_tasks_that_bound_the_calls_of_one_request() -> None:
    """An icon for the selected points, and a numeric field of the layer with
    a saved filter in five blue classes: few calls, no counting by hand, no
    card."""
    icon, blues = _map_task("map-36"), _map_task("map-37")
    assert icon.context["selected_layer_project_id"] == 40
    assert map_layer(40).geometry == "point"
    assert blues.context["selected_layer_project_id"] == 34
    assert map_layer(34).fields["area_m2"] == "number"
    assert MapState().layers[34]["query"] == LAND_USE_QUERY
    [icon_tools] = [c for c in icon.checks if isinstance(c, ToolsCheck)]
    assert icon_tools.at_most == {"style_catalog": 3, "style_update": 2}
    assert icon_tools.not_called == ["ask_user"]
    [blue_tools] = [c for c in blues.checks if isinstance(c, ToolsCheck)]
    assert blue_tools.at_most == {
        "style_update": 2,
        "project_count_features+project_group_statistics": 1,
    }
    assert blue_tools.not_called == ["ask_user"]
    check = _style_check(blues)
    assert check.classification is not None
    assert check.classification.field == "area_m2"
    assert (check.classification.min_classes, check.classification.max_classes) == (
        5,
        5,
    )
    assert check.paths == [PathRule(path="/classify/area_m2/palette", one_of=BLUES)]
    # Classed over what the map draws: no class holds most drawn features.
    assert check.legend == LegendRule(max_share=0.45)
    assert not icon.critical and not blues.critical


async def test_blue_classes_over_the_whole_dataset_fail_the_filtered_layer(
    backends: Backends,
) -> None:
    """A computed method classes all 300 land use features; the 39 the saved
    filter keeps then fall mostly into the top class. The right answer reads
    the statistics as drawn and writes their breaks as manual classes."""
    task = _map_task("map-37")
    right = ANSWERS["map-37"]
    assert all(g.passed for g in await grade(task, applied(task, right), backends))
    [read] = [c for c in right.calls if c.name == "project_field_statistics"]
    assert read.args["as_drawn"] is True

    def quantile(document: dict[str, Any]) -> None:
        document["classify"] = [
            {
                "field": "area_m2",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:Blues",
            }
        ]

    _, whole = _run(lambda api: api.edit(34, quantile))
    passed, detail = grade_style(_style_check(task), whole)
    assert not passed and "one class holds a share" in detail, detail


async def test_an_icon_answer_with_more_calls_or_a_card_fails(
    backends: Backends,
) -> None:
    task = _map_task("map-36")
    right = ANSWERS["map-36"]
    assert all(g.passed for g in await grade(task, applied(task, right), backends))
    lookups = [
        ToolCall("style_catalog", {"kind": "icons", "query": w}, {}, False)
        for w in "abcd"
    ]
    many = dataclasses.replace(right, calls=lookups)
    failed = [
        g.check
        for g in await grade(task, applied(task, many), backends)
        if not g.passed
    ]
    assert failed == ["tools"]
    card = ToolCall("ask_user", {"questions": []}, {"card_id": "ask-1"}, False)
    asked = dataclasses.replace(right, calls=[*right.calls, card])
    failed = [
        g.check
        for g in await grade(task, applied(task, asked), backends)
        if not g.passed
    ]
    assert failed == ["tools"]
    _, plain = _run(
        lambda api: api.edit(40, lambda d: d["symbol"]["marker"].update(size=14))
    )
    assert not grade_style(_style_check(task), plain)[0]


async def test_an_html_popup_needs_the_popup_file_html_mode_and_the_condition(
    backends: Backends,
) -> None:
    """The name as a heading and the year only when it is known, written as
    HTML: the stored popup is a template that names the name and tests the
    year, after the skill's popup file was loaded."""
    task = _map_task("map-46")
    right = ANSWERS["map-46"]
    assert all(g.passed for g in await grade(task, applied(task, right), backends))
    assert map_layer(32).fields["opening_year"] == "integer"
    [loaded] = [c for c in right.calls if c.args.get("file") == "popups.md"]
    assert loaded.name == "skills_load"
    unloaded = dataclasses.replace(
        right, calls=[c for c in right.calls if c is not loaded]
    )
    failed = [
        g.check
        for g in await grade(task, applied(task, unloaded), backends)
        if not g.passed
    ]
    assert failed == ["tools"]

    def popup(value: dict[str, Any]) -> Any:
        return lambda api: api.edit(32, lambda d: d.update(popup=value))

    blocks = {
        "blocks": [
            {
                "type": "field_list",
                "attributes": [{"field": "name"}, {"field": "opening_year"}],
            }
        ]
    }
    always = {"mode": "html", "html": "<h3>{{ name }}</h3><p>{{ opening_year }}</p>"}
    for wrong in (blocks, always):
        passed, detail = grade_style(_style_check(task), _run(popup(wrong))[1])
        assert not passed and "/popup/" in detail, detail


async def test_icons_per_kind_need_an_icon_on_the_base_marker_too(
    backends: Backends,
) -> None:
    """Points in no class draw the base marker: icons on the classes alone
    leave "Other" without one."""
    task = _map_task("map-47")
    right = ANSWERS["map-47"]
    assert all(g.passed for g in await grade(task, applied(task, right), backends))
    [tools] = [c for c in task.checks if isinstance(c, ToolsCheck)]
    assert tools.at_most == {"style_update": 2, "style_catalog": 3}

    def classes_only(document: dict[str, Any]) -> None:
        document["symbol"]["marker"]["size"] = 18
        document["classify"] = copy.deepcopy(_ICON_CLASSES)

    passed, detail = grade_style(
        _style_check(task), _run(lambda api: api.edit(32, classes_only))[1]
    )
    assert not passed and "/symbol/marker/icon" in detail, detail


async def test_a_blue_classification_counted_by_hand_fails(backends: Backends) -> None:
    task = _map_task("map-37")
    right = ANSWERS["map-37"]
    assert all(g.passed for g in await grade(task, applied(task, right), backends))
    counted = dataclasses.replace(
        right,
        calls=[
            *right.calls,
            ToolCall("project_count_features", {}, {"count": 3}, False),
            ToolCall("project_group_statistics", {}, {}, False),
        ],
    )
    failed = [
        g.check
        for g in await grade(task, applied(task, counted), backends)
        if not g.passed
    ]
    assert failed == ["tools"]
    three = dataclasses.replace(
        right, calls=[ToolCall("style_update", {}, {}, False)] * 3
    )
    failed = [
        g.check
        for g in await grade(task, applied(task, three), backends)
        if not g.passed
    ]
    assert failed == ["tools"]

    def orange(document: dict[str, Any]) -> None:
        document["classify"] = [
            {
                "field": "area_m2",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:OrRd",
            }
        ]

    _, not_blue = _run(lambda api: api.edit(34, orange))
    passed, detail = grade_style(_style_check(task), not_blue)
    assert not passed and "palette" in detail, detail


async def test_a_look_must_not_start_a_run(backends: Backends) -> None:
    task = _map_task("map-15")
    good = applied(task, ANSWERS["map-15"])
    assert all(g.passed for g in await grade(task, good, backends))
    for tool in ("workflow_create", "workflow_run"):
        ran = dataclasses.replace(good, tool_calls=[ToolCall(tool, {}, {}, True)])
        failed = [g.check for g in await grade(task, ran, backends) if not g.passed]
        assert failed == ["tools"], tool


def test_a_style_check_fails_when_nothing_changed() -> None:
    _, transcript = _run(lambda api: None)
    check = StyleCheck(kind="style", layer_project_id=31, where="same")
    passed, detail = grade_style(check, transcript)
    assert not passed and "unchanged" in detail


def test_unchanged_paths_are_compared_with_the_snapshot_before() -> None:
    def thinner(document: dict[str, Any]) -> None:
        document["symbol"]["outline"].update(width=0.5, color="#555555")

    def thinner_and_red(document: dict[str, Any]) -> None:
        thinner(document)
        document["symbol"]["fill"]["color"] = "#ff0000"

    check = StyleCheck(
        kind="style",
        layer_project_id=31,
        where="same",
        paths=[PathRule(path="/symbol/outline/width", below=1)],
        unchanged=["/symbol/fill"],
    )
    assert grade_style(check, _run(lambda api: api.edit(31, thinner))[1])[0]
    passed, detail = grade_style(
        check, _run(lambda api: api.edit(31, thinner_and_red))[1]
    )
    assert not passed and "/symbol/fill" in detail


def test_path_rules_read_classifications_by_field_and_any_of_one_group() -> None:
    def classes(document: dict[str, Any]) -> None:
        document["classify"] = [
            {
                "id": "kinds",
                "field": "category",
                "method": "categories",
                "count": 5,
                "palette": "colorbrewer:Set2",
                "other": {"marker": {"color": "#bdbdbd"}},
            }
        ]

    _, transcript = _run(lambda api: api.edit(32, classes))
    check = StyleCheck(
        kind="style",
        layer_project_id=32,
        where="same",
        classification=ClassRule(
            field="category",
            methods=["categories"],
            min_classes=5,
            max_classes=5,
            palette_kind="qualitative",
        ),
        paths=[PathRule(path="/classify/category/other", exists=True)],
        paths_any=[
            PathRule(path="/symbol/marker/size", above=20),
            PathRule(path="/symbol/marker/shape", equals="circle"),
        ],
    )
    passed, detail = grade_style(check, transcript)
    assert passed, detail
    missing = check.model_copy(
        update={"paths": [PathRule(path="/symbol/casing", exists=True)]}
    )
    assert "/symbol/casing" in grade_style(missing, transcript)[1]


def test_a_value_form_counts_as_a_classification_by_attribute() -> None:
    def diverging(document: dict[str, Any]) -> None:
        document["symbol"]["marker"]["color"] = {
            "field": "turnout_change",
            "palette": "colorbrewer:RdBu",
        }

    _, transcript = _run(lambda api: api.edit(35, diverging))
    rule = ClassRule(
        field="turnout_change",
        methods=["quantile", "by_attribute"],
        palette_kind="diverging",
    )
    check = StyleCheck(
        kind="style", layer_project_id=35, where="any", classification=rule
    )
    assert grade_style(check, transcript)[0]
    strict = check.model_copy(
        update={"classification": rule.model_copy(update={"methods": ["quantile"]})}
    )
    assert not grade_style(strict, transcript)[0]


# ---- colors: automatic, None, transparency -----------------------------------------


#: The tasks on the colors GOAT derives, None and a color's own transparency:
#: the color rule each grades, and the basemap its page shows.
COLOR_TASKS = {
    "map-52": ("outline_follows", "light"),
    "map-53": ("labels_readable", "dark"),
    "map-54": ("fill_half_transparent", "light"),
    "map-55": ("outline_only", "light"),
    "map-56": ("class_none", "light"),
}


def test_the_color_tasks_grade_one_color_rule_each_on_their_basemap() -> None:
    for task_id, (kind, tone) in COLOR_TASKS.items():
        task = _map_task(task_id)
        check = _style_check(task)
        assert [rule.kind for rule in check.colors] == [kind], task_id
        assert task.context["basemap"]["tone"] == tone, task_id
        assert check.colors[0].tone == tone, task_id
        assert check.where == "same" and not task.critical, task_id
    others = [t for t in load_tasks("map") if t.id not in COLOR_TASKS]
    assert not any(
        c.colors for t in others for c in t.checks if isinstance(c, StyleCheck)
    )
    # The outline task colors a layer whose outline starts fixed; the fill
    # tasks start from a fill that is opaque at 0.8 in one color.
    start = MapState()
    districts = start.styles[start.active_style_id(31)].document["symbol"]
    assert districts["outline"]["color"].startswith("#")
    buildings = start.styles[start.active_style_id(36)].document
    assert "classify" not in buildings
    assert buildings["symbol"]["fill"] == {"color": "#008695", "opacity": 0.8}


def _colors(link: int, change: Any, **rule: Any) -> tuple[bool, str]:
    """``change`` (a function of the document) saved on layer ``link`` and
    graded by a style check with one color rule."""
    check = StyleCheck(
        kind="style", layer_project_id=link, where="same", colors=[ColorRule(**rule)]
    )
    return grade_style(check, _run(lambda api: api.edit(link, change))[1])


def _density_classes(**base: Any) -> Any:
    def change(document: dict[str, Any]) -> None:
        document["classify"] = [
            {
                "field": "density",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:YlOrRd",
                **base,
            }
        ]

    return change


def _then(*changes: Any) -> Any:
    def change(document: dict[str, Any]) -> None:
        for step in changes:
            step(document)

    return change


def test_an_outline_follows_the_fill_only_in_auto() -> None:
    """Districts in classes with an outline in a darker shade of each class:
    "auto" passes; the fixed outline they start with, "fill", a classification
    of the outline color and a fixed outline color per class fail."""
    auto = _then(_density_classes(), _symbol("outline", color="auto", width=0.5))
    passed, detail = _colors(31, auto, kind="outline_follows")
    assert passed, detail
    passed, detail = _colors(31, _density_classes(), kind="outline_follows")
    assert not passed and "outline.color" in detail
    same = _then(_density_classes(), _symbol("outline", color="fill"))
    assert not _colors(31, same, kind="outline_follows")[0]

    def outline_classes(document: dict[str, Any]) -> None:
        auto(document)
        document["classify"].append(
            {
                "field": "density",
                "target": "outline.color",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:Reds",
            }
        )

    passed, detail = _colors(31, outline_classes, kind="outline_follows")
    assert not passed and "classification" in detail

    def per_class(document: dict[str, Any]) -> None:
        document["symbol"]["outline"]["color"] = "auto"
        document["classify"] = [
            {
                "field": "density",
                "method": "manual",
                "classes": [
                    {"to": 3000, "fill": {"color": "#fee8c8"}, "outline": {"color": "#b3a290"}},
                    {"from": 3000, "fill": {"color": "#e34a33"}, "outline": {"color": "#9f3424"}},
                ],
            }
        ]  # fmt: skip

    passed, detail = _colors(31, per_class, kind="outline_follows")
    assert not passed and "class" in detail
    # An "auto" outline that draws nothing, or classes that all switch it off.
    for nothing in (
        _then(auto, _symbol("outline", width=0)),
        _then(auto, _symbol("outline", opacity=0)),
    ):
        passed, detail = _colors(31, nothing, kind="outline_follows")
        assert not passed and "no outline" in detail, detail

    def classes_off(document: dict[str, Any]) -> None:
        per_class(document)
        for record in document["classify"][0]["classes"]:
            record["outline"] = False

    passed, detail = _colors(31, classes_off, kind="outline_follows")
    assert not passed and "switches the outline off" in detail, detail


def test_labels_are_readable_on_the_dark_basemap() -> None:
    """Station labels on the dark basemap: text and halo "auto", a text "auto"
    beside the default halo, a white text in a dark halo, and the default pair
    (dark text in a white halo, which meets the floor too) pass; a white text
    in a white halo, or with the halo left out (the default white one), and a
    layer without labels fail."""
    rule = {"kind": "labels_readable", "tone": "dark"}

    def label(**keys: Any) -> Any:
        return _symbol("label", text="{name}", **keys)

    for good in (
        label(color="auto", halo={"color": "auto"}),
        label(color="auto"),
        label(color="#ffffff", halo={"color": "#1f2933", "width": 1.5}),
        label(halo={"color": "auto"}),
        label(),
    ):
        passed, detail = _colors(40, good, **rule)
        assert passed, detail
    for bad in (
        label(color="#ffffff"),
        label(color="#ffffff", halo={"color": "#ffffff", "width": 1}),
        label(color="#ffffff00", halo={"color": "#1f2933"}),
        label(color="#ffffff80", halo={"color": "#1f2933"}),
    ):
        passed, detail = _colors(40, bad, **rule)
        assert not passed and "contrast" in detail, detail
    passed, detail = _colors(40, _symbol("marker", size=12), **rule)
    assert not passed and "no label" in detail


def test_a_half_transparent_fill_is_carried_by_one_of_two() -> None:
    """Buildings start with a fill at 0.8: half transparent is the fill's
    opacity at 0.5 or its color at 50 % with the opacity at 1, never both."""
    rule = {"kind": "fill_half_transparent"}
    for good in (
        _symbol("fill", opacity=0.5),
        _symbol("fill", color="#00869580", opacity=1),
    ):
        passed, detail = _colors(36, good, **rule)
        assert passed, detail
    for bad in (
        _symbol("fill", color="#00869580", opacity=0.5),
        _symbol("fill", color="#00869580"),
        _symbol("fill", opacity=0.4),
        _symbol("fill", opacity=0.5, color="#ff0000"),
    ):
        passed, detail = _colors(36, bad, **rule)
        assert not passed and "fill" in detail, detail


def test_outline_only_draws_no_fill_and_an_outline_in_the_layers_hue() -> None:
    """Buildings (fill #008695, outline "auto") as outlines only: a None fill
    with the outline kept, or the fill off with an outline in the fill color,
    pass. An outline that copies a None fill ("fill"), one in grey, the fill
    off with an "auto" outline (the shade of the default fill color), a fill
    that still draws and no outline fail."""
    rule = {"kind": "outline_only"}
    for good in (
        _symbol("fill", color="#00869500"),
        _then(lambda d: d["symbol"].update(fill=False), _symbol("outline", color="#008695")),
        _then(_symbol("fill", color="#00869500"), _symbol("outline", color="#005e68", width=2)),
    ):  # fmt: skip
        passed, detail = _colors(36, good, **rule)
        assert passed, detail
    for bad, says in (
        (_then(_symbol("fill", color="#00869500"), _symbol("outline", color="fill")), "outline"),
        (_then(_symbol("fill", color="#00869500"), _symbol("outline", color="#333333")), "hue"),
        (lambda d: d["symbol"].update(fill=False), "hue"),
        (_symbol("fill", color="#00000000"), "hue"),
        (_symbol("outline", width=2), "fill"),
        (_then(_symbol("fill", color="#00869500"), lambda d: d["symbol"].update(outline=False)), "outline"),
        (_then(_symbol("fill", color="#00869500"), lambda d: d.update(opacity=0)), "layer"),
    ):  # fmt: skip
        passed, detail = _colors(36, bad, **rule)
        assert not passed and says in detail, detail


def test_one_class_is_hidden_by_a_none_fill_and_the_others_stay() -> None:
    """Land use: the industrial class's fill at None passes; the class
    removed, another class changed too, the fill only made transparent by its
    opacity, or a None color in another hue (its "auto" outline would follow
    that hue) fail."""
    rule = {"kind": "class_none", "field": "use", "value": "industrial"}

    def class_fill(class_id: str, **keys: Any) -> Any:
        def change(document: dict[str, Any]) -> None:
            [record] = [
                c for c in document["classify"][0]["classes"] if c["id"] == class_id
            ]
            record["fill"] = {**record["fill"], **keys}

        return change

    passed, detail = _colors(34, class_fill("c6", color="#b3b3b300"), **rule)
    assert passed, detail
    # The hue is compared without case, as the format reads hex.
    passed, detail = _colors(34, class_fill("c6", color="#B3B3B300"), **rule)
    assert passed, detail

    def class_outline_off(document: dict[str, Any]) -> None:
        class_fill("c6", color="#b3b3b300")(document)
        [record] = [c for c in document["classify"][0]["classes"] if c["id"] == "c6"]
        record["outline"] = False

    def removed(document: dict[str, Any]) -> None:
        classes = document["classify"][0]["classes"]
        classes[:] = [c for c in classes if c["id"] != "c6"]

    for bad, says in (
        (removed, "no class"),
        (_then(class_fill("c6", color="#b3b3b300"), class_fill("c1", color="#e41a1c")), "changed"),
        (class_fill("c6", opacity=0), "None"),
        (class_fill("c6", color="#3182bd00"), "hue"),
        (_then(class_fill("c6", color="#b3b3b300"), lambda d: d["symbol"].update(outline=False)), "border"),
        (class_outline_off, "border"),
    ):  # fmt: skip
        passed, detail = _colors(34, bad, **rule)
        assert not passed and says in detail, detail


def test_the_popup_check_reads_the_fields_the_popup_names() -> None:
    def popup(document: dict[str, Any]) -> None:
        document["popup"] = {
            "blocks": [
                {"type": "field_list", "attributes": [{"field": "name"}]},
                {"type": "text", "html": "<p>Lines: {{ lines }}</p>"},
            ]
        }

    check = StyleCheck(
        kind="style", layer_project_id=40, where="same", popup_fields=["name", "lines"]
    )
    assert grade_style(check, _run(lambda api: api.edit(40, popup))[1])[0]
    _, label_only = _run(
        lambda api: api.edit(40, lambda d: d["symbol"].update(label={"text": "{name}"}))
    )
    assert "popup" in grade_style(check, label_only)[1]


def test_undone_compares_the_snapshot_after_undo_with_the_one_before() -> None:
    def lighter(document: dict[str, Any]) -> None:
        document["symbol"]["fill"]["opacity"] = 0.4

    state = MapState()
    api = Api(state)
    before = state.snapshot()
    original = copy.deepcopy(state.styles[state.active_style_id(31)].document)
    api.edit(31, lighter)
    after = state.snapshot()
    api.edit(31, lambda d: d.update(copy.deepcopy(original)))
    undone = state.snapshot()
    # Undo saves the old document again: a new revision, the same look.
    assert undone["styles"] != before["styles"]
    check = StyleCheck(kind="style", layer_project_id=31, where="same", undone=True)
    good = _transcript(
        map_before=before, map_after=after, map_undone=undone, undo="undone"
    )
    assert grade_style(check, good)[0]
    refused = _transcript(
        map_before=before, map_after=after, map_undone=after, undo="changed_since"
    )
    passed, detail = grade_style(check, refused)
    assert not passed and "undo" in detail.casefold()
    stale = _transcript(
        map_before=before, map_after=after, map_undone=after, undo="undone"
    )
    assert not grade_style(check, stale)[0]


# ---- map ---------------------------------------------------------------------------


def test_a_map_check_reads_visibility_order_groups_basemap_and_filter_count() -> None:
    def change(api: Api) -> None:
        group = api.add_group("Public transport")
        api.tree(
            [
                {"id": group, "type": "group", "order": 0, "parent_id": None},
                {"id": 33, "type": "layer", "order": 0, "parent_id": group},
                {"id": 40, "type": "layer", "order": 1, "parent_id": group},
            ]
        )
        api.group_state(1, visible=False)
        api.project(basemap="dark")
        api.put_layer(
            33,
            query={
                "cql": {"op": ">=", "args": [{"property": "frequency_per_hour"}, 6]}
            },
        )

    _, transcript = _run(change)
    bus = sum(f["frequency_per_hour"] >= 6 for f in map_layer(33).features)
    check = MapCheck(
        kind="map",
        layers={
            33: LayerRule(group="Public transport", filter_count=bus, filter_rows=1),
            40: LayerRule(group="Public transport", visible=True),
            # Hidden through its group.
            31: LayerRule(visible=False, group="Base data"),
            32: LayerRule(
                group="", visible=True, position="top", name="Points of interest"
            ),
        },
        above=[(33, 40), (33, 32)],
        basemap="dark",
    )
    passed, detail = grade_map(check, transcript)
    assert passed, detail
    wrong = MapCheck(kind="map", above=[(40, 33)], basemap="light")
    passed, detail = grade_map(wrong, transcript)
    assert not passed and "above" in detail and "basemap" in detail


def test_the_filter_rows_count_conditions_and_keep_the_area_and_switched_off_rows() -> (
    None
):
    def leave_out(api: Api) -> None:
        query = copy.deepcopy(LAND_USE_QUERY)
        query["cql"]["args"].append(
            {"op": "<>", "args": [{"property": "use"}, "residential"]}
        )
        api.put_layer(34, query=query)

    def drop_area(api: Api) -> None:
        query = copy.deepcopy(LAND_USE_QUERY)
        query["cql"]["args"] = query["cql"]["args"][1:]
        query["ui"].pop("area")
        api.put_layer(34, query=query)

    check = MapCheck(
        kind="map",
        layers={34: LayerRule(filter_rows=3, area_kept=True, off_rows=1)},
    )
    assert grade_map(check, _run(leave_out)[1])[0]
    passed, detail = grade_map(check, _run(drop_area)[1])
    assert not passed and "area" in detail


def test_an_area_is_graded_by_its_pieces_and_the_rows_by_what_they_were() -> None:
    from goatlib.filter.areas import add_feature, add_view, area_of, filter_fits
    from goatlib.filter.rows import Rows, read_rows, write_rows

    from evals.backends import AREA_REGIONS

    def region_and_view(api: Api, *, outside: bool = False) -> None:
        name, outline = AREA_REGIONS["DEZ02"]
        added = add_feature(
            (), "region", "DEZ02", outline, name=name, fits=filter_fits()
        )
        assert added is not None
        viewed = add_view(added.pieces, (12.3, 51.3, 12.4, 51.4), fits=filter_fits())
        assert viewed is not None
        cql, notes = area_of(viewed.pieces, outside=outside)
        api.put_layer(32, query=write_rows(Rows("all", (), area=cql, area_notes=notes)))

    def cleared(api: Api) -> None:
        stored = read_rows(LAND_USE_QUERY, None)
        rows = Rows(stored.match, stored.rows)
        api.put_layer(34, query=write_rows(rows))

    def rows_dropped(api: Api) -> None:
        api.put_layer(34, query=None)

    check = MapCheck.model_validate(
        {
            "kind": "map",
            "layers": {
                "32": {"area": {"regions": ["DEZ02"], "view": True}, "rows_kept": True}
            },
        }
    )
    assert grade_map(check, _run(region_and_view)[1]) == (
        True,
        "the map meets the check",
    )
    passed, detail = grade_map(
        check, _run(lambda api: region_and_view(api, outside=True))[1]
    )
    assert not passed and "32 area outside" in detail
    other = MapCheck.model_validate(
        {"kind": "map", "layers": {"32": {"area": {"layers": [31], "features": 2}}}}
    )
    passed, detail = grade_map(other, _run(region_and_view)[1])
    assert not passed and "regions" in detail and "layers" in detail
    passed, detail = grade_map(other, _run(lambda api: None)[1])
    assert not passed and "32 has no area" in detail
    none = MapCheck.model_validate(
        {"kind": "map", "layers": {"34": {"area": "none", "rows_kept": True}}}
    )
    assert grade_map(none, _run(cleared)[1])[0]
    passed, detail = grade_map(none, _run(lambda api: None)[1])
    assert not passed and "34 still has an area" in detail
    passed, detail = grade_map(none, _run(rows_dropped)[1])
    assert not passed and "34 rows changed" in detail


def test_a_filter_the_stand_in_cannot_evaluate_fails_the_count() -> None:
    state = MapState()
    before = state.snapshot()
    # A condition core accepts but the fixture's matcher does not know.
    state.layers[33]["query"] = {
        "cql": {"op": "a_contains", "args": [{"property": "name"}, ["Line 1"]]}
    }
    transcript = _transcript(map_before=before, map_after=state.snapshot())
    check = MapCheck(kind="map", layers={33: LayerRule(filter_count=24)})
    passed, detail = grade_map(check, transcript)
    assert not passed and "cannot be evaluated" in detail


def test_removed_and_kept() -> None:
    _, transcript = _run(lambda api: api.remove_layer(39))
    assert grade_map(MapCheck(kind="map", removed=[39], kept=[31]), transcript)[0]
    passed, detail = grade_map(MapCheck(kind="map", kept=[39]), transcript)
    assert not passed and "39" in detail
    _, untouched = _run(lambda api: None)
    assert not grade_map(MapCheck(kind="map", removed=[39]), untouched)[0]
    # Before the card answer: the snapshot the harness took then.
    waiting = untouched.map_after
    asked = _transcript(
        map_before=untouched.map_before,
        map_before_answer=waiting,
        map_after=transcript.map_after,
    )
    assert grade_map(MapCheck(kind="map", kept=[39], before_answer=True), asked)[0]
    assert grade_map(MapCheck(kind="map", removed=[39]), asked)[0]
    no_card = _transcript(map_before=untouched.map_before, map_after=waiting)
    assert not grade_map(MapCheck(kind="map", kept=[39], before_answer=True), no_card)[
        0
    ]


def test_writes_none_ignores_nothing_but_the_computed_stamps() -> None:
    _, untouched = _run(lambda api: None)
    assert grade_map(MapCheck(kind="map", writes="none"), untouched)[0]
    _, hidden = _run(lambda api: api.layer_state(38, visible=False))
    # Writing the value it already had is a write the check does not see:
    # the state is the same.
    assert grade_map(MapCheck(kind="map", writes="none"), hidden)[0]
    _, shown = _run(lambda api: api.layer_state(38, visible=True))
    assert not grade_map(MapCheck(kind="map", writes="none"), shown)[0]


def test_undone_on_the_map_compares_the_whole_state() -> None:
    state = MapState()
    api = Api(state)
    before = state.snapshot()
    api.layer_state(34, visible=False)
    api.project(basemap="dark")
    after = state.snapshot()
    api.layer_state(34, visible=True)
    api.project(basemap="light")
    check = MapCheck(kind="map", undone=True)
    good = _transcript(
        map_before=before, map_after=after, map_undone=state.snapshot(), undo="undone"
    )
    assert grade_map(check, good)[0]
    half = copy.deepcopy(good.map_undone)
    half["basemap"] = "dark"
    passed, detail = grade_map(
        check,
        _transcript(map_before=before, map_after=after, map_undone=half, undo="undone"),
    )
    assert not passed and "undo" in detail.casefold()


# ---- view --------------------------------------------------------------------------


def _map_update(
    operations: list[dict[str, Any]], view: dict[str, Any] | None, failed: bool = False
) -> ToolCall:
    return ToolCall(
        "map_update",
        {"operations": operations},
        {"project_id": MAP_PROJECT_ID, "applied": [], "view": view},
        failed,
    )


async def test_the_view_check_reads_map_update(backends: Backends) -> None:
    tilted = _transcript(
        tool_calls=[
            _map_update(
                [{"op": "set_view", "mode": "3d", "pitch": 50}],
                {"camera": {"pitch": 50}, "mode": "3d"},
            ),
            _map_update(
                [{"op": "set_layer", "layer_project_id": 31, "visible": True}], None
            ),
        ]
    )
    check = ViewCheck(kind="view", mode="3d", min_pitch=30)
    task = EvalTask(
        id="map-90",
        suite="map",
        context={"surface": "project.map", "project_id": MAP_PROJECT_ID},
        prompt="Tilt the map.",
        checks=[check],
    )
    assert [g.passed for g in await grade(task, tilted, backends)] == [True]
    flat = _transcript(
        tool_calls=[
            _map_update([{"op": "set_view", "pitch": 10}], {"camera": {"pitch": 10}})
        ]
    )
    assert [g.passed for g in await grade(task, flat, backends)] == [False]
    framed = _transcript(
        tool_calls=[
            _map_update(
                [{"op": "set_view", "fit_layer_project_id": 22}],
                {"bbox": [12.3, 51.3, 12.5, 51.4]},
            )
        ]
    )
    fits = task.model_copy(
        update={"checks": [ViewCheck(kind="view", layer_project_id=22)]}
    )
    assert [g.passed for g in await grade(fits, framed, backends)] == [True]
    refused = _transcript(
        tool_calls=[
            _map_update(
                [{"op": "set_view", "fit_layer_project_id": 22}],
                {"bbox": [12.3, 51.3, 12.5, 51.4]},
                failed=True,
            )
        ]
    )
    assert [g.passed for g in await grade(fits, refused, backends)] == [False]


async def test_proj_11_is_graded_on_map_update(backends: Backends) -> None:
    task = next(t for t in load_tasks("project") if t.id == "proj-11")
    assert task.critical
    transcript = _transcript(
        answer="The map now shows the Bezirke layer.",
        tool_calls=[
            _map_update(
                [{"op": "set_view", "fit_layer_project_id": 22}],
                {"bbox": [12.3, 51.3, 12.5, 51.4]},
            )
        ],
    )
    assert [g.passed for g in await grade(task, transcript, backends)] == [
        True,
        True,
        True,
    ]


# ---- the harness -------------------------------------------------------------------


def test_the_card_answer_can_pick_an_option_by_its_value() -> None:
    card = AskUserInput(
        questions=[
            AskQuestion(
                question="Remove the layer Old boundaries?",
                header="Remove",
                options=[
                    AskOption(label="Keep it", value="keep", recommended=True),
                    AskOption(label="Remove it", value="remove_layer:39"),
                ],
            )
        ]
    )
    answer, text = auto_answer("ask-1", card)
    assert answer.answers[0].options == [0] and text == "Remove: Keep it"
    answer, text = auto_answer("ask-1", card, "remove_layer:39")
    assert answer.answers[0].options == [1] and text == "Remove: Remove it"
    answer, _ = auto_answer("ask-1", card, "remove_layer:12")
    assert answer.answers[0].options == [0]


def test_the_states_of_a_task_start_on_the_basemap_its_page_shows() -> None:
    tasks = {t.id: t for t in load_tasks("map")}
    states, watched = map_states(tasks["map-31"])
    assert watched is states[MAP_PROJECT_ID] and watched.basemap == "dark"
    states, watched = map_states(tasks["map-32"])
    assert watched is states[MAP_VIEW_PROJECT_ID]
    other = next(t for t in load_tasks("project") if t.id == "proj-01")
    assert map_states(other)[1] is None


async def test_the_harness_snapshots_the_map_before_and_after_the_run_and_the_undo(
    backends: Backends, settings: Any
) -> None:
    task = next(t for t in load_tasks("map") if t.id == "map-31")
    model = ScriptedModel(
        calls=[("project_get_layers", {})], answer="Here are the layers."
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert (
        transcript.map_before is not None and transcript.map_before["basemap"] == "dark"
    )
    assert transcript.map_after == transcript.map_before
    # The answer wrote nothing: Undo has nothing to take back.
    assert transcript.undo == "nothing_to_undo"
    assert transcript.map_undone == transcript.map_before
    assert transcript.map_before_answer is None
    plain = next(t for t in load_tasks("project") if t.id == "proj-01")
    transcript = await run_task(
        plain, ScriptedModel(answer="Fine.").model, backends, settings
    )
    assert transcript.map_before is None and transcript.map_after is None


async def test_the_card_is_answered_with_the_tasks_value_and_snapshotted_first(
    backends: Backends, settings: Any
) -> None:
    task = next(t for t in load_tasks("map") if t.id == "map-25")
    card = {
        "questions": [
            {
                "question": "Remove the layer Old boundaries from the project?",
                "header": "Remove",
                "options": [
                    {"label": "Keep it", "value": "keep", "recommended": True},
                    {"label": "Remove it", "value": "remove_layer:39"},
                ],
            }
        ]
    }
    # The card offers the value only after the removal asked for it.
    removal = {"operations": [{"op": "remove_layer", "layer_project_id": 39}]}
    model = TurnModel(
        [
            ([("map_update", removal), ("ask_user", card)], "Should I remove it?"),
            ([], "I left it for now."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert transcript.map_before_answer == transcript.map_before
    assert transcript.map_after == transcript.map_before
    second = json.dumps(
        [getattr(m, "parts", []) for m in model.requests[-1]],
        default=str,
        ensure_ascii=False,
    )
    assert "Remove: Remove it (value remove_layer:39)" in second


async def test_the_variants_task_can_pass_through_the_tools(
    backends: Backends, settings: Any
) -> None:
    """map-17 end to end on the stand-ins: two named styles made with
    style_update, the card with their ids, the eval user's pick of the
    second, and map_update making it the drawn one."""
    task = _map_task("map-17")
    classes = {
        "layer_project_id": 31,
        "new_style": {
            "name": "Density in classes",
            "start": "current",
            "asked": "two style options",
        },
        "operations": [
            {
                "op": "set",
                "path": "/classify",
                "value": [
                    {
                        "field": "density",
                        "method": "quantile",
                        "count": 5,
                        "palette": "colorbrewer:YlOrRd",
                    }
                ],
            }
        ],
    }
    ramp = {
        "layer_project_id": 31,
        "new_style": {
            "name": "Density as a ramp",
            "start": "current",
            "asked": "as separate styles",
        },
        "make_active": False,
        "operations": [
            {"op": "set", "path": "/classify", "value": []},
            {
                "op": "set",
                "path": "/symbol/fill/color",
                "value": {"field": "density", "palette": "colorbrewer:YlGnBu"},
            },
        ],
    }
    card = {
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
    }
    pick = {
        "operations": [
            {"op": "set_layer", "layer_project_id": 31, "active_style_id": SECOND_MADE}
        ]
    }
    model = TurnModel(
        [
            (
                [("style_update", classes), ("style_update", ramp), ("ask_user", card)],
                "Two looks for the districts are ready.",
            ),
            ([("map_update", pick)], "The smooth ramp is the active style now."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert not any(call.failed for call in transcript.tool_calls), [
        (call.name, call.result) for call in transcript.tool_calls if call.failed
    ]
    made = [
        call.result["style_id"]
        for call in transcript.tool_calls
        if call.name == "style_update"
    ]
    assert made == [FIRST_MADE, SECOND_MADE]
    grades = await grade(task, transcript, backends)
    assert all(g.passed for g in grades), [(g.check, g.detail) for g in grades]


async def test_a_new_style_the_eval_user_did_not_ask_for_is_refused(
    backends: Backends, settings: Any
) -> None:
    """The harness gives the tools what the eval user typed, as a run does:
    a quote that is not in the prompt makes no style."""
    task = _map_task("map-01")
    call = {
        "layer_project_id": 31,
        "new_style": {
            "name": "Density",
            "start": "current",
            "asked": "as a new style",
        },
        "operations": [{"op": "set", "path": "/opacity", "value": 0.7}],
    }
    model = TurnModel([([("style_update", call)], "Done.")])
    transcript = await run_task(task, model.model, backends, settings)
    [made] = [c for c in transcript.tool_calls if c.name == "style_update"]
    assert made.failed and ASKED_NOT_SAID in str(made.result)
    assert transcript.map_after == transcript.map_before


async def test_the_removal_task_can_pass_through_the_tools(
    backends: Backends, settings: Any
) -> None:
    """map-25 end to end on the stand-ins: the removal's first call answers
    what to ask and fails no step, the card carries its value, and the same
    call removes the layer after the pick."""
    task = _map_task("map-25")
    remove = {"operations": [{"op": "remove_layer", "layer_project_id": 39}]}
    card = {
        "questions": [
            {
                "question": "Remove the layer Old boundaries from the project?",
                "header": "Remove",
                "options": [
                    {"label": "Remove it", "value": "remove_layer:39"},
                    {"label": "Keep it", "value": "keep"},
                ],
            }
        ]
    }
    model = TurnModel(
        [
            (
                [("map_update", remove), ("ask_user", card)],
                "A dashboard, a workflow and a print layout use this layer.",
            ),
            ([("map_update", remove)], "The layer Old boundaries is removed."),
        ]
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert not any(call.failed for call in transcript.tool_calls)
    first, _, second = (call.result for call in transcript.tool_calls)
    assert first["applied"] == [] and first["confirm"][0]["value"] == "remove_layer:39"
    assert "repeated_call" not in second and second["confirm"] == []
    assert [op["op"] for op in second["applied"]] == ["remove_layer"]
    grades = await grade(task, transcript, backends)
    assert all(g.passed for g in grades), [(g.check, g.detail) for g in grades]


# ---- a workflow's result on the map --------------------------------------------------

CATCHMENT_DRAFT: dict[str, Any] = {
    "name": "Walking catchments around the stations",
    "steps": [
        {"id": "stations", "kind": "dataset", "layer": 40},
        {
            "id": "walk",
            "kind": "tool",
            "tool": "catchment_area_v2",
            "settings": {"routing_mode": "walking", "max_cost": 15, "steps": 3},
        },
        {"id": "save", "kind": "export", "name": "Walking catchments"},
    ],
    "connections": [
        {"from": "stations", "to": "walk", "input": "starting_points"},
        {"from": "walk", "to": "save"},
    ],
}
CREATED = "0b6f0000-0000-0000-0000-000000000001"
RESULT = MAP_RESULT_LAYER.layer_project_id
HALF_TRANSPARENT = {
    "layer_project_id": RESULT,
    "operations": [
        {"op": "set", "path": "/symbol/fill/opacity", "value": 0.5},
        {
            "op": "set",
            "path": "/symbol/outline",
            "value": {"color": "#333333", "width": 0.5},
        },
    ],
}


def _built_and_run(*more: tuple[str, dict[str, Any]], answer: str) -> ScriptedModel:
    """On the map page the workflow tools come with the skill
    build-a-workflow (``SKILL_TOOLS``): it is loaded first."""
    return ScriptedModel(
        calls=[
            ("skills_load", {"name": "build-a-workflow"}),
            ("workflow_create", {"draft": CATCHMENT_DRAFT}),
            ("workflow_run", {"workflow_id": CREATED}),
            *more,
        ],
        answer=answer,
    )


async def test_a_finished_run_puts_its_result_on_the_map_with_the_tools_look(
    backends: Backends, settings: Any
) -> None:
    """A workflow is created and run in the map project, and the layer its
    run saves is in the project with the look the catchment tool gives its
    result: one class per travel time step, yellow to green."""
    task = _map_task("map-34")
    model = _built_and_run(
        ("project_get_layers", {}),
        ("style_get", {"layer_project_id": RESULT}),
        answer="The catchment areas are on the map.",
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert not any(call.failed for call in transcript.tool_calls), [
        (call.name, call.result) for call in transcript.tool_calls if call.failed
    ]
    _, create, run, layers, style = (call.result for call in transcript.tool_calls)
    assert [row["project_id"] for row in transcript.saved] == [MAP_PROJECT_ID]
    assert run["status"] == "succeeded", run
    [saved] = run["saved"]
    assert saved["layer_project_id"] == RESULT
    assert [f["name"] for f in saved["fields"]] == list(MAP_RESULT_LAYER.fields)
    listed = {row["layer_project_id"]: row for row in layers["layers"]}
    assert listed[RESULT]["name"] == "Walking catchments"
    assert "cost_step" in listed[RESULT]["style"]["summary"]
    [classification] = style["document"]["classify"]
    assert (classification["field"], classification["method"]) == (
        "cost_step",
        "categories",
    )
    assert classification["palette"] == "colorbrewer:YlGn"
    assert [c["values"] for c in classification["classes"]] == [[5], [10], [15]]
    before, after = transcript.map_before, transcript.map_after
    assert before is not None and after is not None
    assert RESULT not in before["layers"] and after["layers"][RESULT]["visible"]
    # Drawn above the layers the project had.
    check = MapCheck(kind="map", above=[(RESULT, link) for link in before["layers"]])
    assert grade_map(check, transcript)[0], grade_map(check, transcript)[1]


async def test_the_chained_task_can_pass_through_the_tools(
    backends: Backends, settings: Any
) -> None:
    """map-33 end to end on the stand-ins: build, run, then the result's
    style edited in place."""
    task = _map_task("map-33")
    model = _built_and_run(
        ("style_update", HALF_TRANSPARENT),
        answer="The catchments are half transparent now, with a thin dark outline.",
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert not any(call.failed for call in transcript.tool_calls), [
        (call.name, call.result) for call in transcript.tool_calls if call.failed
    ]
    grades = await grade(task, transcript, backends)
    assert all(g.passed for g in grades), [(g.check, g.detail) for g in grades]


async def test_styling_a_result_before_its_run_finished_fails(
    backends: Backends,
) -> None:
    task = _map_task("map-33")
    good = applied(task, ANSWERS["map-33"])
    assert all(g.passed for g in await grade(task, good, backends))
    early = dataclasses.replace(good, tool_calls=list(reversed(good.tool_calls)))
    failed = {
        g.check: g.detail for g in await grade(task, early, backends) if not g.passed
    }
    assert list(failed) == ["tools"]
    assert "workflow_run before style_update" in failed["tools"]
    # A style call that failed before the run and succeeded after it is in order.
    refused = ToolCall("style_update", HALF_TRANSPARENT, "There is no layer 42.", True)
    retried = dataclasses.replace(good, tool_calls=[refused, *good.tool_calls])
    assert all(g.passed for g in await grade(task, retried, backends))


async def test_a_result_keeps_the_look_it_arrived_with(backends: Backends) -> None:
    """map-33 asks for transparency and an outline: an answer that also
    recolors the classes, or makes a new style for it, fails."""
    task = _map_task("map-33")
    check = _style_check(task)
    assert check.where == "same" and check.unchanged == ["/classify"]

    def arrived(change: Any, new: bool = False) -> Transcript:
        states, state = map_states(task)
        assert state is not None
        before = state.snapshot()
        state.add_result(MAP_RESULT_LAYER, "Walking catchments")
        api = Api(state)
        if new:
            api.new_style(RESULT, "Another look", change)
        else:
            api.edit(RESULT, change)
        return _transcript(map_before=before, map_after=state.snapshot())

    def asked(document: dict[str, Any]) -> None:
        document["symbol"]["fill"]["opacity"] = 0.5
        document["symbol"]["outline"] = {"color": "#333333", "width": 0.5}

    def recolored(document: dict[str, Any]) -> None:
        asked(document)
        document["classify"][0]["classes"][0]["fill"]["color"] = "#08306b"

    assert grade_style(check, arrived(asked))[0], grade_style(check, arrived(asked))
    passed, detail = grade_style(check, arrived(recolored))
    assert not passed and "/classify changed" in detail, detail
    passed, detail = grade_style(check, arrived(asked, new=True))
    assert not passed and "not edited in place" in detail, detail
    # The layer arrived and nothing was styled.
    passed, detail = grade_style(check, arrived(lambda document: None))
    assert not passed and "the style is unchanged" in detail, detail
    # No run, no layer.
    states, state = map_states(task)
    assert state is not None
    snapshot = state.snapshot()
    nothing = _transcript(map_before=snapshot, map_after=snapshot)
    assert grade_style(check, nothing) == (False, f"layer {RESULT} is gone")


async def test_a_question_that_needs_an_analysis_is_not_answered_with_a_look(
    backends: Backends, settings: Any
) -> None:
    task = _map_task("map-34")
    model = _built_and_run(
        answer="The green areas reach a station within 10 minutes on foot."
    )
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    grades = await grade(task, transcript, backends)
    assert all(g.passed for g in grades), [(g.check, g.detail) for g in grades]
    # The stations drawn as a heatmap answer nothing about reaching them.
    look = applied(task, ANSWERS["map-15"])
    heatmap = ToolCall("style_update", {"layer_project_id": 40}, {}, False)
    look = dataclasses.replace(look, tool_calls=[heatmap])
    failed = [g.check for g in await grade(task, look, backends) if not g.passed]
    assert failed == ["workflow_created", "tools"]
    # A workflow that was built and run, and a look on top of it.
    both = dataclasses.replace(transcript, tool_calls=[*transcript.tool_calls, heatmap])
    failed = [g.check for g in await grade(task, both, backends) if not g.passed]
    assert failed == ["tools"]


def test_the_workflow_projects_keep_their_own_result_layer() -> None:
    """The map project's result is no layer of the workflow projects, and
    its number is free in the map project."""
    assert RESULT not in {layer.layer_project_id for layer in MAP_LAYERS}
    assert MAP_RESULT_LAYER.layer_id != RESULT_LAYER.layer_id
    assert map_layer(RESULT) is MAP_RESULT_LAYER
    assert RESULT not in MapState().layers


# ---- conversations -------------------------------------------------------------------


def test_the_conversation_tasks_play_their_messages_for_real() -> None:
    """Three styling messages on one layer, the same with the first request of
    the last answer missing the cache, a change of topic and a typed undo,
    and a removal declined and asked for again."""
    styling, cold = _map_task("map-48"), _map_task("map-49")
    assert [m.text for m in styling.conversation] == [
        "Color the points of interest by their category.",
        "Give them a popup with their name and opening year.",
    ]
    assert styling.prompt == cold.prompt
    assert styling.conversation == cold.conversation
    assert styling.checks == cold.checks
    assert (styling.cold_requests, cold.cold_requests) == ([], [1])
    topic = _map_task("map-50")
    assert (
        len(topic.conversation) == 2 and topic.prompt == "Please undo that last change."
    )
    removal = _map_task("map-51")
    [declined] = removal.conversation
    assert declined.answer_card and declined.answer_declines == "remove_layer:39"
    assert removal.answer_card and removal.answer_value == "remove_layer:39"
    for task in (styling, cold, topic, removal):
        assert ANSWERS[task.id].script is not None, task.id


def _script(task_id: str, turn: int, calls: list[Any], answer: str) -> Any:
    """The task's right answer with the calls and answer of one run replaced."""
    script = copy.deepcopy(ANSWERS[task_id].script)
    assert script is not None
    script[turn] = (calls, answer)
    return script


async def _graded(
    task_id: str, script: Any, backends: Backends, settings: Any
) -> tuple[Transcript, dict[str, list[bool | None]]]:
    task = _map_task(task_id)
    transcript = await played(task, script, backends, settings)
    assert transcript.error is None, transcript.error
    grades: dict[str, list[bool | None]] = {}
    for grade_ in await grade(task, transcript, backends):
        grades.setdefault(grade_.check, []).append(grade_.passed)
    return transcript, grades


@pytest.mark.parametrize("task_id", ["map-48", "map-49"])
async def test_the_styling_conversation_loads_the_skill_once_and_edits_twice_at_most(
    task_id: str, backends: Backends, settings: Any
) -> None:
    right = ANSWERS[task_id].script
    assert right is not None
    transcript, grades = await _graded(task_id, right, backends, settings)
    assert all(all(g) for g in grades.values()), grades
    assert [turn.runs for turn in transcript.turns] == [1, 1, 1]
    assert all(turn.refused_for_room == [] for turn in transcript.turns)
    calls, answer = right[2]
    # The skill loaded again in the last turn.
    again = _script(
        task_id, 2, [("skills_load", {"name": "style-a-map"}), *calls], answer
    )
    _, grades = await _graded(task_id, again, backends, settings)
    assert grades["tools"] == [True, False] and all(grades["style"])
    # Three edits for the last message.
    [(_, edit)] = calls
    thrice = _script(task_id, 2, [("style_update", edit)] * 3, answer)
    _, grades = await _graded(task_id, thrice, backends, settings)
    assert grades["tools"] == [False, True] and all(grades["style"])
    # The zoom range left out.
    grow = {**edit, "operations": edit["operations"][:1]}
    _, grades = await _graded(
        task_id,
        _script(task_id, 2, [("style_update", grow)], answer),
        backends,
        settings,
    )
    assert grades["style"] == [False]


async def test_a_typed_undo_runs_the_undo_of_the_last_answer(
    backends: Backends, settings: Any
) -> None:
    right = ANSWERS["map-50"].script
    assert right is not None
    transcript, grades = await _graded("map-50", right, backends, settings)
    assert all(g is not False for gs in grades.values() for g in gs), grades
    assert grades["judge"] == [None]
    [undo] = transcript.turns[-1].tool_calls
    assert undo.name == "undo_changes" and not undo.failed
    assert undo.result["status"] == "undone"
    assert undo.result["map"]["layers"] == [32]
    # Taking the area off by hand is not the undo, though the map ends alike.
    clear = {
        "operations": [
            {
                "op": "filter",
                "layer_project_id": 32,
                "area": "clear",
            }
        ]
    }
    _, grades = await _graded(
        "map-50",
        _script("map-50", 2, [("map_update", clear)], "I removed the area again."),
        backends,
        settings,
    )
    assert grades["map"] == [True, True] and grades["tools"] == [False]
    assert all(grades["style"])
    # Pointing to the undo button takes nothing back.
    _, grades = await _graded(
        "map-50",
        _script(
            "map-50",
            2,
            [],
            "To take back the area, press the undo button under my last answer.",
        ),
        backends,
        settings,
    )
    assert grades["map"] == [True, False] and grades["tools"] == [False]


async def test_a_removal_declined_needs_a_new_card_when_asked_for_again(
    backends: Backends, settings: Any
) -> None:
    """A typed "remove it after all" is no consent: after the eval user kept
    the layer, the removal shows a new card before it removes the layer. That
    a pick of the removal counts only until the next typed message is pinned
    in ``test_eval_conversation``."""
    right = ANSWERS["map-51"].script
    assert right is not None
    transcript, grades = await _graded("map-51", right, backends, settings)
    assert all(all(g) for g in grades.values()), grades
    assert [turn.runs for turn in transcript.turns] == [2, 2]
    # Removed at once on the typed message: the tool asks instead, and no
    # card is shown.
    [remove, _] = right[2][0]
    wrong = copy.deepcopy(right)[:3]
    wrong[2] = ([remove], "The layer Old boundaries is removed.")
    transcript, grades = await _graded("map-51", wrong, backends, settings)
    assert transcript.turns[-1].runs == 1
    [again] = transcript.turns[-1].tool_calls
    assert again.result["applied"] == [] and again.result["confirm"]
    assert grades["asked"] == [True, False]
    assert grades["map"] == [True, False, False]


# ---- every task can be passed, and none by doing nothing -----------------------------


def test_every_task_has_a_right_answer() -> None:
    assert sorted(ANSWERS) == sorted(t.id for t in load_tasks("map"))


@pytest.mark.parametrize("task", load_tasks("map"), ids=lambda t: t.id)
async def test_every_task_expectation_is_reachable(
    task: EvalTask, backends: Backends, settings: Any
) -> None:
    answer = ANSWERS[task.id]
    transcript = (
        applied(task, answer)
        if answer.script is None
        else await played(task, answer.script, backends, settings)
    )
    grades = await grade(task, transcript, backends)
    assert all(
        g.passed is True or (g.check == "judge" and g.passed is None) for g in grades
    ), [(g.check, g.detail) for g in grades if g.passed is not True]


#: Tasks a do-nothing answer passes on the rules. map-32 is asked by a user
#: who may only view the project, map-45 for what the tools cannot do: the
#: right answer changes nothing, so their rules hold for any short answer that
#: writes nothing, and the judge decides whether the answer says what the user
#: can do instead.
PASSED_BY_DOING_NOTHING = {"map-32", "map-45"}


@pytest.mark.parametrize("task", load_tasks("map"), ids=lambda t: t.id)
async def test_no_task_is_passed_by_doing_nothing(
    task: EvalTask, backends: Backends
) -> None:
    states, watched = map_states(task)
    assert watched is not None
    snapshot = watched.snapshot()
    answer = (
        "Ich habe nichts geändert." if task.locale == "de" else "I changed nothing."
    )
    transcript = _transcript(
        answer=answer,
        map_before=snapshot,
        map_after=snapshot,
        map_undone=snapshot if task.undo else None,
        undo="nothing_to_undo" if task.undo else None,
    )
    grades = await grade(task, transcript, backends)
    passed = all(g.passed is not False for g in grades)
    assert passed is (task.id in PASSED_BY_DOING_NOTHING), [
        (g.check, g.detail) for g in grades
    ]


# ---- the outline loop of map-52 -----------------------------------------------------

_OFF = {"op": "set", "path": "/symbol/outline", "value": False}
_EMPTY = {"op": "set", "path": "/symbol/outline", "value": {}}
_AUTO = {"op": "set", "path": "/symbol/outline/color", "value": "auto"}
#: The first calls of runs of map-52 on a model that went wrong: the outline
#: switched off twice, a bare "auto" in its place, reset to {} twice. Each is
#: followed by the key-level call the model sends next, which must land.
_MAP_52_STARTS: dict[str, list[dict[str, Any]]] = {
    "off twice": [_OFF, _OFF],
    "bare auto": [{"op": "set", "path": "/symbol/outline", "value": "auto"}],
    "reset twice": [_EMPTY, _EMPTY],
}


@pytest.mark.parametrize("start", list(_MAP_52_STARTS))
async def test_the_key_level_outline_lands_after_each_failed_start(
    start: str, backends: Backends, settings: Any
) -> None:
    task = _map_task("map-52")
    calls: list[Any] = [
        ("skills_load", {"name": "style-a-map"}),
        ("style_update", {"layer_project_id": 31, "operations": _MAP_52_STARTS[start]}),
        ("style_update", {"layer_project_id": 31, "operations": [_AUTO]}),
    ]
    transcript = await played(task, [(calls, "Done.")], backends, settings)
    first, then = [c for c in transcript.tool_calls if c.name == "style_update"]
    assert first.failed is (start == "bare auto"), first.result
    assert then.failed is False, then.result
    after = transcript.map_after
    assert after is not None
    style_id = after["layers"][31]["active_style_id"] or next(
        s for s, v in after["styles"].items() if v["layer_project_id"] == 31
    )
    outline = after["styles"][style_id]["document"]["symbol"]["outline"]
    assert outline["color"] == "auto", outline
    if start == "bare auto":
        assert 'set /symbol/outline/color to \\"auto\\"' in json.dumps(first.result)
    if start == "off twice":
        assert "switched it on" in json.dumps(then.result)


async def test_a_key_set_after_false_in_the_same_call_lands(
    backends: Backends, settings: Any
) -> None:
    task = _map_task("map-52")
    calls: list[Any] = [
        ("skills_load", {"name": "style-a-map"}),
        ("style_update", {"layer_project_id": 31, "operations": [_OFF, _AUTO]}),
    ]
    transcript = await played(task, [(calls, "Done.")], backends, settings)
    [call] = [c for c in transcript.tool_calls if c.name == "style_update"]
    assert call.failed is False, call.result
    after = transcript.map_after
    assert after is not None
    documents = [
        v["document"] for v in after["styles"].values() if v["layer_project_id"] == 31
    ]
    assert documents[0]["symbol"]["outline"] == {"color": "auto"}
