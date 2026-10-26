"""The built-in skill build-a-workflow (spec §6.2) and the prompt around it
(spec §7): the skill loads and is listed, and every tool, input and setting it
names is one GOAT has."""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from assistant.prompt import (
    ANSWER_OPEN,
    INSTRUCTIONS,
    SKILLS_INDEX,
    static_instructions,
)
from assistant.skills import BUILT_IN
from assistant.tools.core import FoundLayer
from assistant.tools.project import ProjectInput, SampleInput
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.workflows import CHECK_DRAFT
from assistant.workflows import issues, tool_info
from assistant.workflows.draft import DatasetStep, Draft, ExportStep, ToolStep
from assistant.workflows.tool_info import SettingInfo

FIXTURE = Path(__file__).parent / "fixtures" / "process_descriptions.json"
DESCRIPTIONS: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))[
    "descriptions"
]
SKILL = BUILT_IN["build-a-workflow"]
TEXTS = {"SKILL.md": SKILL.instructions, **SKILL.files}
NUMBERED = re.compile(r"^opportunity_[123]_(?P<name>[a-z_]+)$")
TOOL_NAME = re.compile(r"\b(?:workflow|project|catalog|core|ask|skills)_[a-z_]+\b")


def _drafts() -> list[tuple[str, dict[str, Any]]]:
    return [
        (name, json.loads(block))
        for name, text in TEXTS.items()
        for block in re.findall(r"```json\n(.*?)\n```", text, re.S)
    ]


def test_the_skill_loads_and_is_in_the_instructions() -> None:
    assert set(SKILL.files) == {"recipes.md"}
    assert f"- `build-a-workflow`: {SKILL.description}" in SKILLS_INDEX
    assert static_instructions() == [INSTRUCTIONS, SKILLS_INDEX]


def test_the_skill_names_only_tools_that_exist() -> None:
    named = {name for text in TEXTS.values() for name in TOOL_NAME.findall(text)}
    named -= {"project_id", "catalog_id"}
    assert {"workflow_create", "ask_user", "project_add_catalog_layer"} <= named
    assert named <= set(BY_WIRE_NAME), named - set(BY_WIRE_NAME)


@pytest.mark.parametrize(
    ("source", "draft"), _drafts(), ids=lambda value: str(value)[:40]
)
def test_every_draft_uses_real_tools_inputs_and_settings(
    source: str, draft: dict[str, Any]
) -> None:
    model = Draft.model_validate(draft)
    tools = {step.id: step for step in model.steps if isinstance(step, ToolStep)}
    for step in tools.values():
        description = DESCRIPTIONS[step.tool]
        settings = {
            setting.name: setting for setting in tool_info.settings(description)
        }
        per_opportunity = {
            setting.name
            for setting in tool_info.opportunity_settings(description) or []
        }
        for key, value in step.settings.items():
            numbered = NUMBERED.match(key)
            if numbered:
                assert numbered["name"] in per_opportunity, (source, step.tool, key)
                continue
            assert key in settings, (source, step.tool, key)
            items = settings[key].items
            if items is not None:
                names = {item.name for item in items}
                assert all(set(entry) <= names for entry in value), (source, key)
    for connection in model.connections:
        if connection.target in tools:
            described = DESCRIPTIONS[tools[connection.target].tool]
            inputs = {item.name for item in tool_info.layer_inputs(described)}
            assert connection.input in inputs, (source, connection)


def _not_offered(setting: SettingInfo, value: Any) -> list[Any]:
    """The parts of ``value`` that are not among the choices ``setting``, or
    one of its list's items, offers."""
    if setting.items is not None:
        items = {item.name: item for item in setting.items}
        return [
            wrong
            for entry in value
            for key, part in entry.items()
            if key in items
            for wrong in _not_offered(items[key], part)
        ]
    if setting.choices is None:
        return []
    return [
        part
        for part in (value if isinstance(value, list) else [value])
        if part not in setting.choices
    ]


