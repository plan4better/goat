"""The check's issues in the draft's own terms, and which of them may stay open
when the workflow is created (spec §4.3, §4.4).

Processes checks the converted config and names steps by node id; the model
fixes its draft by the draft's ids, so the issues are mapped back. A one-step
issue's message starts with the step's name, so the answer can quote it; an
issue of several steps or of the whole workflow keeps processes' message.
"""

import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from goatlib.tools.limits import (
    CATCHMENT_MAX_STARTING_POINTS,
    CATCHMENT_MAX_STARTING_POINTS_PT,
    TRAVEL_COST_MATRIX_MAX_PAIRS,
)
from pydantic import BaseModel, Field

from assistant.workflows.draft import (
    BBox,
    Converted,
    DatasetStep,
    Draft,
    ProjectLayer,
    Region,
    ToolStep,
    bbox,
)

#: Levels that stop a run (``goatlib.workflows.checks``).
BLOCKING_LEVELS = frozenset({"damaged", "error"})
#: The assistant's own code: a ``where`` field the step's layer does not have.
FILTER_FIELD_CODE = "filter_field_not_in_layer"
#: The assistant's own code: a dataset step's ``filter.area`` lies mostly
#: outside the layers the step is combined with.
AREA_OUTSIDE_CODE = "filter_area_outside"
#: The share of an area's box inside the box of the layers it is combined
#: with, and of theirs inside its own, below which both count as mostly apart.
_MOSTLY = 0.5
_LISTED_FIELDS = 30


class DraftIssue(BaseModel):
    code: str
    level: str
    #: The draft ids of the steps it concerns; empty for the whole workflow.
    steps: list[str] = Field(default_factory=list)
    #: A tool input or setting name, or a filter's field.
    field: str | None = None
    message: str


def _prefixed(message: str, label: str) -> str:
    return message if message.startswith(f"{label}:") else f"{label}: {message}"


def draft_issues(
    raw: Sequence[Mapping[str, Any]], converted: Converted
) -> list[DraftIssue]:
    """The check's issues (``Issue.to_dict()`` rows) with node ids mapped to
    draft ids; a one-step issue's message starts with that step's name."""
    found: list[DraftIssue] = []
    for row in raw:
        node_ids = [str(node) for node in row.get("node_ids") or []]
        steps = [
            converted.step_of[node] for node in node_ids if node in converted.step_of
        ]
        message = str(row.get("message") or row.get("code") or "")
        if len(steps) == 1:
            message = _prefixed(message, converted.labels[steps[0]])
        field = row.get("field")
        found.append(
            DraftIssue(
                code=str(row.get("code") or ""),
                level=str(row.get("level") or "error"),
                steps=steps,
                field=str(field) if field is not None else None,
                message=message,
            )
        )
    return found


def field_list(fields: Sequence[str]) -> str:
    """The layer's fields for a message: at most ``_LISTED_FIELDS``, then the
    number of fields left out."""
    if not fields:
        return "The layer has no fields that can be filtered."
    listed = ", ".join(fields[:_LISTED_FIELDS])
    more = len(fields) - _LISTED_FIELDS
    suffix = f" (and {more} more)" if more > 0 else ""
    return f"Its fields: {listed}{suffix}."


def filter_field_issues(
    draft: Draft,
    fields: Mapping[str, Sequence[str] | None],
    labels: Mapping[str, str],
) -> list[DraftIssue]:
    """A ``where`` condition on a field the step's layer does not have.
    ``fields``: draft step id -> its layer's field names, None while they
    cannot be read (a catalog layer whose data is still being copied); such a
    step is not judged."""
    found: list[DraftIssue] = []
    for step in draft.steps:
        if not isinstance(step, DatasetStep) or step.filter is None:
            continue
        known = fields.get(step.id)
        if known is None:
            continue
        listed = field_list(known)
        for condition in step.filter.where:
            if condition.field in known:
                continue
            found.append(
                DraftIssue(
                    code=FILTER_FIELD_CODE,
                    level="error",
                    steps=[step.id],
                    field=condition.field,
                    message=(
                        f"{labels[step.id]}: the filter's field {condition.field!r} "
                        f"is not in the layer. {listed}"
                    ),
                )
            )
    return found


