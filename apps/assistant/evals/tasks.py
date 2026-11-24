"""Eval tasks and the checks that grade them.

Tasks live in one JSON Lines file per suite, one task per line, so a diff shows
one task per changed line. Bump ``EVAL_SET_VERSION`` whenever a task or a check changes
meaning: a model is "tested" for one version of the set.
"""

from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from assistant.surfaces import Locale

EVAL_SET_VERSION = 29

HERE = Path(__file__).resolve().parent
Suite = Literal["catalog", "project", "workflow", "map"]
TASK_FILES: dict[Suite, Path] = {
    "catalog": HERE / "catalog_tasks.jsonl",
    "project": HERE / "project_tasks.jsonl",
    "workflow": HERE / "workflow_tasks.jsonl",
    "map": HERE / "map_tasks.jsonl",
}


class _Check(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Oracle(_Check):
    """An expected value computed from the fixed backends at grading time."""

    op: Literal[
        "catalog_count", "count", "sum", "min", "max", "mean", "distinct", "top"
    ]
    #: Fixture project layer (all but catalog_count).
    layer: str | None = None
    field: str | None = None
    #: CQL2-JSON over the layer's features.
    filter: dict[str, Any] | None = None
    #: catalog_count: query parameters of GET /stac/collections.
    params: dict[str, Any] = Field(default_factory=dict)


class RecordsCheck(_Check):
    """The run's catalog tool results contain these records (an item or its dataset)."""

    kind: Literal["records"]
    include: list[str] = Field(min_length=1)
    exclude: list[str] = Field(default_factory=list)


class ShownCheck(_Check):
    """The datasets the answer showed as cards (``catalog_show_records``): these
    and not those (an item or its dataset)."""

    kind: Literal["shown"]
    include: list[str] = Field(min_length=1)
    exclude: list[str] = Field(default_factory=list)


class ShownItemsCheck(_Check):
    """The user's own items the answer showed as cards (``core_show_items``),
    by name: these and not those."""

    kind: Literal["shown_items"]
    include: list[str] = Field(min_length=1)
    exclude: list[str] = Field(default_factory=list)


class FiltersCheck(_Check):
    """The last catalog.filters proposal sets these filters."""

    kind: Literal["filters"]
    facets: dict[str, list[str]] = Field(default_factory=dict)
    #: The proposal's search text contains one of these (case-insensitive).
    q_any: list[str] = Field(default_factory=list)
    nuts: list[str] = Field(default_factory=list)


class NumberCheck(_Check):
    """The answer states this number (read in English and German notation)."""

    kind: Literal["number"]
    expected: float | Oracle
    #: Relative tolerance; 0 means exact.
    tolerance: float = 0.0


class NotStatedCheck(_Check):
    """The answer does not state this number: a value the model may not have
    read, such as one of a locked layer."""

    kind: Literal["not_stated"]
    value: float | Oracle
    #: Relative tolerance: a number within it of the value counts as stating it
    #: ("about 46.000" leaks 46116); 0 means exact.
    tolerance: float = 0.05


class TextCheck(_Check):
    """The answer names this value (case-insensitive)."""

    kind: Literal["text"]
    expected: str | Oracle


class AnswerCheck(_Check):
    """The answer names one of ``any_of``, all of ``all_of`` and none of
    ``none_of`` (whole words, case-insensitive), and is at most ``max_chars``
    characters long."""

    kind: Literal["answer"]
    any_of: list[str] = Field(default_factory=list)
    all_of: list[str] = Field(default_factory=list)
    none_of: list[str] = Field(default_factory=list)
    #: When set, the names of the user's own items the run showed as cards
    #: (``core_show_items``, read as the shown_items check reads them) count as
    #: part of the answer, for all three lists: the prompt has the model show
    #: those items as cards and not list them again in the text.
    with_shown_items: bool = False
    #: The longest answer that passes, in characters, as the dock shows it
    #: (the text before tool calls included).
    max_chars: int | None = Field(default=None, ge=1)


class ToolsCheck(_Check):
    """Tools (wire names) the run called, or must not have called."""

    kind: Literal["tools"]
    #: Each with at least one call that succeeded.
    called: list[str] = Field(default_factory=list)
    #: Each called at least once, also when the call failed (a refusal).
    tried: list[str] = Field(default_factory=list)
    #: Not called at all, not even in a call that failed.
    not_called: list[str] = Field(default_factory=list)
    #: The most calls a tool may get, e.g. one try of a write the user may not
    #: make. A key joining tools with "+" bounds their calls together.
    at_most: dict[str, int] = Field(default_factory=dict)
    #: Each with a call that succeeded, the first such call of each after
    #: that of the one before it.
    in_order: list[str] = Field(default_factory=list)


class DocsCheck(_Check):
    """The run read one of these pages of GOAT's user docs with docs_read (a
    call that succeeded), by page id: an answer about GOAT's interface comes
    from the page that describes it."""

    kind: Literal["docs"]
    any_of: list[str] = Field(min_length=1)


class ViewCheck(_Check):
    """The view the answer's map_update calls left the page with (their
    results' ``view``, applied in order): it frames this layer (the last
    ``set_view`` that moves the map fits it), contains this point, is in this
    mode, tilted at least this far."""

    kind: Literal["view"]
    layer_project_id: int | None = None
    contains: tuple[float, float] | None = None
    mode: Literal["2d", "3d"] | None = None
    min_pitch: float | None = None


class PathRule(_Check):
    """The value at a JSON pointer into a style document (a classification
    also by its field: ``/classify/density/...``) or the scene. ``exists``
    counts a part switched off (``false``) or null as absent."""

    path: str
    equals: Any = None
    one_of: list[Any] | None = None
    exists: bool | None = None
    #: A number smaller than this.
    below: float | None = None
    #: A number larger than this.
    above: float | None = None
    #: A text this regular expression finds (``re.search``).
    pattern: str | None = None

    @model_validator(mode="after")
    def _says_what_it_expects(self) -> "PathRule":
        rules = (self.one_of, self.exists, self.below, self.above, self.pattern)
        if "equals" not in self.model_fields_set and all(r is None for r in rules):
            raise ValueError(f"{self.path}: the rule expects nothing")
        return self


class ClassRule(_Check):
    """The classification of ``field`` in the checked style (a raster's
    ``/render/classify``, whatever the field): its method, number of
    classes as stored, the kind of its palette and the property it sets
    (``target``, by default the geometry's main color). The method
    ``by_attribute`` also accepts a value by attribute of the field at the
    target (spec 4.3), which has no classes."""

    field: str
    target: str | None = None
    methods: list[str] = Field(min_length=1)
    min_classes: int = 2
    max_classes: int = 12
    palette_kind: Literal["sequential", "diverging", "qualitative"] | None = None


class LegendRule(_Check):
    """Shares of the classification's classes over the layer's features
    under its saved filter."""

    #: No class holds more than this share.
    max_share: float | None = None
    #: The share in no class.
    max_other: float | None = None


class StyleCheck(_Check):
    """The style the layer draws after the answer, as core stored it: it
    differs from the style active before (computed stamps aside), has no
    error, and meets every condition. ``where`` says which style that is:
    "same", the style active before, edited in place, and no style made for
    the layer; "new", a style made in the answer; "any", either of them.
    For a layer the answer added (a run's result), the style before is the
    one the layer arrived with."""

    kind: Literal["style"]
    layer_project_id: int
    where: Literal["same", "new", "any"]
    #: Styles made for the layer in the answer, at least.
    variants: int | None = None
    #: The style the layer draws after the answer is this one of the styles
    #: made for it in the answer, counted from 1 in the order they were made.
    active_variant: int | None = Field(default=None, ge=1)
    classification: ClassRule | None = None
    paths: list[PathRule] = Field(default_factory=list)
    #: At least one of these holds.
    paths_any: list[PathRule] = Field(default_factory=list)
    legend: LegendRule | None = None
    #: Pointers whose value equals the one in the style active before.
    unchanged: list[str] = Field(default_factory=list)
    #: The fields the popup names (attributes, a block's field, ``{{ }}``).
    popup_fields: list[str] = Field(default_factory=list)
    #: The eval user's Undo (the task's ``undo``) brought back the layer's
    #: styles and active style as they were before.
    undone: bool = False


class AreaRule(_Check):
    """A layer filter's area, switched on, as its notes describe it: exactly
    these region ids, features of exactly these layers (layer_project_id),
    the map view or not, drawn shapes or not, inside or outside."""

    regions: list[str] = Field(default_factory=list)
    layers: list[int] = Field(default_factory=list)
    #: The features picked from those layers together, when given.
    features: int | None = None
    view: bool = False
    shapes: bool = False
    outside: bool = False


class LayerRule(_Check):
    """A layer of the map project after the answer."""

    #: As drawn: the layer and every group around it shown.
    visible: bool | None = None
    position: str | None = None
    name: str | None = None
    #: The name of the group it is in, "" for the top level.
    group: str | None = None
    #: The name of its active style.
    active_style: str | None = None
    #: Features its stored filter keeps, counted on the fixture's table.
    filter_count: int | None = None
    #: Condition rows of the stored filter (a drawn area and the switched-off
    #: rows aside).
    filter_rows: int | None = None
    #: Switched-off rows the filter keeps in its notes (``ui.off``).
    off_rows: int | None = None
    #: The drawn area and its notes are as they were.
    area_kept: bool | None = None
    #: The filter's area ("none": the filter has none).
    area: AreaRule | Literal["none"] | None = None
    #: The filter's rows (switched-off ones included) and match are as they
    #: were.
    rows_kept: bool | None = None


class MapCheck(_Check):
    """The map project as core held it after the answer."""

    kind: Literal["map"]
    layers: dict[int, LayerRule] = Field(default_factory=dict)
    #: (a, b): a is drawn above b.
    above: list[tuple[int, int]] = Field(default_factory=list)
    basemap: str | None = None
    scene: list[PathRule] = Field(default_factory=list)
    removed: list[int] = Field(default_factory=list)
    kept: list[int] = Field(default_factory=list)
    #: The state after equals the state before, computed stamps aside.
    writes: Literal["none"] | None = None
    #: The eval user's Undo brought the whole map project back as it was.
    undone: bool = False
    #: Graded on the state when the card was shown, before the eval user
    #: answered it (a task with ``answer_card``).
    before_answer: bool = False


class NotSentCheck(_Check):
    """No request to geoapi or processes names this layer (a locked one)."""

    kind: Literal["not_sent"]
    layer_id: str


class LanguageCheck(_Check):
    """The answer is in this language: the prompt's, whatever language the data
    or the earlier turns are in."""

    kind: Literal["language"]
    expected: Literal["en", "de"]


class AskedCheck(_Check):
    """The run showed an ask_user card: at least ``questions_min`` questions
    in its first card, and these option values offered (all of ``offers``,
    one of ``offers_any``)."""

    kind: Literal["asked"]
    questions_min: int = Field(default=1, ge=1, le=4)
    offers: list[str] = Field(default_factory=list)
    offers_any: list[str] = Field(default_factory=list)


class WorkflowCreatedCheck(_Check):
    """The run created a workflow that core saved (with ``via`` "template"
    from a template, with "draft" from a draft), and one such workflow meets
    every condition: only the allowed issues are left open, its config holds
    the tools (all of ``tools``, one of ``tools_any``), it uses the
    ``layers``, and it has a dataset step on one of ``area_layers``, each
    such step limited to an area. A template sends no config, so with
    "template" only the open issues and ``layers`` (its bindings) can be
    checked."""

    kind: Literal["workflow_created"]
    via: Literal["draft", "template"] | None = None
    tools: list[str] = Field(default_factory=list)
    tools_any: list[str] = Field(default_factory=list)
    open_allowed: list[str] = Field(default_factory=lambda: ["layer_not_chosen"])
    open_required: list[str] = Field(default_factory=list)
    #: Project layers (layer_project_id) the workflow reads: each one a
    #: dataset step's layer, or bound to an input of the template.
    layers: list[int] = Field(default_factory=list)
    area_layers: list[int] = Field(default_factory=list)


class WorkflowUpdatedCheck(_Check):
    """The run changed the workflow ``workflow_id`` with workflow_update, and
    the change core saved meets every condition: each step of a tool in
    ``settings`` has those settings, the workflow has ``notes_added`` more
    notes than before, and the steps named in ``kept`` keep their names.
    With ``undone``, the Undo the eval user pressed (the task's ``undo``)
    wrote back the workflow as it was."""

    kind: Literal["workflow_updated"]
    workflow_id: str
    settings: dict[str, dict[str, Any]] = Field(default_factory=dict)
    notes_added: int = 0
    kept: list[str] = Field(default_factory=list)
    undone: bool = False


class JudgeCheck(_Check):
    """Free text, graded by the LLM judge against the rubric (evals.judge)."""

    kind: Literal["judge"]
    rubric: str = Field(min_length=10)


Check = Annotated[
    RecordsCheck
    | ShownCheck
    | ShownItemsCheck
    | FiltersCheck
    | NumberCheck
    | NotStatedCheck
    | TextCheck
    | AnswerCheck
    | ToolsCheck
    | DocsCheck
    | ViewCheck
    | NotSentCheck
    | LanguageCheck
    | AskedCheck
    | WorkflowCreatedCheck
    | WorkflowUpdatedCheck
    | StyleCheck
    | MapCheck
    | JudgeCheck,
    Field(discriminator="kind"),
]


class Turn(BaseModel):
    """An earlier exchange of the conversation: the user's text and the answer."""

    model_config = ConfigDict(extra="forbid")

    user: str = Field(min_length=1)
    assistant: str = Field(min_length=1)


class EvalTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^(cat|proj|wf|map)-\d{2}$")
    suite: Suite
    #: The page context as the dock sends it (plan 3's wire format); its
    #: surface decides which tools the agent gets.
    context: dict[str, Any]
    locale: Locale = "en"
    #: Earlier turns, on the same page, before ``prompt``: a follow-up's answer
    #: can drift into the language or the claims of the conversation so far.
    history: list[Turn] = Field(default_factory=list)
    prompt: str = Field(min_length=3)
    checks: list[Check] = Field(min_length=1)
    #: A model that fails a critical task is not listed as tested, whatever its score.
    critical: bool = False
    #: The eval user answers a card the run shows: every question with its
    #: first option, the recommended one when there is one; then the next
    #: turn runs with that answer, as the dock sends it.
    answer_card: bool = False
    #: With ``answer_card``: in every question that offers it, the eval user
    #: picks the option with this value (``remove_layer:39``) instead.
    answer_value: str | None = None
    #: The eval user presses Undo under the last answer once it ended, as
    #: the dock does (``assistant.undo``); the transcript says how it went.
    undo: bool = False

    @model_validator(mode="after")
    def _surface_fits_suite(self) -> "EvalTask":
        surface = str(self.context.get("surface", ""))
        allowed = {
            "catalog": surface in ("catalog", "none"),
            "project": surface.startswith("project.") or surface == "none",
            "workflow": surface in ("project.map", "project.workflows"),
            "map": surface == "project.map",
        }[self.suite]
        if not allowed:
            raise ValueError(
                f"surface {surface!r} does not belong to the {self.suite} suite"
            )
        if self.answer_value is not None and not self.answer_card:
            raise ValueError("answer_value needs answer_card")
        return self


def load_tasks(suite: Suite | None = None) -> list[EvalTask]:
    tasks: list[EvalTask] = []
    for name, path in TASK_FILES.items():
        if suite is not None and name != suite:
            continue
        for number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            task = EvalTask.model_validate_json(line)
            if task.suite != name:
                raise ValueError(
                    f"{path.name}:{number}: a {task.suite} task in the {name} file"
                )
            tasks.append(task)
    ids = [task.id for task in tasks]
    duplicates = sorted({task_id for task_id in ids if ids.count(task_id) > 1})
    if duplicates:
        raise ValueError(f"duplicate task ids: {duplicates}")
    return tasks