@pytest.mark.parametrize(
    ("source", "draft"), _drafts(), ids=lambda value: str(value)[:40]
)
def test_every_choice_in_the_drafts_is_one_the_setting_offers(
    source: str, draft: dict[str, Any]
) -> None:
    model = Draft.model_validate(draft)
    for step in model.steps:
        if not isinstance(step, ToolStep):
            continue
        description = DESCRIPTIONS[step.tool]
        settings = {s.name: s for s in tool_info.settings(description)}
        per_opportunity = {
            s.name: s for s in tool_info.opportunity_settings(description) or []
        }
        for key, value in step.settings.items():
            numbered = NUMBERED.match(key)
            setting = (
                per_opportunity.get(numbered["name"]) if numbered else settings.get(key)
            )
            assert setting is not None, (source, step.tool, key)
            assert not _not_offered(setting, value), (source, step.tool, key, value)


def test_the_recipes_cover_the_spec() -> None:
    used = {
        step["tool"]
        for _, draft in _drafts()
        for step in draft["steps"]
        if step["kind"] == "tool"
    }
    assert {
        "catchment_area_v2",
        "aggregate_polygon",
        "aggregate_points",
        "heatmap_closest_average",
        "join",
        "buffer",
    } <= used


def test_only_a_one_step_issue_is_said_to_start_with_the_steps_name() -> None:
    """An issue of the whole workflow or of several steps keeps processes'
    message as it is, so no text the model reads says that every message
    starts with a step's name."""
    texts = {
        "workflow_check_draft": CHECK_DRAFT.description,
        "workflows.issues": issues.__doc__ or "",
        "SKILL.md": SKILL.instructions,
    }
    for name, text in texts.items():
        flat = " ".join(text.split())
        assert "one-step issue" in flat, name
        for claim in (
            "each message starting with",
            "Each message starts with",
            "its message starts with the step's",
        ):
            assert claim not in flat, (name, claim)


def test_the_skill_lists_only_issues_a_draft_can_get() -> None:
    """A draft naming a tool workflow_tools does not list is refused before
    the check, so the check never answers it with tool_missing or
    tool_removed."""
    for code in ("tool_missing", "tool_removed"):
        assert code not in SKILL.instructions, code


def test_the_skill_has_no_dashes_inside_sentences() -> None:
    for name, text in TEXTS.items():
        assert "—" not in text and "–" not in text, name


def test_the_prompt_says_what_the_assistant_creates_and_how_it_asks() -> None:
    assert "You cannot change anything in GOAT" not in INSTRUCTIONS
    assert (
        "You change nothing that exists in GOAT, except that a workflow run "
        "replaces that workflow's previous results and, on the Map and "
        "Workflows pages, workflow_update changes a workflow of the open "
        "project, which the user can take back with Undo in the dock." in INSTRUCTIONS
    )
    for name in (
        "workflow_create",
        "workflow_update",
        "project_add_catalog_layer",
        "ask_user",
        "skills_load",
    ):
        assert name in INSTRUCTIONS
    assert ANSWER_OPEN in INSTRUCTIONS
    assert "the user clicks Run" not in INSTRUCTIONS
    assert "run a workflow of the open project (workflow_run)" in INSTRUCTIONS
    assert "any other only after the user picked Run in your card" in INSTRUCTIONS


def test_one_rule_says_when_to_ask_and_how() -> None:
    """Asking in text and asking with the card are one rule, so the model does
    not ask a question in text where a card fits."""
    bullets = INSTRUCTIONS.split("\n- ")
    [rule] = [bullet for bullet in bullets if "ask_user" in bullet]
    assert "ambiguous" in rule and "one short question" in rule
    assert ANSWER_OPEN in rule
    assert [bullet for bullet in bullets if "ambiguous" in bullet] == [rule]