def _named_in(issue: DraftIssue, settings: Mapping[str, frozenset[str]]) -> bool:
    return issue.field is not None and all(
        issue.field in settings.get(step, ()) for step in issue.steps
    )


def _stays_open(
    issue: DraftIssue,
    open_ids: frozenset[str],
    field_settings: Mapping[str, frozenset[str]],
    layer_settings: Mapping[str, frozenset[str]],
) -> bool:
    if issue.level != "error" or not issue.steps or not set(issue.steps) <= open_ids:
        return False
    # Reported on dataset steps only, and a dataset step is open only when
    # it is left open itself.
    if issue.code == "layer_not_chosen":
        return True
    if issue.code == "setting_invalid":
        # No field: a rejection of the step as a whole, whose cause the check
        # does not name; the layer still to be chosen may be it.
        return issue.field is None or _named_in(issue, layer_settings)
    return issue.code == "setting_required" and _named_in(issue, field_settings)


def split_issues(
    issues: Sequence[DraftIssue],
    open_ids: frozenset[str],
    *,
    field_settings: Mapping[str, frozenset[str]] = {},
    layer_settings: Mapping[str, frozenset[str]] = {},
) -> tuple[list[DraftIssue], list[DraftIssue]]:
    """``(blocking, open)``. Warnings are neither. An error stays open only
    when every step it names is an open step or reads from one
    (``draft.open_steps``) and the layer still to be chosen can cause it: no
    layer chosen; a required field setting reading that layer
    (``field_settings``: draft step id -> those settings); a setting the tool
    rejects when it reads that layer (``layer_settings``: draft step id ->
    the inputs fed from an open step and the settings reading them); and a
    rejection of the step as a whole (no field), whatever its cause, since
    the check does not name one. Everything else blocks: a damaged issue,
    an issue of the whole workflow, a rejected setting that reads no layer
    still to be chosen, and the other errors, such as a loop, an unknown
    input, a removed tool, a field missing from another input's layer or a
    filter on a chosen layer. ``field_not_in_layer`` is never open: processes
    judges a field setting only against a layer it can read."""
    blocking: list[DraftIssue] = []
    still_open: list[DraftIssue] = []
    for issue in issues:
        if issue.level not in BLOCKING_LEVELS:
            continue
        if _stays_open(issue, open_ids, field_settings, layer_settings):
            still_open.append(issue)
        else:
            blocking.append(issue)
    return blocking, still_open


#: The catchment tool: its budget can hold several bands in one run, and one
#: run takes a limited number of start points.
CATCHMENT_TOOL = "catchment_area_v2"
#: The settings that set a catchment's budget and its bands.
_BUDGET_SETTINGS = frozenset({"max_cost", "steps", "step_sizes"})


#: The travel cost matrix: one run takes a limited number of origin and
#: destination pairs.
MATRIX_TOOL = "travel_cost_matrix"
#: Tools whose result has as many rows as their inputs together, by the
#: inputs that count: a merge has the rows of both its inputs, a centroid one
#: point per feature of its input.
_COUNTED_INPUTS: dict[str, tuple[str, ...]] = {
    "merge": ("input_path_1", "input_path_2"),
    "centroid": ("input_layer_id",),
}
#: The layer inputs whose features a run's limit counts, per tool.
_LIMITED_INPUTS: dict[str, tuple[str, ...]] = {
    CATCHMENT_TOOL: ("starting_points",),
    MATRIX_TOOL: ("origin_layer_id", "destination_layer_id"),
}


def _feeds(draft: Draft) -> dict[tuple[str, str], str]:
    """(step id, input) -> the id of the step its connection reads from."""
    return {
        (connection.target, connection.input): connection.source
        for connection in draft.connections
        if connection.input is not None
    }


