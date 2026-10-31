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
from assistant.tools.skills import SkillsLoadInput
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
#: The recipe files, one per kind of question, and the sections each holds,
#: in order. Every section sits in exactly one file, so a question loads one.
RECIPE_SECTIONS = {
    "catchments.md": ["Catchment areas around places", "Start points over the limit"],
    "heatmap.md": [
        "Who lives within N minutes of places",
        "Shares per district",
        "Access everywhere: a heatmap",
    ],
    "joins-and-distances.md": ["Join attributes", "Counting within a distance"],
    "transit-service.md": ["Public transport service of a place"],
}
#: The drafts the recipes held as one file.
RECIPE_DRAFTS = 8
MD_FILE = re.compile(r"\b[\w-]+\.md\b")
#: "(heatmap.md, Shares per district)": a section or bullet of a recipe file.
SECTION_REFERENCE = re.compile(r"\(([a-z-]+\.md), ([A-Z][^)]*)\)")


def _drafts() -> list[tuple[str, dict[str, Any]]]:
    return [
        (name, json.loads(block))
        for name, text in TEXTS.items()
        for block in re.findall(r"```json\n(.*?)\n```", text, re.S)
    ]


def test_the_skill_loads_and_is_in_the_instructions() -> None:
    assert set(SKILL.files) == set(RECIPE_SECTIONS)
    assert f"- `build-a-workflow`: {SKILL.description}" in SKILLS_INDEX
    assert static_instructions() == [INSTRUCTIONS, SKILLS_INDEX]


def test_each_recipe_sits_in_exactly_one_file() -> None:
    """Pass 7: the one recipe file was loaded in every conversation and sent
    again with every later call. Split by question, every section and every
    draft sits in exactly one file, and no file holds half of the recipes."""
    headings = {
        name: re.findall(r"^## (.+)$", text, re.M) for name, text in SKILL.files.items()
    }
    assert headings == RECIPE_SECTIONS
    every = [heading for listed in headings.values() for heading in listed]
    assert len(every) == len(set(every))
    names = [draft["name"] for source, draft in _drafts() if source != "SKILL.md"]
    assert len(names) == RECIPE_DRAFTS and len(set(names)) == RECIPE_DRAFTS
    total = sum(len(text) for text in SKILL.files.values())
    for name, text in SKILL.files.items():
        assert len(text) < total / 2, name


def test_skill_md_names_the_one_recipe_file_each_question_loads() -> None:
    """SKILL.md lists every recipe file with the questions it covers and says
    to load only the one the question needs."""
    section = SKILL.instructions.split("## Recipe files")[1].split("\n## ")[0]
    listed = re.findall(r"^- `([a-z-]+\.md)`: ", section, re.M)
    assert sorted(listed) == sorted(SKILL.files)
    flat = _plain(section)
    for phrase in (
        "Load the one file the question needs",
        "never all of them",
        "Load another only when the user picks a method it holds",
        "A question none of them covers",
        "the layer numbers (12, 13, 14, 15) stand for layer_project_ids",
    ):
        assert phrase in flat, phrase
    step_5 = _plain(SKILL.instructions.split("5. **Pick the tools.**")[1])
    assert "(Recipe files)" in step_5.split("6. **")[0]


def test_every_file_a_text_names_exists() -> None:
    """The former single file is gone and named nowhere, the skills_load tool
    included; a reference to a section names the file that holds it."""
    named = {name for text in TEXTS.values() for name in MD_FILE.findall(text)}
    assert named <= {"SKILL.md", *SKILL.files}, named - {"SKILL.md", *SKILL.files}
    example = SkillsLoadInput.model_fields["file"].description or ""
    assert set(MD_FILE.findall(example)) <= set(SKILL.files)
    assert "recipes.md" not in example
    references = [
        (source, file, section)
        for source, text in TEXTS.items()
        for file, section in SECTION_REFERENCE.findall(_plain(text))
    ]
    assert references
    for source, file, section in references:
        # A section's heading, or the bullet that starts with that name.
        start = re.compile(rf"^(?:## |- ){re.escape(section)}\b", re.M)
        assert start.search(SKILL.files[file].replace("`", "")), (source, file, section)


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
        "project, which the user can take back with the dock's undo button."
        in INSTRUCTIONS
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
#: Every recipe file on one line, for rules that may sit in any of them.
RECIPES_TEXT = _plain("\n".join(SKILL.files.values()))


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
    for city in (
        "Hamburg",
        "Harburg",
        "München",
        "Munich",
        "Berlin",
        "Bonn",
        "Neuwerk",
    ):
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
    gets the place's area. The schools are where the residents walk to, so
    they get the region one level up, whose nuts_id is the place's without
    its last character."""
    [(_, example)] = [
        (source, draft) for source, draft in _drafts() if source == "SKILL.md"
    ]
    steps = {step["id"]: step for step in example["steps"]}
    place = steps["residents"]["filter"]["area"]
    assert steps["residents"]["filter"] == {"area": place}
    assert steps["schools"]["filter"]["area"] == place[:-1]


def test_only_a_dissolve_gives_one_row() -> None:
    """A catchment holds one row per separate area and band (the routing
    engine splits what it reaches into areas that do not overlap), so after
    an intersection with districts there is one row per band, district and
    separate area."""
    bands = _plain(CATCHMENT_AREAS).split("- Bands per district:")[1]
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
        "the dock's undo button",
        "only on If steps",
    ],
)
def test_the_skill_says_how_to_change_a_workflow(phrase: str) -> None:
    """Changing a workflow (Task 6): read first, change the fewest steps,
    keep the user's names and notes, check, and say what changed and that
    the dock's undo button takes it back."""
    assert phrase in " ".join(SKILL_TEXT.split())


