"""The built-in skill style-a-map and the prompt around it: the skill loads
with its three reference files, every tool, palette, icon, emoji, key and issue
code it names exists, every style example is a call goatlib accepts for the
layer kind its marker names, and every map example a call map_update reads."""

import json
import re
from dataclasses import dataclass
from typing import Any, get_args
from uuid import UUID

import pytest
from goatlib.style.catalog import icon_libraries, icon_names, palettes
from goatlib.style.context import BandInfo, DataContext, FieldInfo, raster_fields
from goatlib.style.defaults import default_style
from goatlib.style.edit import Edit, apply_edits
from goatlib.style.ids import assign_ids
from goatlib.style.issues import CODES
from goatlib.style.models.classify import NUMERIC_METHODS
from goatlib.style.schema import json_schema
from goatlib.style.validate import validate

from assistant.asks import AskUserInput, consent_problem
from assistant.context import parse_context
from assistant.maps.operations import MapUpdateInput, new_group_index
from assistant.prompt import INSTRUCTIONS, SKILLS_INDEX, render_note
from assistant.skills import BUILT_IN, SKILLS_DIR, Skill
from assistant.styles.catalog import CatalogInput
from assistant.styles.edits import StyleUpdated, StyleUpdateInput
from assistant.tools.filters import FeatureFilter
from assistant.tools.map_edits import MAP_UPDATE, MapUpdated, removal_value
from assistant.tools.project import FieldStatistics, ProjectLayers, StatisticsInput
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.styles import UPDATE_STYLE, StyleGetInput, StyleView
from assistant.workflows.runs import RunStatus

NAME = "style-a-map"
FILES = {"rasters.md", "looks-and-analyses.md", "popups.md"}
PROJECT = UUID("00000000-0000-0000-0000-0000000005e9")
TOOL_NAME = re.compile(
    r"\b(?:workflow|project|catalog|core|map|style|ask|skills)_[a-z_]+\b"
)
#: Arguments the tool pattern also matches.
ARGUMENTS = {"style_id", "project_id"}
#: The sections of SKILL.md, in the order the model reads them.
SECTIONS = [
    "How to work",
    "Reference files",
    "Edit in place",
    "Writing the change",
    "Which form for which data",
    "Palettes",
    "Classes",
    "Sizes",
    "Icons and emoji",
    "Labels",
    "Popups",
    "Legend texts",
    "Heights and 3D",
    "Zoom ranges",
    "Reading the legend numbers",
    "A new style or variants",
    "Changing the map",
    "What you cannot do",
    "Mistakes the check answers with a fix",
    "House examples",
]
#: An example: the marker line, then the call in a json block. A layer marker
#: stands above a style_update call and names the layer's kind and, after a
#: comma, its state: a vector layer that is already classified, a raster that
#: holds whole-number codes. A call marker names the tool of any other call.
MARKED = re.compile(
    r"<!-- (layer|call): ([a-z_]+)(?:, ([a-z]+))? -->\n```json\n(.*?)\n```", re.S
)
JSON_FENCE = re.compile(r"^```json$", re.M)
BACKTICKED = re.compile(r"`([^`\n]+)`")
IDENTIFIER = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*")
POINTER = re.compile(r"(?:/[A-Za-z0-9_]+)+")
PALETTE_ID = re.compile(r"\b(colorbrewer|d3|carto|uber):([A-Za-z0-9_]+)")
GOAT_ID = re.compile(r"\bgoat:([A-Za-z0-9][A-Za-z0-9_-]*)")
EMOJI_ID = re.compile(r"\bemoji:([0-9a-f]+(?:-[0-9a-f]+)*)")

#: The fields the examples read, as a layer of each kind would have them.
FIELDS = (
    FieldInfo("name", "string"),
    FieldInfo("category", "string", values=("school", "shop", "park", "cafe")),
    FieldInfo("density", "number", min=150, max=12000),
    FieldInfo("population", "integer", min=0, max=90000),
    FieldInfo("share", "number", min=0, max=1),
    FieldInfo("change", "number", min=-15, max=15),
    FieldInfo("visitors", "integer", min=0, max=50000),
    FieldInfo("floors", "integer", min=1, max=20),
    FieldInfo("year", "integer", min=1870, max=2024),
    FieldInfo("active", "boolean"),
    FieldInfo("opened", "date"),
    FieldInfo("website", "string"),
    FieldInfo("photo_url", "string"),
)
#: Ids and field names the examples' pointers name beside the style's keys.
POINTER_WORDS = {f.name for f in FIELDS} | {"c1", "c2", "c3", "r1", "b1", "k1"}
#: Words in code marks that are no key or value of a style or a tool: rows of
#: the catalogue tool, the layer kinds, JSON's own words and GOAT's fields of
#: a cluster or a raster cell.
OTHER_WORDS = {
    "colors",
    "group",
    "point",
    "line",
    "polygon",
    "raster",
    "true",
    "false",
    "null",
    "b1",
    "b2",
    "b3",
    "b4",
    "band_1",
    "custom",
}
#: Key phrases of sentences that would tell the model to create a style or
#: variants without being asked.
UNASKED = (
    "replaces what the layer shows",
    "replaces what the layer draws",
    "leaves room",
    "leaves no room",
    "gets two variants",
    "it is a new named style",
    "One variant only",
    "one variant, without a card",
)


def _skill() -> Skill:
    return BUILT_IN[NAME]


def _texts() -> dict[str, str]:
    skill = BUILT_IN.get(NAME)
    return {"SKILL.md": skill.instructions, **skill.files} if skill else {}


def _plain(text: str) -> str:
    """The text on one line, without Markdown's code marks."""
    return " ".join(text.split()).replace("`", "")


def _section(heading: str) -> str:
    return _skill().instructions.split(f"## {heading}\n")[1].split("\n## ")[0]


@dataclass(frozen=True)
class Example:
    source: str
    marker: str
    kind: str
    state: str | None
    call: dict[str, Any]


def _examples() -> list[Example]:
    return [
        Example(source, marker, kind, state or None, json.loads(block))
        for source, text in _texts().items()
        for marker, kind, state, block in MARKED.findall(text)
    ]


def _style_calls() -> list[Example]:
    return [example for example in _examples() if example.marker == "layer"]


def _calls(tool: str) -> list[Example]:
    """The examples of another tool's call."""
    return [e for e in _examples() if e.marker == "call" and e.kind == tool]


def _example_id(example: Any) -> str:
    """A test id; without examples pytest asks for the id of its placeholder."""
    return str(getattr(example, "call", example))[:60]