def counted_datasets(draft: Draft, step_id: str) -> Counter[str] | None:
    """The dataset steps whose features make up the rows of the step's
    result, each with how often it counts: a dataset step itself once, the
    datasets of both inputs of a merge added up, those of a centroid's input.
    None when the rows are not known before the run: any other tool, or a
    merge or a centroid with an input that is not connected or not known
    either. Each step is read once, so a step that several paths reach costs
    no more than one that a single path reaches."""
    by_id = {step.id: step for step in draft.steps}
    feeds = _feeds(draft)
    # A step being read is None until it is done, so a loop reads as unknown.
    known: dict[str, Counter[str] | None] = {}

    def walk(step_id: str) -> Counter[str] | None:
        if step_id in known:
            return known[step_id]
        known[step_id] = None
        step = by_id.get(step_id)
        found: Counter[str] | None = None
        if isinstance(step, DatasetStep):
            found = Counter({step.id: 1})
        elif isinstance(step, ToolStep) and step.tool in _COUNTED_INPUTS:
            found = Counter()
            for name in _COUNTED_INPUTS[step.tool]:
                source = feeds.get((step_id, name))
                datasets = None if source is None else walk(source)
                if datasets is None:
                    found = None
                    break
                found.update(datasets)
        known[step_id] = found
        return found

    return walk(step_id)


def _limited(draft: Draft, step: ToolStep, name: str) -> Counter[str] | None:
    """The dataset steps a limited input of the step sums up
    (``counted_datasets``); None when it is not connected or not known."""
    source = _feeds(draft).get((step.id, name))
    return None if source is None else counted_datasets(draft, source)


def counted_steps(draft: Draft) -> list[str]:
    """The dataset steps whose features the start-point and pair checks
    count, each once: those that make up a catchment's start points, and a
    matrix's origins and destinations when both sides can be counted
    (``counted_datasets``)."""
    found: dict[str, None] = {}
    for step in draft.steps:
        if not isinstance(step, ToolStep) or step.tool not in _LIMITED_INPUTS:
            continue
        sides = [_limited(draft, step, name) for name in _LIMITED_INPUTS[step.tool]]
        if any(side is None for side in sides):
            continue
        for side in sides:
            found.update(dict.fromkeys(side or {}))
    return list(found)


def _total(datasets: Mapping[str, int] | None, counts: Mapping[str, int]) -> int | None:
    """The datasets' counts, each times how often it counts; None when one of
    them is not counted, so a sum is never reported low."""
    if datasets is None or any(dataset not in counts for dataset in datasets):
        return None
    return sum(counts[dataset] * times for dataset, times in datasets.items())


def _once(step_ids: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(step_ids))


def starting_point_sources(draft: Draft) -> dict[str, str]:
    """Catchment step id -> the id of the step its ``starting_points`` input
    reads from."""
    return {
        connection.target: connection.source
        for connection in draft.connections
        if connection.input == "starting_points"
    }


def _number(value: float) -> str:
    return f"{value:g}"


def band_issues(draft: Draft) -> list[DraftIssue]:
    """A warning for catchments that start from the same step with the same
    settings and differ only in their budget: one catchment with that many
    steps returns them all as bands, so the steps after it run once instead of
    once per budget."""
    starts = starting_point_sources(draft)
    groups: dict[tuple[str, str], list[ToolStep]] = {}
    for step in draft.steps:
        if not isinstance(step, ToolStep) or step.tool != CATCHMENT_TOOL:
            continue
        if step.id not in starts:
            continue
        rest = {k: v for k, v in step.settings.items() if k not in _BUDGET_SETTINGS}
        key = (starts[step.id], json.dumps(rest, sort_keys=True, default=str))
        groups.setdefault(key, []).append(step)
    issues: list[DraftIssue] = []
    for steps in groups.values():
        budgets = sorted(
            {
                float(step.settings["max_cost"])
                for step in steps
                if isinstance(step.settings.get("max_cost"), int | float)
            }
        )
        if len(steps) < 2 or len(budgets) < 2:
            continue
        largest, count = budgets[-1], len(budgets)
        even = all(
            abs(budget - largest * (index + 1) / count) < 1e-9
            for index, budget in enumerate(budgets)
        )
        listed = ", ".join(_number(budget) for budget in budgets)
        setting = (
            f"max_cost {_number(largest)} and steps {count}"
            if even
            else f"max_cost {_number(largest)}, steps {count} and step_sizes [{listed}]"
        )
        issues.append(
            DraftIssue(
                code="catchment_bands_split",
                level="warning",
                steps=[step.id for step in steps],
                message=(
                    "These catchments start from the same step with the same settings "
                    f"and differ only in their budget ({listed}). One catchment with "
                    f"{setting} returns them all at once as bands: use it instead, and "
                    "connect the steps after it once."
                ),
            )
        )
    return issues