def test_no_text_says_a_workflow_cannot_be_changed() -> None:
    from assistant.workflows.runs import FAILED

    for text in (SKILL_TEXT, FAILED, INSTRUCTIONS):
        flat_text = " ".join(text.split())
        assert "You cannot change the workflow" not in flat_text
        assert "You never change or delete a workflow" not in flat_text
    assert "workflow_update" in FAILED


STEP_1 = _plain(
    SKILL.instructions.split("1. **Understand the goal.**")[1].split("2. **")[0]
)
CARD = SKILL_TEXT.split("Ask about all unclear datasets in one ask_user card")[1]
CARD = CARD.split("4. **After the answer.**")[0]
HEATMAP = SKILL.files["heatmap.md"]
CATCHMENTS = SKILL.files["catchments.md"]
WHO_LIVES = HEATMAP.split("## Who lives within N minutes of places")[1]
WHO_LIVES = WHO_LIVES.split("\n## ")[0]
CATCHMENT_AREAS = CATCHMENTS.split("## Catchment areas around places")[1]
CATCHMENT_AREAS = CATCHMENT_AREAS.split("\n## ")[0]


def test_both_methods_fit_residents_near_the_nearest_of_many_places() -> None:
    """Heatmap against catchment (2026-10-26): for the share of residents
    within 5 minutes' walk of a stop, catchments gave 77 % (their edge ends
    about half a minute short, and the start-point cap split the run in
    four), the heatmap 90 % in seconds (a cell of about 1.3 ha counts once
    one street in it is reached), the truth lies between 84 and 91 %. Both
    fit: the card the answer shows anyway offers both, the heatmap
    recommended, and no card is added just for the method."""
    for phrase in (
        "For the share or number of residents (or homes, jobs and the like) "
        "within N minutes of the nearest of many places",
        "(stops, schools, shops), both methods fit",
        "the heatmap (recommended) and catchment areas",
        "the card the answer shows anyway (step 3, the one that picks the data "
        "or the measure), never in a card of their own",
        "without one, build the heatmap and say in one sentence that catchment "
        "areas are the other way",
    ):
        assert phrase in STEP_1, phrase
    for phrase in (
        "When both methods fit (step 1), the card asks for the method too",
        "the heatmap, recommended",
        "Fast, and one run answers several time limits",
        "counts a whole block (about 1.3 ha on foot) as reached when one street "
        "in it is, so shares come out a little high",
        "Exact shapes, but slower, and they currently end a little short of the "
        "time limit, so shares come out a little low",
    ):
        assert phrase in CARD, phrase


def test_catchment_areas_stay_the_method_when_the_answer_is_an_area() -> None:
    """An area, shapes per start point, a few start points or a departure
    window by public transport need catchments: no method card then."""
    rule = STEP_1.split("Catchment areas stay the method")[1]
    for phrase in (
        "with no card about it, when the answer is an area",
        "the area reached, its km²",
        "land use or parcels inside or outside it",
        "shapes per start point",
        "one or a few start points (one station)",
        "public transport with a departure window from given stops",
    ):
        assert phrase in rule, phrase


def test_the_answer_and_the_note_name_the_method_and_how_exact_it_is() -> None:
    notes = SKILL_TEXT.split("- notes:")[1].split("- The workflow's name")[0]
    method = next(
        line
        for line in SKILL_TEXT.split("- ")
        if line.startswith("State the method as it ran")
    )
    for text in (notes, method):
        assert "counted per hexagon of about 1.3 ha" in text
        assert "end slightly short of" in text
    assert "how exact it is, in one short clause" in notes
    assert "Name the method and how exact it is" in method
    # An answer that only builds the workflow says it too.
    answer = _plain(SKILL.instructions.split("7. **Answer**")[1].split("\n## ")[0])
    assert "with a heatmap or catchment areas, its method and how exact" in answer
    [(_, example)] = [
        (source, draft) for source, draft in _drafts() if source == "SKILL.md"
    ]
    [note] = Draft.model_validate(example).notes
    assert "catchment areas that end slightly short of 15 minutes" in note.text