def test_the_skill_limits_a_layer_larger_than_the_place() -> None:
    """project_get_layers shows a layer's extent and feature count when
    known; a layer far larger than the place asked about gets `filter.area`,
    and the heatmap's destination limit is fixed the same way."""
    flat = " ".join(SKILL.instructions.split())
    # A table, an empty extent and a locked layer come without one.
    assert "shows a layer's `extent`" in flat
    assert "`feature_count` when known" in flat
    assert "project layers included" in flat
    assert "- `too_many_destinations`:" in SKILL.instructions


def test_a_template_input_takes_only_a_layer_that_fits_the_place() -> None:
    """A template's inputs are bound to layers as they are, without a filter,
    so a layer far larger than the place makes a draft with `filter.area`."""
    template_step = SKILL.instructions.split("2. **Look for a template.**")[1]
    flat = " ".join(template_step.split("3. **")[0].split())
    assert "A binding takes no filter" in flat
    assert "covers far more than the place" in flat
    assert "build a draft with `filter.area` instead of using the template" in flat


def test_what_the_workflow_is_named_follows_the_users_message() -> None:
    """The skill said "in the user's language", which models read as the
    language of the project's German layer names (wf-02, wf-03). The prompt
    and the draft's own field descriptions say the same as the skill."""
    flat = " ".join(SKILL.instructions.split())
    assert (
        "The workflow's `name`, the step labels and the export names are in the "
        "language of the user's message, as your answer is" in flat
    )
    assert "the names of layers stay as they are" in flat
    assert "the user's language" not in flat
    for model, name in (
        (Draft, "name"),
        (ToolStep, "label"),
        (DatasetStep, "label"),
        (ExportStep, "name"),
    ):
        described = model.model_fields[name].description or ""
        assert "in the language of the user's message" in described, model


def test_the_skill_searches_the_catalog_once_per_dataset() -> None:
    """wf-05 and wf-09: with no rule on when the search is done, models
    searched the catalog in circles until the answer's budget was gone."""
    find = SKILL.instructions.split("3. **Find the data.**")[1].split("4. **")[0]
    flat = " ".join(find.split())
    assert "search the catalog for it once" in flat
    assert "German and English words in q, separated by commas" in flat
    assert "do not search for that dataset again with other words" in flat
    # A step left open is the user's to fill in the editor, not a card's.
    assert "needs no card" in flat


def test_the_skill_says_when_to_run_and_how_to_read_the_results() -> None:
    text = " ".join(SKILL.instructions.split())
    assert "workflow_run" in text and "workflow_last_run" in text
    assert "run:<workflow id>" in text
    assert "project_group_statistics" in text and "share_of" in text
    assert "never start" not in text
    assert "—" not in text and "–" not in text


def _plain(text: str) -> str:
    """The text on one line, without Markdown's code marks."""
    return " ".join(text.split()).replace("`", "")


SKILL_TEXT = _plain(SKILL.instructions)
RECIPES_TEXT = _plain(SKILL.files["recipes.md"])


@pytest.mark.parametrize(
    "phrase",
    [
        "check that it has what the role needs",  # rule 1
        "aggregate_points",  # rule 2, residents from points
        "Report the numbers first",  # rule 3
        "answers the whole question",  # rule 4
        "saved layer as a dataset step",  # rule 5
        "not polygon centroids",  # rule 6
        "share_of with its own filter",  # rule 7
        "too_many_starting_points",  # rule 10 and the issue code
        "project_add_dataset",  # the user's own datasets after a pick
    ],
)
def test_the_skill_holds_the_rule(phrase: str) -> None:
    """Rules from a live evaluation where the model recommended datasets
    without checking them, counted area shares as residents, asked before
    reporting and divided by itself."""
    assert phrase in f"{SKILL_TEXT} {RECIPES_TEXT}"