def _context(kind: str, state: str | None = None) -> DataContext:
    if kind == "raster":
        assert state in (None, "codes"), state
        return DataContext(
            kind="raster",
            fields=raster_fields(range(1, 5)),
            bands=tuple(BandInfo(n, 0.0, 3000.0) for n in range(1, 5)),
            data_type="uint8" if state == "codes" else "float32",
        )
    assert kind in ("point", "line", "polygon"), kind
    return DataContext(
        kind="vector",
        geometry=kind,  # type: ignore[arg-type]
        feature_count=500,
        fields={f.name: f for f in FIELDS},
    )


_MAIN = {"point": "marker", "line": "line", "polygon": "fill"}
_RAMP = ("#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026")
_BOUNDS = (1000.0, 2500.0, 4000.0, 6000.0)
_SET = ("#1b9e77", "#d95f02", "#7570b3")


def _start(kind: str, state: str | None) -> dict[str, Any]:
    """The style an example starts from: goatlib's default for the layer
    kind, and for a classified vector layer one classification beside it: on
    polygons five quantile classes of `density` (id density), on points and
    lines three categories of `category` (id category) with the rest in
    grey."""
    document = default_style(_context(kind, state if kind == "raster" else None))
    if state is None or kind == "raster":
        return assign_ids(document)
    assert state == "classified", (kind, state)
    part = _MAIN[kind]
    if kind == "polygon":
        limits = (None, *_BOUNDS, None)
        classes: list[dict[str, Any]] = []
        for n, color in enumerate(_RAMP):
            record: dict[str, Any] = {"id": f"c{n + 1}", part: {"color": color}}
            if limits[n] is not None:
                record["from"] = limits[n]
            if limits[n + 1] is not None:
                record["to"] = limits[n + 1]
            classes.append(record)
        document["classify"] = [
            {
                "id": "density",
                "field": "density",
                "method": "quantile",
                "count": 5,
                "palette": "colorbrewer:YlOrRd",
                "classes": classes,
            }
        ]
    else:
        document["classify"] = [
            {
                "id": "category",
                "field": "category",
                "method": "categories",
                "classes": [
                    {"id": f"c{n + 1}", "values": [value], part: {"color": color}}
                    for n, (value, color) in enumerate(
                        zip(("school", "shop", "park"), _SET, strict=True)
                    )
                ],
                "other": {"name": "Other", part: {"color": "#9aa3ad"}},
            }
        ]
    return assign_ids(document)


def _result(example: Example) -> dict[str, Any]:
    """The document the example's call asks core to save."""
    call = StyleUpdateInput.model_validate(example.call)
    mode = call.mode()
    if mode in ("new_whole", "replace"):
        assert call.document is not None
        return call.document
    start = call.new_style.start if call.new_style else "current"
    base = _start(example.kind, None if start == "empty" else example.state)
    if not call.operations:
        return base
    return apply_edits(base, call.operations).document


def _words(node: Any, found: set[str]) -> set[str]:
    """Every property name and every allowed text value of a JSON schema."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                found.update(value)
            elif key == "enum" and isinstance(value, list):
                found.update(v for v in value if isinstance(v, str))
            elif key == "const" and isinstance(value, str):
                found.add(value)
            _words(value, found)
    elif isinstance(node, list):
        for item in node:
            _words(item, found)
    return found


def _vocabulary() -> set[str]:
    """What a word in code marks may be: a key or a value of GOAT Style, an
    argument or a result key of the tools the skill builds on, an issue code,
    or one of the examples' own names."""
    known = _words(json_schema(), set())
    for model in (
        StyleUpdateInput,
        StyleUpdated,
        StyleGetInput,
        StyleView,
        CatalogInput,
        ProjectLayers,
        StatisticsInput,
        FieldStatistics,
        FeatureFilter,
        AskUserInput,
        Edit,
        MapUpdateInput,
        MapUpdated,
    ):
        known |= _words(model.model_json_schema(), set())
    return known | set(CODES) | set(get_args(RunStatus)) | POINTER_WORDS | OTHER_WORDS


# -- the skill and its files -----------------------------------------------------


def test_the_skill_loads_and_names_its_three_files() -> None:
    skill = _skill()
    assert set(skill.files) == FILES
    named = set(re.findall(r"\b[\w-]+\.md\b", skill.instructions)) - {"SKILL.md"}
    assert named == FILES
    assert f"- `{NAME}`: {skill.description}" in SKILLS_INDEX
    # One sentence on when to load it, then four requests as examples.
    assert "Map page" in skill.description
    assert len(re.findall(r'"[^"]+"', skill.description)) == 4
    # Each reference file is listed with when to load it.
    listed = re.findall(r"^- `([a-z-]+\.md)`: ", _section("Reference files"), re.M)
    assert sorted(listed) == sorted(FILES)
    for name, text in skill.files.items():
        named_there = set(re.findall(r"\b[\w-]+\.md\b", text))
        assert named_there <= {"SKILL.md", *FILES}, name


def test_the_sections_come_in_the_order_the_model_works() -> None:
    assert re.findall(r"^## (.+)$", _skill().instructions, re.M) == SECTIONS


def test_skill_md_stays_within_thirty_four_thousand_eight_hundred_fifty_bytes() -> None:
    assert len((SKILLS_DIR / NAME / "SKILL.md").read_bytes()) <= 34_850


def test_no_dashes_inside_sentences() -> None:
    texts = {**_texts(), "description": _skill().description}
    assert set(texts) == {"SKILL.md", *FILES, "description"}
    for name, text in texts.items():
        assert "—" not in text and "–" not in text, name


def test_nothing_the_model_reads_names_the_english_undo_label() -> None:
    """German answers call the button "Rückgängig": the skill names it as the
    dock's undo button and never by its English label."""
    texts = {**_texts(), "description": _skill().description}
    for name, text in texts.items():
        assert not re.search(r"\bUndo\b", text), name
    assert "the dock's undo button" in _plain(_skill().instructions)


def test_the_skill_names_only_tools_that_exist() -> None:
    named = {name for text in _texts().values() for name in TOOL_NAME.findall(text)}
    named -= ARGUMENTS
    assert {
        "style_get",
        "style_update",
        "style_catalog",
        "project_get_layers",
        "project_get_fields",
        "project_field_statistics",
        "ask_user",
        "map_update",
    } <= named
    assert named <= set(BY_WIRE_NAME), named - set(BY_WIRE_NAME)


def test_it_says_to_read_before_styling_in_this_order() -> None:
    steps = _plain(_section("How to work"))
    order = [
        "project_get_layers",
        "project_get_fields",
        "project_field_statistics",
        "style_get",
        "style_update",
    ]
    places = [steps.index(tool) for tool in order]
    assert places == sorted(places)
    assert "Never style by a field you have not read" in steps
    # The undo button is under every answer: the answer need not name it.
    assert "undo" not in steps
    # The answer is short and in the user's language.
    assert "at most three short sentences" in steps and "language" in steps
    assert "one or two sentences" not in steps