def test_the_recipes_count_residents_per_heatmap_cell_first() -> None:
    """The recipe no longer sends every "within N minutes" question to
    catchments: the heatmap draft comes first, the catchment draft stays."""
    text = _plain(WHO_LIVES)
    assert not text.startswith("Catchment areas around the places")
    [heat_draft] = [
        json.loads(block)
        for block in re.findall(r"```json\n(.*?)\n```", WHO_LIVES, re.S)
    ]
    [catchment_draft] = [
        json.loads(block)
        for block in re.findall(r"```json\n(.*?)\n```", CATCHMENT_AREAS, re.S)
    ]
    heat, count = (step for step in heat_draft["steps"] if step["kind"] == "tool")
    assert heat["tool"] == "heatmap_closest_average"
    assert heat["settings"]["opportunity_1_n_destinations"] == 1
    assert count["tool"] == "aggregate_points"
    assert count["settings"]["area_type"] == "polygon"
    assert {
        "from": heat["id"],
        "to": count["id"],
        "input": "area_layer_id",
    } in heat_draft["connections"]
    tools = {step.get("tool") for step in catchment_draft["steps"]}
    assert "catchment_area_v2" in tools
    for phrase in (
        "SKILL.md, step 1",
        "about 1.3 ha on foot, 9 ha by bicycle, pedelec or public transport and "
        "63 ha by car",
        "total_accessibility, the minutes to the nearest place",
        "area_type polygon and the heatmap as area_layer_id",
        "area_type h3_grid does not",
        "share_of the census points of the place",
        "opportunity_1_max_cost set to the largest limit",
        "under it plus half a minute",
        "merge them into one layer (merge) first",
        "the heatmap averages their times",
    ):
        assert phrase in text, phrase
    start = _plain(CATCHMENTS.split("## Start points over the limit")[1])
    assert start.startswith("When catchment areas are the method")


def test_the_heatmap_recipe_keeps_the_minutes_beside_the_residents() -> None:
    """goatlib predicts what the recipe's chain writes: the heatmap's cells
    carry total_accessibility, and aggregate_points into those cells as
    polygons keeps it beside the residents' sum; its own H3 grid does not."""
    from goatlib.tools.schema_prediction import predict_node_output_schema

    heat_draft = json.loads(re.findall(r"```json\n(.*?)\n```", WHO_LIVES, re.S)[0])
    heat, count = (step for step in heat_draft["steps"] if step["kind"] == "tool")
    cells = predict_node_output_schema(heat["tool"], {}, heat["settings"])
    assert cells is not None and "total_accessibility" in cells.columns
    census = {"einwohner": "DOUBLE", "geometry": "GEOMETRY"}
    summed = predict_node_output_schema(
        count["tool"],
        {"area_layer_id": cells.columns, "source_layer_id": census},
        count["settings"],
    )
    assert summed is not None
    assert {"total_accessibility", "einwohner_sum"} <= set(summed.columns)
    assert "einwohner_sum" in _plain(WHO_LIVES)
    grid = predict_node_output_schema(
        count["tool"],
        {"source_layer_id": census},
        {**count["settings"], "area_type": "h3_grid", "h3_resolution": 10},
    )
    assert grid is not None and "total_accessibility" not in grid.columns
    assert grid.columns.get("h3_10") == "VARCHAR"


DATASET_STEP = _plain(
    SKILL.instructions.split("- dataset: `layer` is")[1].split("- tool: `tool` is")[0]
)
SHARE_BULLET = SKILL.instructions.split("- A share's numerator and denominator")[1]
SHARE_BULLET = _plain(SHARE_BULLET.split("\n- ")[0])
SHARES_PER_DISTRICT = HEATMAP.partition("## Shares per district")[2]
SHARES_PER_DISTRICT = SHARES_PER_DISTRICT.split("\n## ")[0]


def test_destinations_get_a_margin_beyond_the_place() -> None:
    """Shops filtered to a city's boundary left out the shops just outside
    it, so its outer districts looked worse served than they are. The people
    the question is about get the place; the places they walk or travel to
    get the region one level up. A filter takes one region, so a region
    beyond the border of that one is a second dataset step, merged."""
    for phrase in (
        "The people or places the question is about (residents) get the place "
        "itself",
        "The places they walk or travel to (destinations: a heatmap's "
        "opportunities, a catchment's start points) are not cut at its border",
        "give them the region one level up (the nuts_id without its last "
        "character, DE21 for DE212)",
        "or no area when the layer covers little more than that",
        "gets a second dataset step on the same layer for the region beyond it "
        "(catalog_find_region), merged into one (merge)",
        "keep the place and say that places just beyond its border are left out",
    ):
        assert phrase in DATASET_STEP, phrase
    too_many = _plain(
        SKILL.instructions.split("- `too_many_destinations`:")[1].split("\n- `")[0]
    )
    assert (
        "Give their dataset steps filter.area, the region one level up (The "
        "draft, dataset), or a where" in too_many
    )
    assert "for the place asked about" not in too_many