@pytest.mark.parametrize(
    "phrase",
    [
        "Use every member the question covers",  # 1 bundles
        "check how it was made before you reuse it",  # 2 fit check
        "may be offered, never recommended",  # 3 the whole question
        "never say that runs in parts cannot be combined",  # 4 over the limit
        "swap origins and destinations",  # 5 transit origins
        "a real decision the question leaves open",  # 6 numbers first
        "the same population from the same source and year",  # 7 shares
        "areas on a boundary count in both",  # 8 district summaries
        "quote the time window, modes, speeds and distances",  # 9 method
    ],
)
def test_the_skill_holds_the_rule_of_the_third_pass(phrase: str) -> None:
    """Rules from the third live pass: bundle members left out, datasets and
    earlier results reused without a fit check, narrowed recommendations, a
    false claim that catchments run in parts cannot be combined, transit
    matrices failing on area centroids, permission cards, shares on mixed
    population sources, boundary areas counted twice and method statements
    that did not match the run."""
    assert phrase in f"{SKILL_TEXT} {RECIPES_TEXT}"


def test_a_join_key_the_step_before_does_not_produce_names_the_fields_to_use() -> None:
    """Sixth pass (Q12, Q15): joins ran on a field the step before does not
    produce. processes refuses such a join and lists the fields that step
    gives; tools write their ids under their own names."""
    issue = SKILL_TEXT.split("- field_not_produced:")[1].split("- ")[0]
    assert "one of the fields the message lists" in issue
    assert "origin and destination" in issue
    assert "reference field as origin" in issue


def test_too_many_starting_points_splits_rather_than_narrows() -> None:
    """The split into parts under the limit is the answer when the question
    needs every start point; narrowing stays an option the user picks."""
    issue = SKILL_TEXT.split("- too_many_starting_points:")[1].split("- ")[0]
    assert "offer the narrower run" not in issue
    assert "merge" in issue and "dissolve" in issue
    assert "Start points over the limit" in RECIPES_TEXT
    # A draft holds at most 30 steps: dataset, catchment and merge per part.
    assert "at most 8 parts" in issue and "at most 8 parts" in RECIPES_TEXT
    assert "issue's message suggests" not in issue
    assert "dissolve_fields" in RECIPES_TEXT
    # A second workflow has the same cap: above 8 parts, narrowing, with why.
    assert "Above that, offer narrowing and say why" in issue
    assert "Above that, offer narrowing to part of the start points" in RECIPES_TEXT
    # Rings of separate parts overlap; cumulative bands dissolve exactly.
    assert "steps_style cumulative (with show_advanced true)" in RECIPES_TEXT


def test_transit_travel_times_from_areas_run_from_the_centre() -> None:
    """By public transport one origin off the network fails the whole
    matrix, while a destination off it is an empty cell; no tool makes one
    populated point per district."""
    assert "recommend the reversed matrix" in SKILL_TEXT
    assert "never call them unreachable" in SKILL_TEXT
    assert "most populated cell" not in SKILL_TEXT
    assert "largest overlap" not in f"{SKILL_TEXT} {RECIPES_TEXT}"


def test_a_reused_result_layer_is_judged_without_a_run_too() -> None:
    """The run summary gives settings, never filters or areas, and
    workflow_last_run sees only the last three days."""
    assert "sees only runs of the last three days" in SKILL_TEXT
    assert "project_count_features" in SKILL_TEXT


def test_the_prompt_asks_no_permission_after_results() -> None:
    flat = " ".join(INSTRUCTIONS.split())
    assert "a real decision the question leaves open" in flat
    assert "recommend the option that answers the whole question" in flat


def test_the_run_card_is_no_question_whether_to_run() -> None:
    """workflow_run refuses a workflow not created in this conversation until
    the user picked Run, so the rule against asking whether to run covers
    only a workflow created in this conversation."""
    running = SKILL.instructions.split("## Running and explaining")[1]
    flat = _plain(running.split("\n## ")[0])
    assert "Never ask whether to run when the user asked for a result" not in flat
    assert (
        "When the user asked for a result, never ask whether to run a workflow "
        "you created in this conversation: run it." in flat
    )
    assert "it is the permission workflow_run needs" in flat