# -- every name exists -----------------------------------------------------------


def test_the_skill_and_the_catalog_agree_on_colorblind_safe_palettes() -> None:
    """Only palettes goatlib rates are called colorblind safe, and the skill
    forbids no filter the catalog offers."""
    rated = {key for key, p in palettes().items() if p.colorblind_safe is True}
    assert rated and all(key.startswith("d3:") for key in rated)
    text = _skill().instructions
    for line in text.splitlines():
        if "colorblind safe" in line:
            named = {f"{a}:{b}" for a, b in PALETTE_ID.findall(line)}
            assert named <= rated, line
            assert "five `d3:` ramps" in line
    assert "Do not search style_catalog" not in text
    query = CatalogInput.model_fields["query"].description or ""
    assert "colorblind_safe" not in query


def test_every_palette_icon_and_emoji_id_named_exists() -> None:
    emoji = icon_libraries()["emoji"]
    # goat: prefixes palettes and icons alike; the arrows' own icon is in no library.
    goat = set(icon_names()) | {"arrow"}
    goat |= {p.split(":", 1)[1] for p in palettes() if p.startswith("goat:")}
    named_palettes: set[str] = set()
    for name, text in _texts().items():
        for library, palette in PALETTE_ID.findall(text):
            assert f"{library}:{palette}" in palettes(), (name, library, palette)
            named_palettes.add(f"{library}:{palette}")
        for word in GOAT_ID.findall(text):
            assert word in goat, (name, word)
        for code in EMOJI_ID.findall(text):
            assert code in emoji, (name, code)
    # The palette rules name palettes of each kind.
    kinds = {palettes()[p].kind for p in named_palettes}
    assert kinds == {"sequential", "diverging", "qualitative"}
    # What a key of an example names is of that key's kind.
    for example in _style_calls():
        for key, value in _pairs(example.call):
            if key == "palette" and isinstance(value, str):
                assert value in palettes(), (example.source, value)
            if key == "icon" and isinstance(value, str):
                library, _, icon = value.partition(":")
                assert icon in icon_libraries()[library], (example.source, value)


def _pairs(node: Any) -> list[tuple[str, Any]]:
    if isinstance(node, dict):
        return [
            pair
            for key, value in node.items()
            for pair in [(key, value), *_pairs(value)]
        ]
    if isinstance(node, list):
        return [pair for item in node for pair in _pairs(item)]
    return []


def test_every_word_in_code_marks_is_one_the_format_or_a_tool_has() -> None:
    """A key, a method, a render type, an argument or an issue code written in
    code marks is checked against goatlib's schema and the tools' own models,
    so a misspelled or invented one fails here and not in a conversation."""
    known = _vocabulary()
    for name, text in _texts().items():
        prose = MARKED.sub("", text)
        for token in BACKTICKED.findall(prose):
            if token.endswith(".md"):
                continue
            if IDENTIFIER.fullmatch(token):
                missing = [word for word in token.split(".") if word not in known]
                assert not missing, (name, token)
            elif POINTER.fullmatch(token):
                words = [w for w in token.split("/")[1:] if not w.isdigit()]
                missing = [word for word in words if word not in known]
                assert not missing, (name, token)


def test_the_classification_methods_are_the_formats_own() -> None:
    classes = _plain(_section("Classes"))
    for method in (*NUMERIC_METHODS, "manual", "categories"):
        assert method in _plain(_skill().instructions), method
    for method in NUMERIC_METHODS:
        assert method in classes, method
    # The statistics tool's name for one method is not a style's.
    for name, text in _texts().items():
        assert "standard_deviation" not in text, name
    rasters = _plain(_skill().files["rasters.md"])
    for render in ("image", "continuous", "categorical", "hillshade"):
        assert render in rasters, render
    looks = _plain(_skill().files["looks-and-analyses.md"])
    for render in ("heatmap", "cluster", "h3"):
        assert render in looks, render


# -- every example is a call goatlib accepts ----------------------------------------


def test_every_json_block_is_a_marked_example() -> None:
    examples = _examples()
    fences = sum(len(JSON_FENCE.findall(text)) for text in _texts().values())
    assert fences == len(examples) and fences >= 20
    kinds = {example.kind for example in _style_calls()}
    assert kinds == {"point", "line", "polygon", "raster"}
    by_file = {example.source for example in examples}
    assert by_file == {"SKILL.md", *FILES}
    # The examples use invented layers only.
    for example in _style_calls():
        assert example.call["layer_project_id"] in (12, 13, 14, 15), example.source


@pytest.mark.parametrize("example", _style_calls(), ids=_example_id)
def test_every_operations_example_applies_with_apply_edits(example: Example) -> None:
    """The call is one of style_update's four ways, and its operations apply
    to the style a layer of that kind starts from."""
    call = StyleUpdateInput.model_validate(example.call)
    assert call.mode() in ("edit", "new_from", "new_whole"), example.source
    for operation in example.call.get("operations") or []:
        Edit.model_validate(operation)
    _result(example)


@pytest.mark.parametrize("example", _style_calls(), ids=_example_id)
def test_every_document_example_validates_for_its_layer_kind(example: Example) -> None:
    """What the call would save has no error and no warning for a layer of
    the kind its marker names: an example that validates with a warning
    teaches the mistake the warning is about."""
    document = _result(example)
    assert "computed" not in json.dumps(example.call)
    state = example.state if example.kind == "raster" else None
    issues = validate(document, _context(example.kind, state))
    bad = [
        (issue.level, issue.code, issue.path, issue.message)
        for issue in issues
        # A palette of the wrong kind is only a note on categories.
        if issue.level != "info" or issue.code == "palette_kind_mismatch"
    ]
    assert not bad, (example.source, bad)


def _objects(node: Any) -> list[dict[str, Any]]:
    if isinstance(node, dict):
        return [node, *(found for value in node.values() for found in _objects(value))]
    if isinstance(node, list):
        return [found for item in node for found in _objects(item)]
    return []


def test_no_example_writes_the_classes_of_a_computed_method() -> None:
    for example in _style_calls():
        for found in _objects(example.call):
            computed = found.get("method") in NUMERIC_METHODS
            assert not (computed and "classes" in found), example.call
        for item in _result(example).get("classify") or []:
            if item.get("method") == "categories":
                # Categories without classes and without a count draw nothing.
                assert item.get("classes") or item.get("count"), example.call