def test_a_share_comes_from_one_assignment_and_never_passes_100_percent() -> None:
    """Reached residents split over districts by area share, divided by
    census points counted per district, gave shares above 100 % that the
    answer explained away. Per area both sides come from one assignment, and
    a share above 100 % is never presented."""
    for phrase in (
        "Per area, both come from one assignment",
        "residents per district are the census points counted by the district "
        "they lie in, all of them and those in the reached cells or areas "
        "(heatmap.md, Shares per district)",
        "never cells or areas split over the districts by area share",
        "A share above 100 % is never presented: the tool notes it, and you "
        "rebuild the share from one assignment first",
    ):
        assert phrase in SHARE_BULLET, phrase


def test_the_recipe_counts_census_points_per_district_for_both() -> None:
    """The per-district recipe cuts the heatmap's cells by the districts and
    sums the census points per piece, and sums all census points per
    district: both by the district each point lies in."""
    [draft] = [
        json.loads(block)
        for block in re.findall(r"```json\n(.*?)\n```", SHARES_PER_DISTRICT, re.S)
    ]
    steps = {step["id"]: step for step in draft["steps"]}
    links = {
        (link["from"], link["to"], link.get("input")) for link in draft["connections"]
    }
    tools = {key: step["tool"] for key, step in steps.items() if step["kind"] == "tool"}
    assert sorted(tools.values()) == [
        "aggregate_points",
        "aggregate_points",
        "heatmap_closest_average",
        "intersection",
    ]
    [heat] = [key for key, tool in tools.items() if tool == "heatmap_closest_average"]
    [cut] = [key for key, tool in tools.items() if tool == "intersection"]
    [districts] = [
        key for key, step in steps.items() if (key, cut, "overlay_layer_id") in links
    ]
    reached, every = sorted(
        (key for key, tool in tools.items() if tool == "aggregate_points"),
        key=lambda key: (cut, key, "area_layer_id") not in links,
    )
    assert (heat, cut, "input_layer_id") in links
    assert (cut, reached, "area_layer_id") in links
    assert (districts, every, "area_layer_id") in links
    [people] = [
        key for key, step in steps.items() if (key, reached, "source_layer_id") in links
    ]
    assert (people, every, "source_layer_id") in links
    assert (
        steps[reached]["settings"]["column_statistics"]
        == steps[every]["settings"]["column_statistics"]
    )
    # The destinations get the region one level up, the residents the place.
    [shops] = [
        key
        for key, step in steps.items()
        if (key, heat, "opportunity_layer_1_id") in links
    ]
    place = steps[people]["filter"]["area"]
    assert steps[shops]["filter"]["area"] == place[:-1]
    text = _plain(SHARES_PER_DISTRICT)
    for phrase in (
        "counts the census points by the district they lie in, for both: all of "
        "them, and those in the reached cells or areas",
        "group_by the district's name field as the intersection writes it, "
        "intersection_<field>",
        "share_of the second saved layer",
        "group_by the name field itself",
        "filter total_accessibility <= each limit on the first",
        "the catchment in place of the heatmap",
        "Never take the reached residents from cells or areas spread over the "
        "districts by area share",
    ):
        assert phrase in text, phrase


def test_the_recipe_keeps_the_minutes_beside_the_residents() -> None:
    """goatlib predicts what the chain writes: the intersection keeps the
    cells' minutes, and aggregate_points into its pieces keeps them beside
    the residents' sum. The district's field is not asserted: the prediction
    keeps its name, while the run writes it as intersection_<field>."""
    from goatlib.tools.schema_prediction import predict_node_output_schema

    [draft] = [
        json.loads(block)
        for block in re.findall(r"```json\n(.*?)\n```", SHARES_PER_DISTRICT, re.S)
    ]
    by_tool = {step["tool"]: step for step in draft["steps"] if step["kind"] == "tool"}
    heat = by_tool["heatmap_closest_average"]
    cells = predict_node_output_schema(heat["tool"], {}, heat["settings"])
    assert cells is not None
    districts = {"name": "VARCHAR", "geometry": "GEOMETRY"}
    pieces = predict_node_output_schema(
        "intersection",
        {"input_layer_id": cells.columns, "overlay_layer_id": districts},
        by_tool["intersection"].get("settings", {}),
    )
    assert pieces is not None and "total_accessibility" in pieces.columns
    census = {"einwohner": "DOUBLE", "geometry": "GEOMETRY"}
    summed = predict_node_output_schema(
        "aggregate_points",
        {"area_layer_id": pieces.columns, "source_layer_id": census},
        by_tool["aggregate_points"]["settings"],
    )
    assert summed is not None
    assert {"total_accessibility", "einwohner_sum"} <= set(summed.columns)


def test_residents_per_district_never_go_through_cells() -> None:
    bands = _plain(CATCHMENT_AREAS).split("- Bands per district:")[1]
    assert "intersection_<field>" in bands
    assert (
        "share_of the residents per district: all census points summed per "
        "district (heatmap.md, Shares per district)" in bands
    )
    areas = RECIPES_TEXT.split("- Areas counted or summed per district")[1]
    areas = areas.split("## ")[0]
    assert (
        "Residents per district never go through cells: count the census points "
        "themselves (Shares per district)" in areas
    )
    heat = _plain(WHO_LIVES)
    assert (
        "share_of the census points of the place, filtered as the residents step "
        "is (share_of takes no region: filter both with a where on an area code "
        "field when the census layer has one)" in heat
    )