def test_an_area_result_and_residents_by_area_share_are_labelled_apart() -> None:
    """Square metres are an area; residents spread by area share are people,
    as an estimate. The rule in the skill and the recipe say the same."""
    assert (
        "Square metres are an area result, labelled as area, never as people; "
        "residents spread by area share (only when no points exist) are people, "
        "labelled as an estimate" in SKILL_TEXT
    )
    assert "the result is people, labelled as an estimate" in RECIPES_TEXT


def test_the_prompt_reports_before_it_asks() -> None:
    flat = " ".join(INSTRUCTIONS.split())
    assert "numbers first" in flat
    assert "never compute shares" in flat.lower() or "never divide" in flat.lower()
    # An evaluative question gets a measure before any verdict.
    assert "ask which measure" in flat


def test_no_draft_spreads_residents_by_area() -> None:
    """The format example is the draft models copy first: it counts residents
    from census points, and area weighting appears only for an area."""
    [(_, example)] = [
        (source, draft) for source, draft in _drafts() if source == "SKILL.md"
    ]
    tools = {step["tool"] for step in example["steps"] if step["kind"] == "tool"}
    assert "aggregate_points" in tools and "aggregate_polygon" not in tools
    for source, draft in _drafts():
        for step in draft["steps"]:
            settings = step.get("settings", {})
            if settings.get("weighted_by_intersecting_area"):
                fields = {item.get("field") for item in settings["column_statistics"]}
                assert "einwohner" not in fields, (source, step["id"])
                assert "area" in step["label"].lower(), (source, step["id"])


def test_the_skill_looks_in_the_users_own_datasets_too() -> None:
    """The card offers the user's own datasets, so step 3 finds them."""
    find = SKILL.instructions.split("3. **Find the data.**")[1].split("4. **")[0]
    flat = " ".join(find.split())
    assert "the user's own datasets with core_find (kind dataset)" in flat
    assert "search the catalog for it once" in flat


def test_no_city_names_in_the_skill_or_the_prompt() -> None:
    """The rules are general: examples name a generic city or district."""
    for city in ("Hamburg", "München", "Munich", "Berlin", "Bonn"):
        assert city not in f"{SKILL_TEXT} {RECIPES_TEXT} {INSTRUCTIONS}", city


def test_every_created_workflow_gets_one_short_note() -> None:
    """The skill says what the draft tools say (NOTE_RULE): one short note
    per workflow, what it answers and how to read its results, never data
    values or personal data; the format example carries one, above the steps
    that give the result."""
    rule = _plain(CHECK_DRAFT.description)
    for phrase in (
        "one short note",
        "what it answers",
        "how to read its results",
        "Never put data values or personal data in a note",
    ):
        assert phrase in SKILL_TEXT, phrase
        assert phrase in rule, phrase
    assert "a blank line starts a new paragraph" in SKILL_TEXT
    assert "at most 5" in SKILL_TEXT
    [(_, example)] = [
        (source, draft) for source, draft in _drafts() if source == "SKILL.md"
    ]
    [note] = Draft.model_validate(example).notes
    assert note.near and len(note.text) <= 300


def test_the_example_note_reads_a_combined_walk_as_one_row_per_separate_area() -> None:
    """The example's walk leaves shape_style at its default, combined. From
    spread schools, the routing engine splits the area reached into separate
    areas that do not overlap, one row each, so the aggregation gives one row
    per separate area and their sum is the total. The note the model copies
    onto its canvas says so."""
    [(_, example)] = [
        (source, draft) for source, draft in _drafts() if source == "SKILL.md"
    ]
    walk = next(step for step in example["steps"] if step["id"] == "walk")
    shape = DESCRIPTIONS["catchment_area_v2"]["inputs"]["shape_style"]["schema"]
    assert "shape_style" not in walk["settings"] and shape["default"] == "combined"
    [note] = Draft.model_validate(example).notes
    assert "one row per separate area" in note.text
    assert "their sum is" in note.text
    assert "one row," not in note.text and "per school" not in note.text