def test_the_card_example_is_the_question_before_a_removal() -> None:
    """One card: it keeps or removes, with the value the tool's refusal
    names for the layer."""
    others = [example for example in _examples() if example.marker == "call"]
    assert {example.kind for example in others} == {"ask_user", "map_update"}
    [card] = [AskUserInput.model_validate(card.call) for card in _calls("ask_user")]
    [question] = card.questions
    values = [option.value for option in question.options]
    assert len(values) == 2 and removal_value(12) in values
    # ask_user shows it once map_update named the value.
    assert consent_problem(card, {removal_value(12)}) is None


@pytest.mark.parametrize("example", _calls("map_update"), ids=_example_id)
def test_every_map_update_example_is_a_call_the_tool_reads(example: Example) -> None:
    """The call parses, names the invented layers only, and a group it names
    as new is one an earlier operation of the same call adds."""
    call = MapUpdateInput.model_validate(example.call)
    for index, operation in enumerate(call.operations):
        dumped = operation.model_dump(exclude_none=True)
        for key, value in _pairs(dumped):
            if key in ("layer_project_id", "fit_layer_project_id"):
                assert value in (12, 13, 14, 15), example.call
            if isinstance(value, str) and value.startswith("new:"):
                added = new_group_index(value)
                assert added is not None and added < index, example.call
                assert call.operations[added].op == "add_group", example.call
        item = dumped.get("item") or {}
        if item.get("type") == "layer":
            assert item["id"] in (12, 13, 14, 15), example.call


def test_the_map_examples_cover_what_the_section_teaches() -> None:
    examples = _calls("map_update")
    assert {example.source for example in examples} == {"SKILL.md"}
    operations = [
        operation for example in examples for operation in example.call["operations"]
    ]
    assert {
        "set_layer",
        "set_basemap",
        "add_group",
        "move",
        "filter",
        "set_view",
        "remove_layer",
    } <= {operation["op"] for operation in operations}
    # One call with several operations.
    assert any(len(example.call["operations"]) > 1 for example in examples)
    # Hiding is visible false; a group added in the call is named new:<index>.
    assert {"op": "set_layer", "layer_project_id": 12, "visible": False} in operations
    assert any(operation.get("group_id") == "new:0" for operation in operations)
    # Rows are added, replaced and removed by number.
    row_operations = {
        row["do"]
        for operation in operations
        if operation["op"] == "filter"
        for row in operation.get("rows", [])
    }
    assert {"add", "replace", "remove"} <= row_operations
    # The view: a layer fitted, and the tilt that shows heights.
    views = [operation for operation in operations if operation["op"] == "set_view"]
    assert any("fit_layer_project_id" in view for view in views)
    assert any(view.get("mode") == "3d" for view in views)


# -- the rules the brief fixes ------------------------------------------------------


def test_it_names_the_three_legend_thresholds() -> None:
    legend = _plain(_section("Reading the legend numbers"))
    # One class with more than 60 percent of the features, or two or more
    # empty classes, means another method.
    assert "60 percent" in legend and "0.6" in legend
    assert "two or more" in legend
    # More than a third in no class means more categories or another field.
    assert "a third" in legend
    # A label field empty for more than half the features is the wrong field.
    assert "half" in legend
    for key in ("features", "without_value", "other", "count", "share"):
        assert key in legend, key
    # Each rule comes with numbers and the next call.
    examples = [e for e in _examples() if e.source == "SKILL.md"]
    in_section = MARKED.findall(_section("Reading the legend numbers"))
    assert len(in_section) >= 2 and len(examples) > len(in_section)
    assert "at most twice" in legend


def test_one_request_takes_one_style_update_and_no_counting_by_hand() -> None:
    steps = _plain(_section("How to work"))
    assert "every operation of the request in one call" in steps
    assert "once per field" in steps
    for key in ("count", "empty"):
        assert key in steps, key
    assert (
        "never count classes with project_count_features or "
        "project_group_statistics" in steps
    )
    assert (
        "do not read the style back after a call that returned without an error"
        in steps
    )
    assert "show no card (but the one that offers asked variants)" in steps
    assert "each variant the user asked for in its own" in steps
    assert "one sentence" in steps
    text = _plain(_skill().instructions)
    assert "Empty values are counted by project_count_features" not in text
    assert "project_count_features with is_null" not in text


def test_a_filtered_layer_is_classed_by_what_the_map_draws() -> None:
    """A computed method classes the whole dataset: for a layer with a saved
    filter, the statistics as drawn give the breaks, written as manual
    classes in the one style change."""
    steps = _plain(_section("How to work"))
    assert "pass as_drawn true" in steps
    classes = _plain(_section("Classes"))
    assert "A computed method classes the whole dataset" in classes
    assert "read with as_drawn true as manual classes" in classes
    assert "the classes follow the features the filter keeps" in classes
    legend = _plain(_section("Reading the legend numbers"))
    assert "a filtered layer: manual classes from its numbers as drawn" in legend
    assert "as_drawn" in StatisticsInput.model_json_schema()["properties"]


def test_a_computed_classification_is_colored_by_its_palette() -> None:
    classes = _plain(_section("Classes"))
    assert "project_field_statistics once" in classes
    assert "Never color the classes of a computed method one by one" in classes
    assert "only when the user names that class" in classes


def test_it_chooses_what_the_user_left_open_and_lists_icons_in_one_call() -> None:
    steps = _plain(_section("How to work"))
    assert "choose one that fits the data and the basemap" in steps
    assert "Ask only when the user wants options" in steps
    icons = _plain(_section("Icons and emoji"))
    assert "no query lists every library icon by group" in icons
    assert "the emoji itself" in icons


def test_it_says_what_style_get_leaves_out_and_what_a_result_can_carry() -> None:
    text = _plain(_skill().instructions)
    assert "12" in _plain(_section("Writing the change"))
    for key in ("part", "cut", "not_saved", "incomplete", "added"):
        assert key in _plain(_section("Writing the change")), key
    assert "all or nothing" in text or "all or none" in text
    # A part that is off holds false; a key set under it turns it on.
    assert "false" in _plain(_section("Writing the change"))


def test_it_edits_in_place_and_names_the_words_that_ask_for_more() -> None:
    """One rule: the active style is changed in place, whatever the size of
    the change. A new named style and variants are for the user to ask for,
    in words the section names."""
    rule = _plain(_section("Edit in place"))
    assert "Always change the style the layer draws, in place" in rule
    assert "whatever the size of the change" in rule
    for change in ("coloring by a field", "a heatmap in place of the points"):
        assert change in rule, change
    assert "the dock's undo button is the way back" in rule
    for words in ('"as a new style"', '"keep the current one"', '"save this as'):
        assert words in rule, words
    for words in ('"give me two options"', '"show me alternatives"'):
        assert words in rule, words
    assert "never offer variants on your own" in rule
    steps = _plain(_section("How to work"))
    assert "edit in place or a new style" not in steps