def _heat_drafts() -> list[dict[str, Any]]:
    """The first draft of the heatmap recipe and the per-district draft."""
    return [
        json.loads(re.findall(r"```json\n(.*?)\n```", text, re.S)[0])
        for text in (WHO_LIVES, SHARES_PER_DISTRICT)
    ]


def test_the_heatmap_drafts_compute_only_the_places_hexagons() -> None:
    """With the destinations of the region one level up, a heatmap computed
    hexagons around every one of them. A polygon of the place connected to
    reference_area_layer_id keeps the hexagons to the place, gives each its
    real minutes on a street mode (no budget: goatlib's
    budget_replaced_by_reference_area) and keeps only the destinations
    within reach (heatmap_v2 _within_area_reach). The destinations keep
    their margin, the residents the place."""
    for draft in _heat_drafts():
        steps = {step["id"]: step for step in draft["steps"]}
        links = {
            (link["from"], link["to"], link.get("input"))
            for link in draft["connections"]
        }
        [heat] = [
            key
            for key, step in steps.items()
            if step.get("tool") == "heatmap_closest_average"
        ]
        [area] = [
            key for key in steps if (key, heat, "reference_area_layer_id") in links
        ]
        assert steps[area]["kind"] == "dataset"
        # filter.area keeps every neighbour that touches the place's border.
        assert "area" not in (steps[area].get("filter") or {})
        settings = steps[heat]["settings"]
        assert settings["routing_mode"] != "pt"
        assert settings["show_advanced"] is True
        assert "opportunity_1_max_cost" not in settings
        assert settings["opportunity_1_n_destinations"] == 1
        [shops] = [
            key for key in steps if (key, heat, "opportunity_layer_1_id") in links
        ]
        [people] = {key for key, _, into in links if into == "source_layer_id"}
        place = steps[people]["filter"]["area"]
        assert steps[shops]["filter"]["area"] == place[:-1]


def test_the_recipe_says_where_the_reference_area_comes_from() -> None:
    text = _plain(WHO_LIVES)
    for phrase in (
        "The reference area (reference_area_layer_id, with show_advanced true) "
        "is a polygon of the place",
        "a project layer of its boundary or its districts",
        "else the country's municipalities or districts from the catalog "
        "search (SKILL.md, step 3)",
        "Filter such a layer to the place with a where on its official code "
        "field, never with filter.area, which keeps every neighbour touching "
        "its border too",
        "the run then has no budget (leave opportunity_1_max_cost out)",
        "computes only the place's hexagons, each with its real minutes",
        "keeps only the destinations within its reach: 45 minutes at the mode's "
        "speed in a straight line around it (by car 90 minutes at 50 km/h)",
        "the check leaves that count to the run",
        "The residents keep the place (filter.area): the hexagons on its "
        "border reach past it",
        "By public transport the reference area only cuts the result",
        "share_of the same saved layer without a filter",
        "Without a polygon of the place",
    ):
        assert phrase in text, phrase
    per_district = _plain(SHARES_PER_DISTRICT)
    assert "The districts are the heatmap's reference area" in per_district
    assert "One run answers every limit" in per_district
    # catchment_area_v2 has no reference_area_layer_id input.
    assert "the catchment in place of the heatmap, without the reference area" in (
        per_district
    )


def test_the_skill_points_a_heatmap_to_its_reference_area() -> None:
    """The margin's fallback to the place is for catchments and heatmaps
    without a polygon of the place; with one, the destination check is left
    to the run (processes' _trimmed_to_reference_area); a polygon from the
    catalog rides on the heatmap option's adds."""
    assert (
        "A heatmap with a polygon of the place as its reference area (heatmap.md) "
        "needs no such fallback: it computes only the place's hexagons, and only "
        "the destinations within its reach count toward what the run takes"
        in DATASET_STEP
    )
    too_many = _plain(
        SKILL.instructions.split("- `too_many_destinations`:")[1].split("\n- `")[0]
    )
    assert (
        "or connect a polygon of the place to the heatmap's "
        "reference_area_layer_id (heatmap.md)" in too_many
    )
    assert (
        "the heatmap, recommended, with a polygon of the place from the catalog "
        "in adds when the project has none (heatmap.md)" in CARD
    )
    assert "two options and no adds" not in CARD


PT_SERVICE = SKILL.files["transit-service.md"].partition(
    "## Public transport service of a place"
)[2]
PT_SERVICE = PT_SERVICE.split("\n## ")[0]


def _pt_draft() -> dict[str, Any]:
    [draft] = [
        json.loads(block)
        for block in re.findall(r"```json\n(.*?)\n```", PT_SERVICE, re.S)
    ]
    return draft