def test_the_example_filters_its_census_points_to_the_place() -> None:
    """Census points cover the whole country: the example's residents step
    gets the same area filter as its schools step."""
    [(_, example)] = [
        (source, draft) for source, draft in _drafts() if source == "SKILL.md"
    ]
    steps = {step["id"]: step for step in example["steps"]}
    area = steps["schools"]["filter"]["area"]
    assert steps["residents"]["filter"] == {"area": area}


def test_only_a_dissolve_gives_one_row() -> None:
    """A catchment holds one row per separate area and band (the routing
    engine splits what it reaches into areas that do not overlap), so after
    an intersection with districts there is one row per band, district and
    separate area."""
    bands = RECIPES_TEXT.split("- Bands per district:")[1].split("- Areas counted")[0]
    assert "one row per band, district and separate area" in bands
    assert "then_by the band" in bands
    assert "or a combined catchment" not in SKILL_TEXT


@pytest.mark.parametrize(
    "phrase",
    [
        "workflow_last_run reads only the open project's workflows",  # fit check
        "what the result's notes say",  # step 7, not the canvas notes
        "A centroid can fall outside a concave area",  # district by centroid
    ],
)
def test_the_skill_holds_the_rule_of_the_final_review(phrase: str) -> None:
    assert phrase in f"{SKILL_TEXT} {RECIPES_TEXT}"


def test_the_method_comes_from_the_settings_and_the_defaults_a_run_lists() -> None:
    """A run summary lists the settings a step was sent and those it left at
    the tool's default; the fit check of a result layer and the method of an
    answer read both, and a setting neither lists is looked up."""
    find = _plain(
        SKILL.instructions.split("3. **Find the data.**")[1].split("4. **")[0]
    )
    method = next(
        line
        for line in _plain(SKILL.instructions).split("- ")
        if line.startswith("State the method as it ran")
    )
    for text in (find, method):
        assert "left at the tool's default" in text
        assert "not used by that step or not known (workflow_describe_tool" in text


@pytest.mark.parametrize(
    "phrase",
    [
        "grid cells alone do not answer it",  # 4 which places
        "aggregate the cells to named areas",
        "never the centroid of its polygon",  # 5 a district's centre
        "(districts, the surroundings) to a centre",
        "always does, or gets a where on an official area code field",  # 6
        "the run reads the whole country",
        "count the rows that found no partner",  # 7 a join by name
        "a missing value is not a zero",
        # 8 datasets in options
        "Every option that uses data not yet in the open project lists it in adds",
        "a layer of another project too (its dataset's id from core_find)",
        "an option that names data without adds makes one necessary",
        'Departures "on a day" count the whole day',  # 9 the whole question
        '"which areas" needs named areas',
        "every kind the question names",
        "street stops or entrances",  # 10 start points at a station
        "far below its nominal size",
    ],
)
def test_the_skill_holds_the_rule_of_the_fourth_pass(phrase: str) -> None:
    """Rules from the fourth live pass: grid cells given for "which areas",
    district centroids taken for district centres, nationwide layers read
    whole, a join by name that lost areas without saying so, options naming
    data without adds, recommendations that narrowed the question, and
    catchments from a station's platforms that stayed a fraction of their
    size."""
    assert phrase in f"{SKILL_TEXT} {RECIPES_TEXT}"