def starting_point_issues(
    draft: Draft, counts: Mapping[str, int], labels: Mapping[str, str]
) -> list[DraftIssue]:
    """An error for a catchment whose dataset steps give it more start points
    than one run takes, read directly or through merge and centroid steps
    (``counted_datasets``); ``counts``: dataset step id -> its features after
    its filter. A catchment whose start points are not all counted is not
    judged; the issue names the catchment and each dataset step it sums."""
    issues: list[DraftIssue] = []
    for step in draft.steps:
        if not isinstance(step, ToolStep) or step.tool != CATCHMENT_TOOL:
            continue
        datasets = _limited(draft, step, "starting_points")
        count = _total(datasets, counts)
        if datasets is None or count is None:
            continue
        pt = step.settings.get("routing_mode") == "pt"
        limit = (
            CATCHMENT_MAX_STARTING_POINTS_PT if pt else CATCHMENT_MAX_STARTING_POINTS
        )
        if count <= limit:
            continue
        mode = "public transport" if pt else "this mode"
        issues.append(
            DraftIssue(
                code="too_many_starting_points",
                level="error",
                steps=_once([step.id, *datasets]),
                field=None,
                message=(
                    f"{labels.get(step.id, step.id)} starts from {count:,} points; one "
                    f"catchment takes at most {limit:,} for {mode}. When every start "
                    "point counts, run it in parts: several catchment steps, each on "
                    f"a part of the dataset with at most {limit:,} points (a filter "
                    "by district or by a range of a field), merged and dissolved into "
                    "one area. When the question is about part of them already (a "
                    "district, a stop type), narrow the dataset step's filter to "
                    "that part and say so; otherwise narrowing is an option to "
                    "offer as such."
                ),
            )
        )
    return issues


def matrix_pair_issues(
    draft: Draft, counts: Mapping[str, int], labels: Mapping[str, str]
) -> list[DraftIssue]:
    """An error for a travel cost matrix whose origins times destinations
    exceed the pairs one run takes, each side counted as the start points
    are (``starting_point_issues``); a matrix with a side not counted is not
    judged."""
    issues: list[DraftIssue] = []
    for step in draft.steps:
        if not isinstance(step, ToolStep) or step.tool != MATRIX_TOOL:
            continue
        starts = _limited(draft, step, "origin_layer_id")
        ends = _limited(draft, step, "destination_layer_id")
        origins, destinations = _total(starts, counts), _total(ends, counts)
        if starts is None or ends is None or origins is None or destinations is None:
            continue
        pairs = origins * destinations
        if pairs <= TRAVEL_COST_MATRIX_MAX_PAIRS:
            continue
        larger = "origins" if origins >= destinations else "destinations"
        issues.append(
            DraftIssue(
                code="too_many_matrix_pairs",
                level="error",
                steps=_once([step.id, *starts, *ends]),
                field=None,
                message=(
                    f"{labels.get(step.id, step.id)} pairs {origins:,} origins with "
                    f"{destinations:,} destinations, {pairs:,} pairs; one matrix "
                    f"takes at most {TRAVEL_COST_MATRIX_MAX_PAIRS:,}. Make the larger "
                    f"side smaller, here the {larger}: areas aggregated to larger "
                    "areas first, one centroid each, or a narrower filter on the "
                    "dataset step; destinations of only the kinds the question "
                    "asks about. By public transport, area centroids belong on the "
                    "destination side, with the centre as origin (the reversed "
                    "matrix). When every place matters, use a heatmap instead "
                    "(heatmap_closest_average), which covers the whole area without "
                    "pairs. A narrower matrix than the question asks for is an "
                    "option to offer as such."
                ),
            )
        )
    return issues


def note_issues(draft: Draft) -> list[DraftIssue]:
    """A warning for a draft with more than one note: one per workflow says
    what it answers, unless the user asked for more, which the check cannot
    know."""
    if len(draft.notes) <= 1:
        return []
    return [
        DraftIssue(
            code="more_than_one_note",
            level="warning",
            message=(
                f"The draft has {len(draft.notes)} notes. Write one note per "
                "workflow unless the user asked for more: what the workflow "
                "answers and how to read its results."
            ),
        )
    ]