def test_an_open_request_gets_one_improvement_in_place() -> None:
    """ "Improve this" names no change: one improvement, made in place, said
    in a few sentences, and no options unless asked."""
    steps = _plain(_section("How to work"))
    opening = steps.split("1. **Find the layer.**")[0]
    assert '"improve this"' in opening and '"make it look better"' in opening
    assert "the ONE improvement that helps this data most" in opening
    assert "in place and in one call" in opening
    assert "in at most three short sentences what changed" in opening
    assert "at most one further idea" in opening
    assert "Never offer options unless the user asks for them" in opening


def test_the_answer_after_a_change_is_short() -> None:
    """At most three short sentences, about 50 words: the legend numbers are
    for judging the result, not for the answer. One example of about 40
    words."""
    steps = _plain(_section("How to work"))
    answer = steps.split("8. **Answer**")[1]
    assert "in at most three short sentences, about 50 words" in answer
    assert "at most one thing worth knowing" in answer
    assert (
        "The legend numbers are for you to judge the result, not for the answer"
        in answer
    )
    assert "no class limits, counts or percentages unless the user asks" in answer
    assert "a number only when it changes what the user should do" in answer
    [example] = re.findall(r'An open request, for example: "([^"]+)"', answer)
    assert 30 <= len(example.split()) <= 45
    assert not re.search(r"\d", example) and "undo" not in example


def test_the_variants_card_asks_which_style_the_map_shows() -> None:
    section = _plain(_section("A new style or variants"))
    assert '"Which style should the map show?"' in section
    assert "the other style stays in the style list" in section
    assert "you cannot delete a style" in section
    # A new style quotes the user's words that asked for it.
    assert "asked" in section and "word for word" in section
    [example] = [e.call for e in _style_calls() if "new_style" in e.call]
    assert example["new_style"]["asked"] in _plain(_section("Edit in place"))


def test_nothing_tells_it_to_create_a_style_or_variants_unasked() -> None:
    for name, text in _texts().items():
        flat = _plain(text)
        for phrase in UNASKED:
            assert phrase not in flat, (name, phrase)
    # Only the section for a request that asks for one holds examples that
    # create a style.
    asked = [
        json.loads(block)
        for *_, block in MARKED.findall(_section("A new style or variants"))
    ]
    creating = [e.call for e in _style_calls() if "new_style" in e.call]
    assert creating and all(call in asked for call in creating)
    for example in _style_calls():
        if example.source != "SKILL.md":
            assert StyleUpdateInput.model_validate(example.call).mode() == "edit"


def test_a_new_style_and_variants_are_for_a_request_that_asks_for_them() -> None:
    section = _plain(_section("A new style or variants"))
    assert section.startswith("Only when the user asked for one in words")
    assert "new_style" in section and "make_active" in section
    for start in ("current", "empty"):
        assert start in section, start
    assert "use_style:<style_id>" in section
    assert "one card" in section.lower()
    assert "at most two short sentences" in section
    assert (
        "When the user has picked a style that is not the active one, make it "
        "active with map_update: one set_layer operation with the layer's "
        "layer_project_id and the picked id as active_style_id." in section
    )
    assert (
        "tell them which style is active now and that the others are in the "
        "layer's style list" in section
    )
    # The tenth style: the refusal says how to ask which one to replace.
    assert "A layer takes 10 styles" in section and "refus" in section
    assert len(_section("A new style or variants").encode()) <= 2600


def test_the_house_examples_section_is_empty_and_says_what_goes_there() -> None:
    house = _section("House examples")
    assert not MARKED.findall(house) and "```" not in house
    assert 0 < len(house.split()) <= 60


def test_changing_the_map_says_which_operation_and_hides_before_it_removes() -> None:
    section = _plain(_section("Changing the map"))
    assert "map_update" in section and "map_propose_view" not in section
    for operation in (
        "set_layer",
        "move",
        "add_group",
        "rename_group",
        "set_group",
        "remove_group",
        "filter",
        "set_basemap",
        "set_scene",
        "set_view",
        "remove_layer",
    ):
        assert operation in section, operation
    assert "One call takes several operations" in section
    # Out of sight is hidden; removed is only what the user calls removed.
    assert "Hide, do not remove" in section
    assert "visible false" in section
    assert "Remove only when the user says remove or delete" in section
    # The model simply calls the removal: without the user's pick the tool
    # changes nothing and answers what to ask, with the card option's value.
    assert "simply call remove_layer" in section
    assert "changes nothing and answers confirm" in section
    assert "refused" not in section and "ask_user" in section
    assert "send the call again after the pick" in section
    assert "remove_layer:<layer_project_id>" in section
    assert removal_value(12) == "remove_layer:12"
    assert "does not come back with the dock's undo button" in section
    # Ids come from the layer list.
    assert "project_get_layers" in section
    assert "map.basemaps" in section
    assert '"new:<index>"' in section


def test_filters_are_changed_row_by_row_and_read_again() -> None:
    section = _plain(_section("Changing the map"))
    assert "one filter operation per layer" in section
    for word in ("add", "replace", "remove", "set_match", "clear"):
        assert word in section, word
    assert "read project_get_layers again before the next change" in section
    # A custom row is left or removed, never rewritten in part.
    assert 'reads "custom"' in section
    assert "leave it, or remove it when the user asks" in section
    for key in ("count_before", "count_after"):
        assert key in section, key
    description = " ".join(MAP_UPDATE.description.split())
    assert "read the layers again before the next one" in description


def test_areas_come_from_regions_layers_or_the_view_never_coordinates() -> None:
    section = _plain(_section("Changing the map"))
    for word in ("area", "rows", "regions", "features_of", "view", "outside", "add"):
        assert word in section, word
    assert "set_area" not in section and "clear_area" not in section
    assert "catalog_find_region first" in section
    assert "Never guess coordinates" in section
    assert "a shape is the user's to draw" in section
    assert '"area": "clear" removes the area, the row clear keeps it' in section
    areas = [
        operation["area"]
        for example in _calls("map_update")
        for operation in example.call["operations"]
        if operation["op"] == "filter" and isinstance(operation.get("area"), dict)
    ]
    assert {key for area in areas for key in area} >= {
        "regions",
        "features_of",
        "view",
    }
    # One example sets rows and an area in one filter operation.
    assert any(
        operation.get("rows") and operation.get("area")
        for example in _calls("map_update")
        for operation in example.call["operations"]
        if operation["op"] == "filter"
    )