def test_a_station_is_started_from_the_street_and_a_tiny_result_rerun() -> None:
    """The design half of the station rule sits with the start points, in a
    role of its own for any mode (the evidence was on foot and by bicycle),
    the check of a result too small with reading a run."""
    find = _plain(
        SKILL.instructions.split("3. **Find the data.**")[1].split("4. **")[0]
    )
    running = _plain(SKILL.instructions.split("## Running and explaining")[1])
    assert "Three roles come up often" in find
    transit = find.split("- public transport origins:")[1].split("- a centre")[0]
    station = find.split("- a centre or a station as start point, in any mode:")[1]
    station = station.split("Ask about all unclear datasets")[0]
    assert "street stops or entrances" not in transit
    assert "never the centroid of its polygon" not in transit
    assert "street stops or entrances" in station
    assert "never the centroid of its polygon" in station
    assert "(districts, the surroundings) to a centre" in transit
    assert "far below its nominal size" in running
    assert "Build it again from the street stops or entrances" in running


def test_the_rules_of_the_fourth_pass_sit_where_they_apply() -> None:
    """Each rule extends the paragraph on its topic: national layers the
    dataset step, a join by name the join recipe, data in options and the
    whole question the card paragraph."""
    dataset = SKILL_TEXT.split("- dataset: layer is")[1].split("- tool: tool is")[0]
    assert "always does, or gets a where on an official area code field" in dataset
    assert "the run reads the whole country" in dataset
    join = RECIPES_TEXT.split("## Join attributes")[1].split("## Counting")[0]
    assert "count the rows that found no partner" in join
    assert "or whose match_count is 0" in join
    card = SKILL_TEXT.split("Ask about all unclear datasets in one ask_user card")[1]
    card = card.split("4. **After the answer.**")[0]
    for phrase in (
        "Every option that uses data not yet in the open project lists it in adds",
        "an option that names data without adds makes one necessary",
        'Departures "on a day" count the whole day',
        '"which areas" needs named areas',
        "every kind the question names",
    ):
        assert phrase in card, phrase


def test_a_note_states_only_what_the_steps_fix() -> None:
    """Fourth pass: notes misread the result (one row per area for a
    matrix with several origins, five classes for six, a field without its
    join_ prefix), some carried counts, and a card asked leave to shorten an
    over-long note. The skill and the draft tools say the same."""
    rule = _plain(CHECK_DRAFT.description)
    for phrase in (
        "at most three short lines",
        "State only what the steps fix",
        "nor counts that come from the data (rows, classes or features)",
    ):
        assert phrase in SKILL_TEXT, phrase
        assert phrase in rule, phrase
    # The draft tools name an example for a client that never loads the skill.
    assert "State only what the steps fix, such as a join's join_ prefix" in rule
    notes = SKILL_TEXT.split("- notes:")[1].split("- The workflow's name")[0]
    for phrase in (
        "one row only after a dissolve",
        "one per band when it dissolves by the band field",
        "a catchment alone can hold several rows per band, one per separate area",
        "join_<field>",
        "classes and scales only as the tool's description defines them",
        "Shorten an over-long note yourself; never ask the user about a note",
    ):
        assert phrase in notes, phrase
    assert "Keep it to a few lines" not in notes
    assert "combined catchment" not in notes


def test_the_default_hint_is_what_the_form_fills_in() -> None:
    """travel_cost_matrix resolves its limit without the form's default, so a
    run that leaves it out is unbounded: the hint is the form's value, and a
    step that relies on a number sets it."""
    bullet = SKILL_TEXT.split("- default_hint is")[1].split("- A field setting")[0]
    assert "in the editor and in a run" not in bullet
    assert "the value the form fills in" in bullet
    # By public transport the matrix's limit (max_cost_time_pt) has a default.
    assert (
        "a travel cost matrix's max_cost (walking, bicycle, pedelec or car) left "
        "out is unbounded"
    ) in bullet
    assert "set that number (or the user's) explicitly" in bullet