def _joined(draft: Draft) -> dict[str, str]:
    """Each step's group of steps joined by connections, named by one of
    them: the steps a step is combined with share its group."""
    root = {step.id: step.id for step in draft.steps}

    def find(step_id: str) -> str:
        while root[step_id] != step_id:
            root[step_id] = root[root[step_id]]
            step_id = root[step_id]
        return step_id

    for connection in draft.connections:
        root[find(connection.source)] = find(connection.target)
    return {step.id: find(step.id) for step in draft.steps}


def _box_area(box: BBox) -> float:
    west, south, east, north = box
    return max(east - west, 0.0) * max(north - south, 0.0)


def _overlap(a: BBox, b: BBox) -> float:
    return _box_area(
        (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    )


def _around(boxes: Iterable[BBox]) -> BBox:
    listed = list(boxes)
    return (
        min(box[0] for box in listed),
        min(box[1] for box in listed),
        max(box[2] for box in listed),
        max(box[3] for box in listed),
    )


def area_issues(
    draft: Draft,
    converted: Converted,
    layers: Mapping[int, ProjectLayer],
    regions: Mapping[str, Region],
) -> list[DraftIssue]:
    """A warning for a dataset step whose area (``filter.area``) lies mostly
    outside the layers it is combined with (the dataset steps joined to it by
    connections), and does not hold most of them either: the bounding box of
    its region against the box around theirs, each the box of its region
    when it has an area, else the extent core lists for its layer. The steps
    of one layer with an area are judged as one, so the place and the region
    beyond its border merged are not apart. Not judged while one of the
    layers combined with it has no extent, or is still to be chosen."""
    joined = _joined(draft)
    datasets = [step for step in draft.steps if isinstance(step, DatasetStep)]

    def area_box(step: DatasetStep) -> BBox | None:
        area = step.filter.area if step.filter is not None else None
        region = regions.get(area) if area is not None else None
        return None if region is None else bbox(region.geometry)

    def footprint(step: DatasetStep) -> BBox | None:
        if step.filter is not None and step.filter.area is not None:
            return area_box(step)
        layer = layers.get(step.layer) if step.layer is not None else None
        return None if layer is None else layer.extent

    groups: dict[tuple[str, int], list[DatasetStep]] = {}
    for step in datasets:
        if step.layer is not None and step.filter is not None and step.filter.area:
            groups.setdefault((joined[step.id], step.layer), []).append(step)
    issues: list[DraftIssue] = []
    for (group, _), steps in groups.items():
        judged = {step.id for step in steps}
        others = [
            step
            for step in datasets
            if joined[step.id] == group and step.id not in judged
        ]
        boxes = [area_box(step) for step in steps]
        around = [footprint(step) for step in others]
        if not others or None in boxes or None in around:
            continue
        own = _around(box for box in boxes if box is not None)
        theirs = _around(box for box in around if box is not None)
        if _box_area(own) <= 0 or _box_area(theirs) <= 0:
            continue
        shared = _overlap(own, theirs)
        if shared >= _MOSTLY * _box_area(own) or shared >= _MOSTLY * _box_area(theirs):
            continue
        names = ", ".join(converted.labels.get(step.id, step.id) for step in steps)
        areas = ", ".join(
            f"{regions[area].name}, {area}"
            for step in steps
            if step.filter is not None and (area := step.filter.area) is not None
        )
        combined = ", ".join(converted.labels.get(step.id, step.id) for step in others)
        issues.append(
            DraftIssue(
                code=AREA_OUTSIDE_CODE,
                level="warning",
                steps=[step.id for step in steps],
                message=(
                    f"{names}: the area of filter.area ({areas}) lies mostly outside "
                    "the extent of the layers it is combined with "
                    f"({combined}). A region found by name can be a same-named one "
                    "elsewhere: check its parents (catalog_find_region) against the "
                    "place the user named. A district or quarter of a city that is "
                    "not a NUTS region is filtered by name or geometry in the city's "
                    "own boundary layer instead."
                ),
            )
        )
    return issues
