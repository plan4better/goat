"""Eval tasks and the checks that grade them.

Tasks live in one JSON Lines file per suite, one task per line, so a diff shows
one task per changed line. Bump ``EVAL_SET_VERSION`` whenever a task or a check changes
meaning: a model is "tested" for one version of the set.
"""

from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from assistant.surfaces import Locale

EVAL_SET_VERSION = 17

HERE = Path(__file__).resolve().parent
Suite = Literal["catalog", "project", "workflow"]
TASK_FILES: dict[Suite, Path] = {
    "catalog": HERE / "catalog_tasks.jsonl",
    "project": HERE / "project_tasks.jsonl",
    "workflow": HERE / "workflow_tasks.jsonl",
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
    """The answer does not state this number: a value the data policy withholds."""

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
    ``none_of`` (whole words, case-insensitive)."""

    kind: Literal["answer"]
    any_of: list[str] = Field(default_factory=list)
    all_of: list[str] = Field(default_factory=list)
    none_of: list[str] = Field(default_factory=list)
    #: When set, the names of the user's own items the run showed as cards
    #: (``core_show_items``, read as the shown_items check reads them) count as
    #: part of the answer, for all three lists: the prompt has the model show
    #: those items as cards and not list them again in the text.
    with_shown_items: bool = False


class ToolsCheck(_Check):
    """Tools (wire names) the run called, or must not have called."""

    kind: Literal["tools"]
    #: Each with at least one call that succeeded.
    called: list[str] = Field(default_factory=list)
    #: Each called at least once, also when the call failed (a refusal).
    tried: list[str] = Field(default_factory=list)
    #: Not called at all, not even in a call that failed.
    not_called: list[str] = Field(default_factory=list)
    #: The most calls a tool may get, e.g. one try of a write the user may not make.
    at_most: dict[str, int] = Field(default_factory=dict)


class ViewCheck(_Check):
    """The last map.view proposal frames this layer, or contains this point."""

    kind: Literal["view"]
    layer_project_id: int | None = None
    contains: tuple[float, float] | None = None


class NotSentCheck(_Check):
    """No request to geoapi or processes names this layer (a locked one)."""

    kind: Literal["not_sent"]
    layer_id: str


class WithheldCheck(_Check):
    """Under Restricted, every result of this tool withholds values (or it was not called)."""

    kind: Literal["withheld"]
    tool: str


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
    | ViewCheck
    | NotSentCheck
    | WithheldCheck
    | LanguageCheck
    | AskedCheck
    | WorkflowCreatedCheck
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

    id: str = Field(pattern=r"^(cat|proj|wf)-\d{2}$")
    suite: Suite
    #: The page context as the dock sends it (plan 3's wire format); its
    #: surface decides which tools the agent gets.
    context: dict[str, Any]
    locale: Locale = "en"
    data_policy: Literal["standard", "restricted"] = "standard"
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

    @model_validator(mode="after")
    def _surface_fits_suite(self) -> "EvalTask":
        surface = str(self.context.get("surface", ""))
        allowed = {
            "catalog": surface in ("catalog", "none"),
            "project": surface.startswith("project.") or surface == "none",
            "workflow": surface in ("project.map", "project.workflows"),
        }[self.suite]
        if not allowed:
            raise ValueError(
                f"surface {surface!r} does not belong to the {self.suite} suite"
            )
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