def test_a_mean_over_pieces_is_never_called_area_weighted() -> None:
    """Fifth pass (Q8, Q24): a plain mean of pieces, and aggregate_polygon's
    weighted mean, were both called area-weighted. aggregate_polygon weights
    each source polygon by its share inside the area (the intersection's
    area over the polygon's own), so a piece wholly inside counts 1 whatever
    its size; project_group_statistics weights nothing. Q14 called a share
    of pieces a share of the area. The rule sits where results are read."""
    weighted = DESCRIPTIONS["aggregate_polygon"]["inputs"][
        "weighted_by_intersecting_area"
    ]["description"]
    assert "weighted by its share inside the area" in weighted
    succeeded = SKILL_TEXT.split("- succeeded:")[1].split("- A share's numerator")[0]
    for phrase in (
        "A mean over pieces is the mean of the pieces",
        "project_group_statistics counts each piece once",
        "aggregate_polygon's weighted_by_intersecting_area each by its share "
        "inside the area, never by its size, so never call it area-weighted",
        "A share of pieces is of the pieces, never of the area",
    ):
        assert phrase in succeeded, phrase
    for said_once in ("a piece wholly inside counts 1", "No tool weights a mean"):
        assert said_once not in succeeded, said_once


def test_a_dataset_of_the_users_own_is_read_before_it_is_recommended() -> None:
    """Fifth pass (Q17, Q23): the user's own datasets were recommended
    unread, one holding another city's data, one with points outside the
    study area. core_find gives no extent; a project that holds the dataset
    does, read with its project_id. A dataset that does not answer the
    question is never recommended (Q21 recommended one knowingly)."""
    find = _plain(
        SKILL.instructions.split("3. **Find the data.**")[1].split("4. **")[0]
    )
    for phrase in (
        "For one of the user's own datasets, read its extent and a sample of "
        "its features (its fields and counts when the data policy withholds the "
        "sample)",
        "core_find_layers finds a project that holds it",
        "held by no project, it cannot be checked",
        "An option you have not checked, or that does not answer the question, "
        "is never the recommended option",
    ):
        assert phrase in find, phrase
    assert "An option you have not checked is not recommended" not in find
    # The path the rule names: a layer found in another project, read there.
    assert {"project_id", "layer_project_id"} <= set(FoundLayer.model_fields)
    assert "project_id" in ProjectInput.model_fields
    assert "project_id" in SampleInput.model_fields


def test_a_card_never_asks_again_what_the_user_picked() -> None:
    """Fifth pass (Q12, Q13, Q20): cards asked again, also in other words,
    what the user had picked in an earlier card. The rule extends the card
    paragraph."""
    card = SKILL_TEXT.split("Ask about all unclear datasets in one ask_user card")[1]
    card = card.split("4. **After the answer.**")[0]
    for phrase in (
        "Before a card, read the user's picks earlier in this conversation",
        "never ask again what they chose, also not in other words (a Run card "
        "asks anew for each run)",
        "continue with the pick, or say why it no longer fits",
    ):
        assert phrase in card, phrase


def test_the_skill_is_loaded_for_a_change_of_a_workflow_too() -> None:
    """The skills index lists the description: a request to change a workflow
    must match it as a request to build one does."""
    assert "change a workflow that exists" in SKILL.description


@pytest.mark.parametrize(
    "phrase",
    [
        "## Changing a workflow",
        "Read it first with workflow_get",
        "Change the fewest steps",
        "Keep the user's step names, notes and layout",
        "workflow_update checks the changed workflow",
        "say what changed",
        "Undo in the dock",
        "only on If steps",
    ],
)
def test_the_skill_says_how_to_change_a_workflow(phrase: str) -> None:
    """Changing a workflow (Task 6): read first, change the fewest steps,
    keep the user's names and notes, check, and say what changed and that
    Undo in the dock takes it back."""
    assert phrase in " ".join(SKILL_TEXT.split())


def test_no_text_says_a_workflow_cannot_be_changed() -> None:
    from assistant.workflows.runs import FAILED

    for text in (SKILL_TEXT, FAILED, INSTRUCTIONS):
        flat_text = " ".join(text.split())
        assert "You cannot change the workflow" not in flat_text
        assert "You never change or delete a workflow" not in flat_text
    assert "workflow_update" in FAILED