def test_service_quality_counts_residents_per_class_and_district() -> None:
    """Live pass (2026-10-26): asked whether a city is well served by public
    transport, the card recommended the distance to stops and left out the
    quality classes; pass 6 gave km² per class. The recipe rates the place
    with oev_gueteklassen and counts the census points per class and
    district in one aggregate_points: union cuts the classes by the
    districts, and a district's area in no class becomes pieces of their
    own. The window the answer states is set in the step, at the tool's
    defaults."""
    draft = _pt_draft()
    steps = {step["id"]: step for step in draft["steps"]}
    links = {
        (link["from"], link["to"], link.get("input")) for link in draft["connections"]
    }
    tools = {key: step["tool"] for key, step in steps.items() if step["kind"] == "tool"}
    assert sorted(tools.values()) == ["aggregate_points", "oev_gueteklassen", "union"]
    [classes] = [key for key, tool in tools.items() if tool == "oev_gueteklassen"]
    [split] = [key for key, tool in tools.items() if tool == "union"]
    [count] = [key for key, tool in tools.items() if tool == "aggregate_points"]
    [districts] = [
        key for key in steps if (key, classes, "reference_area_layer_id") in links
    ]
    assert (classes, split, "input_layer_id") in links
    assert (districts, split, "overlay_layer_id") in links
    assert (split, count, "area_layer_id") in links
    [people] = [key for key in steps if (key, count, "source_layer_id") in links]
    assert steps[people]["filter"] == {"area": "DE212"}
    assert steps[count]["settings"] == {
        "area_type": "polygon",
        "column_statistics": [{"operation": "sum", "field": "einwohner"}],
    }
    window = {"weekday": "weekday", "from_time": 25200, "to_time": 32400}
    assert steps[classes]["settings"] == window
    defaults = {
        setting.name: setting.default
        for setting in tool_info.settings(DESCRIPTIONS["oev_gueteklassen"])
    }
    assert {name: defaults[name] for name in window} == window


def test_the_quality_class_pieces_keep_class_and_district_beside_residents() -> None:
    """goatlib predicts what the chain writes: the classes' label, then the
    district's fields under their own names after union, and both beside
    the residents' sum after aggregate_points."""
    from goatlib.tools.schema_prediction import predict_node_output_schema

    by_tool = {
        step["tool"]: step for step in _pt_draft()["steps"] if step["kind"] == "tool"
    }
    classes = predict_node_output_schema(
        "oev_gueteklassen", {}, by_tool["oev_gueteklassen"]["settings"]
    )
    assert classes is not None
    assert {"pt_class", "pt_class_label"} <= set(classes.columns)
    districts = {"name": "VARCHAR", "geometry": "GEOMETRY"}
    pieces = predict_node_output_schema(
        "union",
        {"input_layer_id": classes.columns, "overlay_layer_id": districts},
        by_tool["union"].get("settings", {}),
    )
    assert pieces is not None and {"pt_class_label", "name"} <= set(pieces.columns)
    census = {"einwohner": "DOUBLE", "geometry": "GEOMETRY"}
    summed = predict_node_output_schema(
        "aggregate_points",
        {"area_layer_id": pieces.columns, "source_layer_id": census},
        by_tool["aggregate_points"]["settings"],
    )
    assert summed is not None
    assert {"pt_class_label", "name", "einwohner_sum"} <= set(summed.columns)


def test_the_quality_class_recipe_reads_residents_and_names_the_trade_offs() -> None:
    text = _plain(PT_SERVICE)
    for phrase in (
        # the measure and what the answer gives
        "recommend the ÖV-Güteklassen (oev_gueteklassen)",
        "the share of residents in each class, A (best) to F, and in none",
        "the districts with the largest shares in F and in none",
        # how the classes come out, and that each resident counts once
        "pt_class (1 for A) and pt_class_label",
        "a worse class has the better ones cut out, so each census point lies "
        "in one piece and counts once",
        "a district's area in no class becomes pieces with an empty " "pt_class_label",
        "Residents, never km² per class",
        # reading the shares, none included
        "group_by pt_class_label, share_of the same saved layer without a filter",
        "the row without group is the residents in no class",
        "then_by pt_class_label, share_of the same layer group_by the name field",
        "the rows without then are no class",
        # the window and the border
        "Weekdays 7 to 9 are the tool's defaults",
        "state the window",
        "Only stops inside the reference area are rated",
        # the other measures, each with what it leaves out
        "proximity only, no frequency",
        "frequency only, not linked to residents",
        "the reversed matrix (SKILL.md, Running and explaining), not the reach "
        "from one station",
        # a verdict needs a benchmark
        "A yes or no only against a benchmark the user names: another place, "
        "another time window with the same classes",
        "or a stated target",
        "Without one, the numbers are the answer",
        "offer the evening or Sunday comparison as a follow-up option",
    ):
        assert phrase in text, phrase