def test_the_view_is_the_users_own_and_never_a_substitute() -> None:
    section = _plain(_section("Changing the map"))
    assert "fit_layer_project_id" in section
    assert "The view is the user's own" in section
    assert "the dock's undo button does not take it back" in section
    assert "the page shows a way back" in section
    assert (
        "Change it when the user asks to go somewhere or to see something, or "
        "when your change would not show otherwise" in section
    )
    assert "Never move the view in place of something you could not do" in section
    # Heights are one such change: the skill tilts the map itself.
    heights = _plain(_section("Heights and 3D"))
    assert "You cannot tilt it" not in heights
    assert "map_update" in heights and "set_view" in heights


def test_what_it_cannot_do_is_one_list_without_a_card() -> None:
    section = _section("What you cannot do")
    flat = _plain(section)
    assert "No card" in flat and "how the user can do it" in flat
    entries = re.findall(r"^- ", section, re.M)
    assert 4 <= len(entries) <= 6
    # A filter's area is set with map_update; only drawing stays the user's.
    assert "Filter a layer to a place" not in flat
    for word in ("Filter tab", "Area"):
        assert word in flat, word
    for cannot in (
        "Switch a filter row or an area on or off",
        "Draw a shape",
        "dataset's default style",
        "Upload data",
        "edit features",
    ):
        assert cannot in flat, cannot
    assert not MARKED.findall(section)
    assert len(section.encode()) <= 1000


def test_it_tells_a_look_from_an_analysis_with_examples() -> None:
    looks = _skill().files["looks-and-analyses.md"]
    which = looks.split("## Which one a request means\n")[1].split("\n## ")[0]
    # Three requests that are a look and three that are an analysis.
    assert len(re.findall(r'^  - "', which, re.M)) == 6
    flat = _plain(which)
    assert "The test." in flat
    assert "Never start a workflow for a look, and never ask a card about it" in flat
    assert "an edit in place" in flat


def test_a_look_is_a_render_mode_and_an_analysis_a_workflow() -> None:
    looks = _plain(_skill().files["looks-and-analyses.md"])
    assert "render" in looks and "build-a-workflow" in looks
    assert "only after its run has finished" in looks
    assert "workflow_run" in looks
    examples = [e for e in _style_calls() if e.source == "looks-and-analyses.md"]
    types = {(e.call["operations"][0].get("value") or {}).get("type") for e in examples}
    assert {"heatmap", "cluster", "h3"} <= types


def test_rasters_have_a_worked_band_formula() -> None:
    examples = [e for e in _style_calls() if e.source == "rasters.md"]
    assert {e.kind for e in examples} == {"raster"}
    renders = [_result(e).get("render") or {} for e in examples]
    assert {"image", "continuous", "categorical", "hillshade"} <= {
        r.get("type") for r in renders
    }
    formulas = [
        r["band"]["expression"] for r in renders if isinstance(r.get("band"), dict)
    ]
    assert formulas and all(re.fullmatch(r"[b0-9 ()+*/.-]+", f) for f in formulas)


def test_blend_tints_the_basemap_and_names_what_draws_without_it() -> None:
    """Multiply tints the basemap below its labels; polygons, lines, flat
    hexagons and images mix, everything else draws normally. On a raster only
    an image or a map service mixes: the colors of values and a hillshade
    draw without a blend."""
    table = _plain(_section("Which form for which data"))
    assert "/blend multiply, the layer below the basemap's labels (set_layer)" in table
    assert (
        "blend mixes polygons, lines, flat hexagons and images; everything else "
        "draws normally (blend_not_drawn)." in table
    )
    rasters = _plain(_texts()["rasters.md"])
    assert "blend beside render mixes an image or a map service" in rasters
    assert (
        "A color range, classes, categories, an image in its file's color table "
        "and a hillshade draw without it" in rasters
    )


#: The parts a class record can switch on for its features.
_CLASS_PARTS = ("fill", "outline", "line", "casing", "marker", "label")