def test_the_skill_sends_a_service_question_to_the_recipe_before_its_card() -> None:
    """The measure card follows the recipe, so the skill reads it before
    that card; the description names the question, so the skill is found."""
    assert "how well a place is served by public transport" in SKILL.description
    for phrase in (
        "How well a place is served by public transport: read "
        "transit-service.md before the card that asks for the measure",
        "load its recipe file (Recipe files) before any card",
    ):
        assert phrase in STEP_1, phrase
    # The recipe's measures replace the card rule's own example.
    assert "service level, not only distance" not in CARD


def test_a_dataset_option_says_what_it_leaves_out_too() -> None:
    """Every card option says what it leaves out or how exact it is (the
    prompt's asking rule), the options that add data included."""
    assert (
        'description: what it leaves out or how exact it is, then "Adds it to '
        'the project"' in CARD
    )


FIND = _plain(SKILL.instructions.split("3. **Find the data.**")[1].split("4. **")[0])
AFTER = _plain(
    SKILL.instructions.split("4. **After the answer.**")[1].split("5. **")[0]
)


def test_a_catalog_copy_is_waited_for_before_the_workflow_is_created() -> None:
    """Pass 7: a dataset step whose catalog copy was not ready was left open,
    and a workflow with a step left open is not run. The answer waits for
    the copy and reads its fields before it creates the workflow; only a
    copy that fails leaves the step open, and the answer then says the
    workflow needs the user's choice before it can run."""
    for phrase in (
        "Wait for the copy before you create the workflow",
        "read the layer's fields with project_get_fields; while it says the "
        "layer is still being copied, read them again",
        "Only when the copy failed, leave that dataset step open, labelled with "
        "the dataset's name",
        "say in the answer that the workflow needs the user's choice of that "
        "layer before it can run",
    ):
        assert phrase in AFTER, phrase
    assert "so the user chooses the layer once its copy is ready" not in AFTER
    assert "leave that dataset step open, labelled with the dataset's name, so" not in (
        AFTER
    )


def test_a_missing_input_gets_the_computable_part_recommended_and_run() -> None:
    """Pass 7 (Q29, Q36, Q37): with an input missing, cards recommended
    leaving the step open or waiting for the user's data, and a workflow
    with a step left open was run and refused. The computable part is
    recommended and run; the gap is a second option, never recommended."""
    missing = FIND.split("Missing inputs.")[1]
    for phrase in (
        "say plainly which input is missing",
        "recommend the part that can be computed without it, and run it when "
        "the user asked for a result",
        "today's state without the planned change",
        "the scheduled lines alone",
        "a named stand-in, such as the stations for job centres",
        "The answer names the stand-in and what it stands for",
        "Waiting for the user's data, or a workflow with the step left open",
        "is a second option, never the recommended one",
        "A step left open is the user's to fill in the editor, so it needs no card",
        "a workflow with a step left open is not run",
    ):
        assert phrase in missing, phrase
    assert "nothing fits anywhere: the input is missing (Missing inputs" in FIND
    assert "nothing fits anywhere: leave the step open" not in FIND
    for phrase in (
        "When an input is missing, no option answers the whole question now: "
        "recommend the part that can be computed (Missing inputs)",
        '"Leave it open" (no value, never recommended)',
    ):
        assert phrase in CARD, phrase
    issue = SKILL_TEXT.split("- layer_not_chosen:")[1].split("- ")[0]
    assert "such a workflow is not run" in issue
    left_open = _plain(CATCHMENT_AREAS).split("- Residents left open")[1]
    assert "such a workflow is not run" in left_open.split("- ")[0]


def test_the_census_grid_is_the_first_population_source_in_germany() -> None:
    """Pass 7 (Q25, Q43): cards recommended district tables that held only
    age groups, unread, before the census grid; a population search without
    the word zensus did not find it."""
    role = FIND.split("- residents:")[1].split("- public transport origins:")[0]
    for phrase in (
        "For a place in Germany, the first population source to try is the "
        "Zensus 2022 grid (residents per 100 m cell, as census points)",
        "put zensus among the words of the catalog search",
        "District or statistical-area tables come after it, since many hold "
        "only age groups or shares",
        "read a candidate's fields before a card recommends it",
    ):
        assert phrase in role, phrase


def test_a_far_part_of_the_place_is_left_out_of_the_reference_area() -> None:
    """Pass 7 (Q28): an island far from the rest of the place made a walking
    heatmap's area too large to run. The recipe leaves such a part out of the
    reference area and says so."""
    bullet = _plain(WHO_LIVES).split("- A part of the place far from the rest")[1]
    bullet = bullet.split("- ")[0]
    for phrase in (
        "(an island or an exclave many kilometres off)",
        "does not belong in the reference area",
        "a run on foot or by bicycle must cover, and can stop the run",
        "A reference area whose extent (project_get_layers) is much wider than "
        "the place shows such a part",
        "Leave such a part out of the reference area",
        "a layer that holds it as a feature of its own (the place's quarters or "
        "statistical areas, when the boundary or a district holds it together "
        "with the rest)",
        "a where with != on its code or name field drops it",
        "Say in the answer which part was left out",
    ):
        assert phrase in bullet, phrase


def test_a_part_of_a_city_is_filtered_with_the_citys_own_layer() -> None:
    """Live pass 8 (Q32): a district of a city that is not a NUTS region was
    filtered with a same-named NUTS district in another state, so the
    residents counted were not the district's. Such a part is filtered in the
    city's own boundary layer, and a region found by name is checked by its
    parents."""
    for phrase in (
        "A district or quarter of a city that is not a NUTS region is filtered "
        "by name or geometry in the city's own boundary layer (its districts or "
        "quarters layer), never with a NUTS region of the same name",
        "catalog_find_region names each region's parents (state, country): "
        "check them against the place the user named",
    ):
        assert phrase in DATASET_STEP, phrase


#: The rules of live pass 8, each with the part of the skill it sits in.
PASS_8_RULES = {
    "card": [
        # 6.6: options that cannot be computed, or that drop part of the question
        "Every option that promises a result is one you can compute with the "
        "tools workflow_tools lists and data this answer has found, its fields "
        "read when the option relies on one",
        "never offer what no tool can do (a changed timetable or network), nor "
        "data no search found as if it were there",
        "An option that needs the user's own upload is never recommended, and "
        "its description says that it needs their upload (Missing inputs)",
        "The recommended scope is the one the question names: both parts of a "
        "question in two parts, and a corridor, a line or a district it names "
        "rather than the whole city",
        "both time windows, all the modes, the whole area it names",
    ],
    "find": [
        # 6.6: a field said to be missing from a record cut at 60 columns
        "Never say that a dataset lacks a field (an income, a car count, a "
        "capacity) before you have read its field list: project_get_fields for "
        "a project layer, and for a catalog dataset once it is added",
        "A catalog record lists at most 60 columns of a layer, so a field "
        "missing from a list of 60 may still exist",
        "say that the field is still to be checked, never that it is missing",
    ],
    "running": [
        # 6.5 (Q33): classes that left features out
        "Classes you build yourself (A, B and C from thresholds, with filters or "
        "If steps) partition the features: each feature in exactly one class",
        "let the last class take every feature the others leave",
        "check that the class counts add up to the total, as a check and not a "
        "number to cite",
        "whose row without group holds the features in no class",
        "When they do not add up, fix the classes before you answer",
    ],
    "draft": [
        # 6.5 (Q43): union and dissolve rebuilt the whole districts
        "To cut one area by another (the reached area per district, the part of "
        "a district inside a catchment), use intersection: it keeps only what "
        "lies in both",
        "union keeps the parts outside the other area too, and a dissolve by the "
        "district's name then rebuilds the whole districts",
        # 6.5 (Q28): pieces counted in every cell they touch
        "To count or sum into cells (an H3 grid, the heatmap's hexagons, a grid "
        "layer), aggregate points",
        "The pieces of an intersection or a union never go into a layer of "
        "cells unweighted: aggregate_polygon with polygons as its areas counts a "
        "piece in every cell it touches",
        "With area_type h3_grid it puts each polygon whole into the cell of its "
        "centroid",
        "Residents held only as polygons, when no points exist, take "
        "weighted_by_intersecting_area (catchments.md), labelled as an estimate",
    ],
}
RUNNING = _plain(
    SKILL.instructions.split("## Running and explaining")[1].split("\n## ")[0]
)
THE_DRAFT = _plain(SKILL.instructions.split("## The draft")[1].split("\n## ")[0])


@pytest.mark.parametrize(
    ("part", "phrase"),
    [(part, phrase) for part, phrases in PASS_8_RULES.items() for phrase in phrases],
)
def test_the_skill_holds_the_rule_of_the_eighth_pass(part: str, phrase: str) -> None:
    """Live pass 8 (6.5, 6.6): recommended options that could not be
    computed or dropped half of the question, fields called missing from a
    record cut at 60 columns, classes that left features out, a union and
    dissolve that rebuilt whole districts, and pieces counted in every cell
    they touched. Each rule sits where the step it governs is read: the
    card, the data check, the reading of results, the draft."""
    text = {"card": CARD, "find": FIND, "running": RUNNING, "draft": THE_DRAFT}
    assert phrase in _plain(text[part]), phrase


def test_the_union_rule_keeps_the_service_recipes_union() -> None:
    """The quality-class recipe cuts the classes by the districts with union
    on purpose: a district's area in no class becomes pieces of its own. The
    intersection rule names that exception, so the two never contradict."""
    assert (
        "Use union only when the parts outside count as well (the area in no "
        "class, transit-service.md)" in THE_DRAFT
    )
    assert '"tool": "union"' in PT_SERVICE


def test_nothing_the_model_reads_names_the_english_undo_label() -> None:
    """German answers call the button "Rückgängig"; the skill and the
    workflow_update description name it without its English label, so neither
    leads an answer back to "Undo"."""
    from assistant.tools.workflow_edits import UPDATE

    assert "Undo in the dock" not in SKILL_TEXT
    assert "Undo in the dock" not in UPDATE.description