def _records(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Every class record of a vector style: classes, other and no_data."""
    found: list[dict[str, Any]] = []
    for item in document.get("classify") or []:
        found += [r for r in item.get("classes") or [] if isinstance(r, dict)]
        found += [
            item[k] for k in ("other", "no_data") if isinstance(item.get(k), dict)
        ]
    return found


def test_a_part_or_an_icon_the_classes_set_is_set_on_the_base_too() -> None:
    """Features in no class draw the base: an icon or a part only the classes
    set leaves "Other" and new values without it. Every example sets it on
    the base first, and the classified icon example gives every class and
    the base an icon."""
    icons = _plain(_section("Icons and emoji"))
    assert "the base marker a neutral one" in icons
    assert '"Other" and new values draw' in icons
    # The base gets the part as an object, never false.
    assert "set on the base first" not in icons
    assert "is set on the base too" in icons
    assert "the base marker keeps shape circle" not in icons
    for example in _style_calls():
        document = _result(example)
        symbol = document.get("symbol") or {}
        for record in _records(document):
            for part in _CLASS_PARTS:
                if isinstance(record.get(part), dict):
                    assert isinstance(symbol.get(part), dict), (example.call, part)
            marker = record.get("marker")
            if isinstance(marker, dict) and "icon" in marker:
                assert symbol["marker"].get("icon"), example.call
    [classified] = [
        e
        for e in _style_calls()
        if e.state == "classified"
        and any("/marker/icon" in o["path"] for o in e.call["operations"])
    ]
    document = _result(classified)
    assert document["symbol"]["marker"]["icon"] == "goat:marker"
    records = document["classify"][0]["classes"]
    assert all(record["marker"].get("icon") for record in records)


def _at_zoom(stops: list[list[Any]], zoom: float) -> float:
    """A linear value by zoom at ``zoom``."""
    (z0, v0), (_, v1) = stops[0], stops[-1]
    if zoom <= z0:
        return float(v0)
    for (a, va), (b, vb) in zip(stops, stops[1:]):
        if a <= zoom <= b:
            return float(va + (vb - va) * (zoom - a) / (b - a))
    return float(v1)


def test_an_icon_shows_from_the_zoom_where_its_marker_is_large_enough() -> None:
    """An icon needs a marker of about 16 px. A marker that grows with the
    zoom switches from a dot to its icon at the zoom where it reaches that
    size, by a step zoom form."""
    icons = _plain(_section("Icons and emoji"))
    assert "16 px or more" in icons
    assert '"interpolate": "step"' in icons
    markers = [(_result(e).get("symbol") or {}).get("marker") for e in _style_calls()]
    zoomed = [
        m for m in markers if isinstance(m, dict) and isinstance(m.get("icon"), dict)
    ]
    assert zoomed and all(z["icon"]["interpolate"] == "step" for z in zoomed)
    for marker in zoomed:
        (low, dot), (switch, icon) = marker["icon"]["zoom"]
        size = marker["size"]["zoom"]
        assert dot == "goat:circle-solid" and icon != dot
        assert _at_zoom(size, low) < 16 <= _at_zoom(size, switch)
        assert _at_zoom(size, switch - 1) < 16


#: The keys of a document that hold parts rather than name them.
_RECORDS = {"symbol", "classify", "classes", "other", "no_data", "rules"}


def _auto_keys(node: Any, path: tuple[str, ...] = ()) -> list[str]:
    """The keys of a style document that hold "auto", named as goatlib's color
    key table names them: part keys without the record around them, lists
    without their brackets, the cluster symbol's under ``cluster.symbol``."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            found += _auto_keys(value, (*path, key))
    elif isinstance(node, list):
        for item in node:
            found += _auto_keys(item, path)
    elif node == "auto" and path and path[-1] in ("color", "icon_color"):
        if path[:2] == ("render", "symbol"):
            found.append(".".join(("cluster", *path[1:])))
        else:
            found.append(".".join(p for p in path if p not in _RECORDS))
    return found


def test_auto_none_and_transparency_replace_hand_picked_colors() -> None:
    """The colors GOAT derives are written as "auto" where the user names
    none, a part or class not drawn is a None color that keeps its hue, and a
    color's own transparency is told apart from a part's opacity. The advice
    "auto" replaces (white labels in a dark halo, a dark grey outline, a white
    icon) is gone, and the examples write what the rules say."""
    from goatlib.style.colors import COLOR_KEYS

    text = _plain(_skill().instructions)
    for hand_picked in ("#1f2933", "#555555"):
        assert hand_picked not in text, hand_picked
    assert "(white)" not in _plain(_section("Icons and emoji"))
    palettes = _plain(_section("Palettes"))
    [auto] = [line for line in palettes.split("- ") if line.startswith('Write "auto"')]
    for key in ("outline", "casing", "color", "halo", "icon_color", "cluster"):
        assert key in auto, key
    # Written on the symbol, not left out (an absent outline color is white)
    # and not on classes the server computes; a darker shade on any basemap.
    assert "names none" in auto and "on the symbol" in auto
    # The user's words tie to the value, written as the whole outline when it
    # is off, never as darker colors computed per class.
    assert "darker shade of its own (or each class's) color" in auto
    assert "never darker colors per class" in auto
    assert "whole" not in auto and "when it is false" not in auto
    # A part's keys are set one by one by path, never after a reset of the part,
    # and the outline example does so.
    writing = _plain(_section("Writing the change"))
    assert "one set per key" in writing and "/symbol/outline/color" in writing
    assert "never reset the part first" in writing
    assert "turns it on" in writing and "set the part whole" not in writing
    [outline] = [e for e in _style_calls() if "/symbol/outline" in json.dumps(e.call)]
    paths = [o["path"] for o in outline.call["operations"]]
    assert paths == ["/symbol/outline/color", "/symbol/outline/width"]
    assert "on any basemap" in auto
    [against] = [line for line in palettes.split("- ") if "Against the basemap" in line]
    assert "a fixed outline light" in against and "light outlines" not in against
    assert "white" not in against
    assert "palette_kind_mismatch" in palettes
    forms = _plain(_section("Which form for which data"))
    assert "keeps its hue" in forms and "00" in forms
    assert '"auto" outline keeps the layer\'s color' in forms
    assert "last two hex digits" in forms and "multiply with opacity" in forms
    # An opacity set already multiplies in; None hides a color, not a class.
    assert "(at 0.8: 40 %)" in forms and "palette color" in forms
    assert "a part's or class's color not drawn" in forms
    # Every "auto" an example writes sits on a key that accepts it.
    accepted = {k for k, rule in COLOR_KEYS.items() if rule.get("accepted")}
    written: set[str] = set()
    for example in _style_calls():
        keys = _auto_keys(_result(example))
        assert set(keys) <= accepted, (example.call, set(keys) - accepted)
        written |= set(keys)
    assert {
        "outline.color",
        "casing.color",
        "label.color",
        "label.halo.color",
        "marker.icon_color",
        "cluster.symbol.label.color",
    } <= written
    [label] = [e for e in _style_calls() if "/symbol/label" in json.dumps(e.call)]
    value = label.call["operations"][0]["value"]
    assert value["color"] == "auto" and value["halo"]["color"] == "auto"


def _popup_calls() -> list[Example]:
    return [e for e in _style_calls() if e.source == "popups.md"]


def test_popups_md_is_loaded_for_more_than_a_list_of_fields() -> None:
    popups = _plain(_section("Popups"))
    assert (
        "load popups.md before you write a popup that is more than a list of fields"
        in popups.lower()
    )
    assert "field_list" in popups and "attributes" in popups
    # The rest is in the reference file.
    assert "click_and_hover" not in popups
    assert len((SKILLS_DIR / NAME / "popups.md").read_bytes()) <= 6000


def test_popups_md_teaches_the_blocks_the_html_mode_and_the_fields_to_pick() -> None:
    text = _plain(_skill().files["popups.md"])
    for block in ("field_list", "text", "image", "button", "badge", "divider"):
        assert block in text, block
    for key in ("label", "type", "format", "trigger", "layout", "header"):
        assert key in text, key
    for liquid in ("{{ name }}", "{% if", "{% for", "upcase"):
        assert liquid in text, liquid
    assert "escaped" in text and "sanitized" in text
    for name in (
        "attr-table",
        "attr-field",
        "attr-value",
        "attr-list",
        "badge",
        "btn-link",
        "btn-outlined",
        "btn-filled",
    ):
        assert name in text, name
    assert "does not convert back" in text
    assert "Blocks by default" in text
    assert "Never name a field you have not read" in text
    assert "at most eight" in text
    for kind in ("A URL as a button", "an image URL as an image block", "ids"):
        assert kind in text, kind


def test_the_popup_examples_are_a_block_popup_an_html_popup_and_switching_off() -> None:
    """Each validates against fields the examples' layers have (the style
    test above), and together they show the forms the file teaches."""
    popups = [
        o["value"]
        for e in _popup_calls()
        for o in e.call["operations"]
        if o["path"] == "/popup"
    ]
    assert False in popups
    blocks = [p for p in popups if isinstance(p, dict) and p.get("blocks")]
    html = [p for p in popups if isinstance(p, dict) and p.get("mode") == "html"]
    assert blocks and html
    types = {b["type"] for p in blocks for b in p["blocks"]}
    assert {"field_list", "text", "button"} <= types
    assert any("{{" in b.get("html", "") for p in blocks for b in p["blocks"])
    template = html[0]["html"]
    assert "<h3>" in template and "{% if" in template and "<img" in template


# -- the prompt ---------------------------------------------------------------------


def test_the_prompt_says_what_changes_and_that_it_sees_state_not_a_picture() -> None:
    flat = " ".join(INSTRUCTIONS.split())
    assert (
        "You see the map's state (layers, styles, filters, basemap, view), not its "
        "picture. Describe data from tool results, not from what the map might "
        "look like." in flat
    )
    assert "You cannot see the map" not in flat
    [rule] = [bullet for bullet in flat.split(" - ") if "style_update" in bullet]
    assert rule.startswith("You change nothing that exists in GOAT, except")
    assert "workflow_update changes a workflow of the open project" in rule
    assert (
        "On the Map page, style_update also changes a layer's style or adds a "
        "named style to it, which the user can take back with the dock's undo "
        "button as well." in rule
    )
    # The map itself: what it shows goes back the same way, a view does not.
    assert (
        "On the Map page, map_update also changes what the map shows (which "
        "layers are shown, their order, groups, names and filters, the "
        "basemap, the 3D scene and the view): the user can take that back with "
        "the dock's undo button too, except a view change, which is the user's "
        "own and is not undone that way." in rule
    )
    # A removal asks first and cannot be taken back; hiding comes first.
    assert (
        "map_update removes a layer from the project only after the user "
        "picked that in your card, because a removed layer cannot be taken "
        "back; when the user only wants a layer out of sight, hide it instead." in rule
    )
    assert set(TOOL_NAME.findall(rule)) <= set(BY_WIRE_NAME)
    # No English label of the button.
    assert not re.search(r"\bUndo\b", INSTRUCTIONS)


def test_the_prompt_asks_in_two_sentences_and_never_after_a_full_answer() -> None:
    """A card is for a decision only the user can make. The text before it
    is short, a request is never answered in full and asked about in the
    same answer, and what the assistant cannot do is said, not asked."""
    bullets = [" ".join(bullet.split()) for bullet in INSTRUCTIONS.split("\n- ")]
    [rule] = [bullet for bullet in bullets if "ask_user" in bullet]
    assert (
        "Before the card, write at most two short sentences that say what you "
        "need to know; the card shows the questions and options, so do not "
        "repeat them. Then end your answer." in rule
    )
    assert "say in one sentence what you need to know" not in rule
    assert "Never answer the request in full and show a card in the same answer" in rule
    assert (
        "Show no card when every option leads to the same result, or when you "
        "cannot do the thing anyway: say that you cannot, and how the user can "
        "do it." in rule
    )
    assert "something only they can decide" in rule
    # A finished run's numbers still come before its card.
    assert "numbers first" in rule
    assert "a real decision the question leaves open" in rule


def test_a_refusal_is_short_and_reads_nothing_it_does_not_need() -> None:
    bullets = [" ".join(bullet.split()) for bullet in INSTRUCTIONS.split("\n- ")]
    [rule] = [bullet for bullet in bullets if "ask_user" in bullet]
    refusal = rule.split("say that you cannot, and how the user can do it.")[1]
    assert "one or two sentences with the one next step the user can take" in refusal
    for phrase in (
        "no how-to",
        "nothing about earlier turns the request does not ask about",
        "no look-ups the request does not need",
    ):
        assert phrase in refusal, phrase


def test_the_map_pages_note_carries_the_three_rules_without_the_skill() -> None:
    from assistant.prompt import _MAP_STYLES

    flat = " ".join(_MAP_STYLES.split())
    rules = flat.split("need no skill.")[1]
    assert "edit the layer's active style in place" in rules
    assert "a new style or options only when the user asks for one in words" in rules
    assert (
        "after a change, answer in at most three short sentences, about 50 words "
        "in all: what changed and at most one thing worth knowing, with no class "
        "limits, counts or percentages unless the user asks, and no card unless "
        "the user asked for options" in rules
    )
    # Nothing to announce before the first tool call.
    assert "No announcement before the tools." in flat
    assert "—" not in flat and "–" not in flat


def test_a_removal_calls_the_tool_first_without_the_skill() -> None:
    """A removal loads no skill: the page note and the tool's description
    say to call map_update first, which answers what to ask."""
    from assistant.prompt import _MAP_STYLES

    flat = " ".join(_MAP_STYLES.split())
    assert (
        "To remove a layer, call map_update with remove_layer first: it changes "
        "nothing and answers what to ask; never ask about a removal before it."
    ) in flat
    description = " ".join(MAP_UPDATE.description.split())
    assert (
        "remove_layer (call it first, before any card: it is applied only after "
        "the user's pick in a card, and a call without it changes nothing and "
        "answers confirm, which says what to ask)"
    ) in description


def test_style_updates_description_edits_in_place_always() -> None:
    description = " ".join(UPDATE_STYLE.description.split())
    assert (
        "Always edit in place (operations alone), whatever the size of the "
        "change: the dock's undo button is the way back." in description
    )
    assert (
        "Create a named style, or two or three variants, only when the user "
        "asks for one in words" in description
    )
    for phrase in ("replaces what the layer shows", "a variant to compare"):
        assert phrase not in description, phrase
    properties = StyleUpdateInput.model_json_schema()["properties"]
    assert "Only when the user asks for" in properties["new_style"]["description"]
    active = properties["make_active"]["description"]
    assert "a new or replaced style is drawn" in active


def test_the_map_pages_note_names_the_skill_to_load_before_styling() -> None:
    from assistant.prompt import _MAP_STYLES

    map_page = parse_context({"surface": "project.map", "project_id": str(PROJECT)})
    note = render_note(map_page, None, "en")
    [line] = [line for line in note.splitlines() if line == _MAP_STYLES]
    assert NAME in line and "skills_load" in line and "style_update" in line
    assert "map_update" in line and "before" in line
    # The skill is for styling and for filters; the plain map changes need
    # none, the tool's description is enough for them.
    assert "before you style a layer, change a style or change a layer's filter" in line
    assert "need no skill" in line
    for plain in ("hiding", "showing", "renaming", "reordering", "basemap", "view"):
        assert plain in line, plain
    # What a model needs for those without the skill is in the description.
    description = " ".join(MAP_UPDATE.description.split())
    assert "hide it (visible false) rather than remove it" in description
    assert "remove only when the user says remove or delete" in description
    assert "only after the user's pick in a card" in description
    assert "—" not in line and "–" not in line and "Undo" not in line
    named = set(TOOL_NAME.findall(line))
    assert named and named <= set(BY_WIRE_NAME)
    for raw in (
        None,
        {"surface": "catalog"},
        {"surface": "project.workflows", "project_id": str(PROJECT)},
        {"surface": "project.layouts", "project_id": str(PROJECT)},
    ):
        assert _MAP_STYLES not in render_note(parse_context(raw), None, "en")
