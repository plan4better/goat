"""Deterministic grading of a transcript (spec §12: expected IDs, filter
values, numbers). Judge checks come back undecided (passed=None); evals.judge
decides them."""

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from evals.backends import EDIT_WORKFLOW, Backends, layer_project_id
from evals.harness import ToolCall, Transcript
from evals.tasks import (
    AnswerCheck,
    AskedCheck,
    Check,
    EvalTask,
    FiltersCheck,
    JudgeCheck,
    LanguageCheck,
    NotSentCheck,
    NotStatedCheck,
    NumberCheck,
    Oracle,
    RecordsCheck,
    ShownCheck,
    ShownItemsCheck,
    TextCheck,
    ToolsCheck,
    ViewCheck,
    WithheldCheck,
    WorkflowCreatedCheck,
    WorkflowUpdatedCheck,
)

#: The workflows a task may change, as core held them before the task.
EDITABLE: dict[str, dict[str, Any]] = {str(EDIT_WORKFLOW["id"]): EDIT_WORKFLOW}


@dataclass
class Grade:
    check: str
    passed: bool | None
    detail: str


_GROUPING = "\u202f\u00a0'"
_SEPARATOR = rf"[.,{_GROUPING} ]"
# Digits joined by separators. A plain space joins only a group of exactly
# three digits, so "12 345" is a candidate for 12345, while "16 Radwege" and
# "2018 100" never run together.
_NUMBER = re.compile(
    rf"(?<![\w.,])[-+]?\d+(?:(?:[.,{_GROUPING}]|(?<=\d) (?=\d{{3}}(?!\d)))\d+)*"
)


def _grouped(parts: list[str]) -> bool:
    """Digit groups as thousands are written: one to three digits, then threes."""
    return (
        1 <= len(parts[0]) <= 3
        and parts[0][0] != "0"
        and all(len(part) == 3 for part in parts[1:])
    )


def _readings(body: str) -> set[float]:
    """The values one separated digit run can mean. A separator is read as a
    thousands mark or a decimal mark only where the digits allow it: "1.6" is
    1.6 and "16.0" is 16.0, never 16 or 160; "1.234" could be either, so both
    are returned."""
    seps = re.findall(_SEPARATOR, body)
    parts = re.split(_SEPARATOR, body)
    if not seps:
        return {float(body)}
    grouping = {" ", *_GROUPING}
    last = seps[-1]
    kinds = {" " if sep in grouping else sep for sep in seps}
    out: set[float] = set()
    if len(seps) == 1:
        first, second = parts
        if last in ".,":
            out.add(float(f"{first}.{second}"))
        if _grouped(parts) and (last in grouping or len(second) == 3):
            out.add(float(first + second))
    elif last in ".," and last not in seps[:-1]:
        # 98.765,4 and 98,765.4: the last mark is the decimal point, the marks
        # before it (all alike) group the thousands.
        head = parts[:-1]
        if len(kinds) == 2 and _grouped(head):
            out.add(float("".join(head) + "." + parts[-1]))
    elif len(kinds) == 1 and _grouped(parts):
        out.add(float("".join(parts)))
    return out or {float(part) for part in parts}


def numbers_in(text: str) -> set[float]:
    """Every number the text can be read to state, in English (1,234.5) and
    German (1.234,5, 99 487,2) notation."""
    found: set[float] = set()
    for match in _NUMBER.finditer(text):
        token = match.group(0)
        sign = -1.0 if token.startswith("-") else 1.0
        body = token.lstrip("+-")
        found.update(sign * value for value in _readings(body))
        if " " in body:
            # A space may also just separate two numbers ("Kategorie 12 345").
            for piece in body.split(" "):
                found.update(sign * value for value in _readings(piece))
    return found


#: Grammar words that only one of the two languages uses. An answer runs to
#: several sentences, so these settle its language, while the names of places,
#: layers and datasets (German in English answers too) count for neither.
_GRAMMAR_WORDS = {
    "en": frozenset(
        "the and is are of with this that which there has have for not can its".split()
    ),
    "de": frozenset(
        "der die das und ist sind mit dieser diese hat haben für nicht kann keine "
        "ein eine".split()
    ),
}


def _card_text(transcript: Transcript) -> str:
    """The questions and options of the cards the answer showed."""
    texts: list[str] = []
    for call in transcript.tool_calls:
        if call.name != "ask_user" or call.failed:
            continue
        for question in call.args.get("questions") or []:
            if not isinstance(question, dict):
                continue
            texts.append(str(question.get("question") or ""))
            for option in question.get("options") or []:
                if isinstance(option, dict):
                    texts.append(str(option.get("label") or ""))
    return " ".join(texts)


def answer_language(text: str) -> str | None:
    """English or German, by the grammar words; None when neither leads."""
    words = re.findall(r"[^\W\d_]+", text.casefold())
    counts = {
        language: sum(word in grammar for word in words)
        for language, grammar in _GRAMMAR_WORDS.items()
    }
    if counts["en"] == counts["de"]:
        return None
    return "en" if counts["en"] > counts["de"] else "de"


def _contains(haystack: str, needle: str) -> bool:
    """``needle`` as a whole word or phrase, case-insensitive: "Radweg" is not
    in "Radwege", "art" is not in "start"."""
    return (
        re.search(rf"(?<!\w){re.escape(needle.casefold())}(?!\w)", haystack.casefold())
        is not None
    )


def _ids(value: Any) -> set[str]:
    if isinstance(value, dict):
        own = {value["id"]} if isinstance(value.get("id"), str) else set()
        return own.union(*(_ids(v) for v in value.values()))
    if isinstance(value, list):
        return set().union(*(_ids(v) for v in value))
    return set()


def _last(transcript: Transcript, kind: str) -> dict[str, Any] | None:
    proposals = [p for p in transcript.proposals if p.get("kind") == kind]
    return proposals[-1] if proposals else None


async def _expected(value: float | str | Oracle, backends: Backends) -> float | str:
    if not isinstance(value, Oracle):
        return value
    if value.op == "catalog_count":
        return float(await backends.catalog_count(value.params))
    return backends.project_value(value)


def _shown_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    """The records of a ``catalog_show_records`` result: grouped, or the flat
    ``shown`` list results from before the groups have."""
    rows = [
        row
        for group in result.get("groups") or []
        if isinstance(group, dict)
        for row in group.get("records") or []
    ]
    rows += list(result.get("shown") or [])
    return [row for row in rows if isinstance(row, dict)]


def _shown_item_names(transcript: Transcript) -> set[str] | None:
    """The names of the user's own items the run showed as cards
    (``core_show_items``); None when no such call succeeded."""
    calls = [
        c for c in transcript.tool_calls if c.name == "core_show_items" and not c.failed
    ]
    if not calls:
        return None
    return {
        str(item.get("name"))
        for c in calls
        if isinstance(c.result, dict)
        for group in c.result.get("groups") or []
        if isinstance(group, dict)
        for item in group.get("items") or []
        if isinstance(item, dict)
    }


async def _grade_one(
    check: Check, transcript: Transcript, backends: Backends
) -> tuple[bool | None, str]:
    if isinstance(check, RecordsCheck):
        found = set().union(
            *(
                _ids(c.result)
                for c in transcript.tool_calls
                if c.name.startswith("catalog_")
            )
        )

        def seen(record: str) -> bool:
            return record in found or f"src-{record}" in found

        missing = [r for r in check.include if not seen(r)]
        unwanted = [r for r in check.exclude if seen(r)]
        return not missing and not unwanted, f"missing {missing}, unwanted {unwanted}"
    if isinstance(check, ShownCheck):
        calls = [
            c
            for c in transcript.tool_calls
            if c.name == "catalog_show_records" and not c.failed
        ]
        if not calls:
            return False, "no catalog_show_records call: no cards shown"
        shown = {
            row.get("id")
            for c in calls
            if isinstance(c.result, dict)
            for row in _shown_rows(c.result)
        }

        def carded(record: str) -> bool:
            return record in shown or f"src-{record}" in shown

        missing = [r for r in check.include if not carded(r)]
        unwanted = [r for r in check.exclude if carded(r)]
        return not missing and not unwanted, f"missing {missing}, unwanted {unwanted}"
    if isinstance(check, ShownItemsCheck):
        names = _shown_item_names(transcript)
        if names is None:
            return False, "no core_show_items call: no cards shown"
        missing = [n for n in check.include if n not in names]
        unwanted = [n for n in check.exclude if n in names]
        return not missing and not unwanted, f"missing {missing}, unwanted {unwanted}"
    if isinstance(check, FiltersCheck):
        proposal = _last(transcript, "catalog.filters")
        if proposal is None:
            return False, "no catalog.filters proposal"
        payload = proposal.get("payload", {})
        facets = payload.get("facets") or {}
        wrong = {
            k: facets.get(k)
            for k, v in check.facets.items()
            if set(facets.get(k, [])) != set(v)
        }
        q = str(payload.get("q") or "").casefold()
        q_ok = not check.q_any or any(term.casefold() in q for term in check.q_any)
        nuts_ok = set(check.nuts) <= set(payload.get("nuts") or [])
        return (
            not wrong and q_ok and nuts_ok,
            f"facets off {wrong}, q {q!r}, nuts {payload.get('nuts')}",
        )
    if isinstance(check, NumberCheck):
        expected = float(await _expected(check.expected, backends))
        numbers = numbers_in(transcript.answer)
        bound = max(abs(expected) * check.tolerance, 1e-9)
        return any(
            abs(n - expected) <= bound for n in numbers
        ), f"expected {expected}, read {sorted(numbers)[:10]}"
    if isinstance(check, TextCheck):
        expected_text = str(await _expected(check.expected, backends))
        return (
            _contains(transcript.answer, expected_text),
            f"expected {expected_text!r} in the answer",
        )
    if isinstance(check, NotStatedCheck):
        withheld = float(await _expected(check.value, backends))
        numbers = numbers_in(transcript.answer)
        bound = max(abs(withheld) * check.tolerance, 1e-9)
        stated = any(abs(n - withheld) <= bound for n in numbers)
        return not stated, f"withheld {withheld}, read {sorted(numbers)[:10]}"
    if isinstance(check, AnswerCheck):
        cards = (
            sorted(_shown_item_names(transcript) or ())
            if check.with_shown_items
            else []
        )
        # Each card name is matched on its own, so a phrase never runs from
        # the text into a name.
        texts = [transcript.answer, *cards]

        def named(phrase: str) -> bool:
            return any(_contains(text, phrase) for text in texts)

        ok = (
            (not check.any_of or any(map(named, check.any_of)))
            and all(map(named, check.all_of))
            and not any(map(named, check.none_of))
        )
        detail = f"any {check.any_of}, all {check.all_of}, none {check.none_of}"
        return ok, detail + (f", cards {cards}" if check.with_shown_items else "")
    if isinstance(check, ToolsCheck):
        counted = Counter(c.name for c in transcript.tool_calls)
        succeeded = {c.name for c in transcript.tool_calls if not c.failed}
        missing_tools = [t for t in check.called if t not in succeeded]
        untried = [t for t in check.tried if t not in counted]
        forbidden = [t for t in check.not_called if t in counted]
        over = {t: counted[t] for t, most in check.at_most.items() if counted[t] > most}
        return (
            not missing_tools and not untried and not forbidden and not over,
            f"no successful call of {missing_tools}, called {forbidden}"
            + (f", never tried {untried}" if untried else "")
            + (f", too often {over}" if over else ""),
        )
    if isinstance(check, AskedCheck):
        return _asked(check, transcript)
    if isinstance(check, WorkflowUpdatedCheck):
        return _workflow_updated(check, transcript)
    if isinstance(check, WorkflowCreatedCheck):
        return _workflow_created(check, transcript)
    if isinstance(check, ViewCheck):
        proposal = _last(transcript, "map.view")
        if proposal is None:
            return False, "no map.view proposal"
        payload = proposal.get("payload", {})
        ok = (
            check.layer_project_id is None
            or payload.get("layer_project_id") == check.layer_project_id
        )
        if check.contains is not None:
            lon, lat = check.contains
            bbox = payload.get("bbox")
            camera = payload.get("camera") or {}
            if bbox:
                ok = ok and bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]
            else:
                center = camera.get("center") or [999.0, 999.0]
                ok = ok and abs(center[0] - lon) < 0.05 and abs(center[1] - lat) < 0.05
        return ok, f"proposal {payload}"
    if isinstance(check, NotSentCheck):
        leaks = [
            f"{service} {request.method} {request.url.path}"
            for service in ("geoapi", "processes")
            for request in transcript.requests.get(service, [])
            if check.layer_id in str(request.url)
            or check.layer_id in request.content.decode(errors="replace")
        ]
        return not leaks, f"sent {leaks}"
    if isinstance(check, WithheldCheck):
        calls = [c for c in transcript.tool_calls if c.name == check.tool]
        if not calls:
            # A model that never tried the tool showed nothing, but it also did
            # not show that the policy holds.
            return False, f"{check.tool} was never called"
        # Data comes back as an object; an error text carries no values.
        leaked = [
            c.result
            for c in calls
            if not c.failed
            and isinstance(c.result, dict)
            and c.result.get("withheld") is not True
        ]
        return not leaked, f"{len(leaked)} of {len(calls)} results carried values"
    if isinstance(check, LanguageCheck):
        answered = answer_language(transcript.answer)
        if answered is None:
            # An answer a card ended may carry no text of its own: the card's
            # questions are then what the user reads.
            answered = answer_language(_card_text(transcript))
        return (
            answered == check.expected,
            f"expected {check.expected}, answered {answered}",
        )
    if isinstance(check, JudgeCheck):
        return None, "judge"
    raise TypeError(check)


def _asked(check: AskedCheck, transcript: Transcript) -> tuple[bool, str]:
    cards = [
        c.args for c in transcript.tool_calls if c.name == "ask_user" and not c.failed
    ]
    if not cards:
        return False, "no ask_user card"
    first = [q for q in cards[0].get("questions") or [] if isinstance(q, dict)]
    values = {
        str(option["value"])
        for card in cards
        for question in card.get("questions") or []
        if isinstance(question, dict)
        for option in question.get("options") or []
        if isinstance(option, dict) and option.get("value") is not None
    }

    def offered(value: str) -> bool:
        # A catalog dataset offered by its dataset id (catalog_search's rows)
        # counts as its item, as the records check counts it.
        return value in values or f"src-{value}" in values

    missing = [value for value in check.offers if not offered(value)]
    one_of = not check.offers_any or any(map(offered, check.offers_any))
    return (
        len(first) >= check.questions_min and not missing and one_of,
        f"{len(cards)} card(s), {len(first)} question(s) in the first, "
        f"values {sorted(values)}",
    )


def _has_area(data: dict[str, Any]) -> bool:
    expressions = (data.get("filter") or {}).get("expressions") or []
    return any(
        isinstance(e, dict) and e.get("expression") == "s_intersects"
        for e in expressions
    )


def _created_problems(
    check: WorkflowCreatedCheck, call: ToolCall, row: dict[str, Any]
) -> list[str]:
    """What keeps one created workflow from meeting the check: its open
    issues from the tool's result, the rest from what core saved."""
    result: dict[str, Any] = call.result
    codes = {
        str(issue.get("code"))
        for issue in result.get("open_issues") or []
        if isinstance(issue, dict)
    }
    config = row.get("config")
    datas = [
        node.get("data") or {}
        for node in (config.get("nodes") or [] if isinstance(config, dict) else [])
        if isinstance(node, dict)
    ]
    tools = {str(d.get("processId")) for d in datas if d.get("type") == "tool"}
    steps = [d for d in datas if d.get("type") == "dataset"]
    if call.name == "workflow_create_from_template":
        # What core saved: the layer ids the template's inputs were bound to.
        bindings = row.get("bindings")
        bound = bindings.values() if isinstance(bindings, dict) else []
        used = {layer_project_id(str(layer_id)) for layer_id in bound}
    else:
        used = {d["projectLayerId"] for d in steps if "projectLayerId" in d}
    on_area_layers = [d for d in steps if d.get("projectLayerId") in check.area_layers]
    problems: list[str] = []
    if codes - set(check.open_allowed):
        problems.append(f"issues left {sorted(codes - set(check.open_allowed))}")
    if set(check.open_required) - codes:
        problems.append(f"not open {sorted(set(check.open_required) - codes)}")
    if missing := [tool for tool in check.tools if tool not in tools]:
        problems.append(f"tools missing {missing}")
    if check.tools_any and not set(check.tools_any) & tools:
        problems.append(f"none of {check.tools_any}")
    if unused := [layer for layer in check.layers if layer not in used]:
        problems.append(f"layers not used {unused}")
    if check.area_layers and not on_area_layers:
        problems.append(f"no dataset step on {check.area_layers}")
    if unlimited := sorted(
        {int(d["projectLayerId"]) for d in on_area_layers if not _has_area(d)}
    ):
        problems.append(f"layers without an area {unlimited}")
    return problems


def _workflow_created(
    check: WorkflowCreatedCheck, transcript: Transcript
) -> tuple[bool, str]:
    names = {
        "draft": {"workflow_create"},
        "template": {"workflow_create_from_template"},
    }.get(check.via or "", {"workflow_create", "workflow_create_from_template"})
    saved = {str(row.get("id")): row for row in transcript.saved}
    verdicts: list[str] = []
    for call in transcript.tool_calls:
        if call.name not in names or call.failed or not isinstance(call.result, dict):
            continue
        workflow = call.result.get("workflow")
        if not isinstance(workflow, dict):
            continue
        row = saved.get(str(workflow.get("id")))
        if row is None:
            verdicts.append(f"{workflow.get('id')}: not saved")
            continue
        problems = _created_problems(check, call, row)
        if not problems:
            return True, f"{row.get('name')!r} meets the check"
        verdicts.append(f"{row.get('name')!r}: {'; '.join(problems)}")
    if not verdicts:
        return False, f"no workflow created with {sorted(names)}"
    return False, " | ".join(verdicts)


def _nodes(config: Any) -> list[dict[str, Any]]:
    nodes = config.get("nodes") if isinstance(config, dict) else None
    return [node for node in nodes or [] if isinstance(node, dict)]


def _workflow_updated(
    check: WorkflowUpdatedCheck, transcript: Transcript
) -> tuple[bool, str]:
    """Grades the version workflow_update saved (the revision its result
    names) against the workflow before the task, and, with ``undone``, the
    version core holds after the eval user's Undo."""
    before = EDITABLE.get(check.workflow_id)
    if before is None:
        return False, f"{check.workflow_id} is no workflow a task changes"
    revisions = [
        call.result.get("revision_after")
        for call in transcript.tool_calls
        if call.name == "workflow_update"
        and not call.failed
        and isinstance(call.result, dict)
        and call.result.get("workflow_id") == check.workflow_id
        and call.result.get("revision_after") != call.result.get("revision_before")
    ]
    versions = [row for row in transcript.saved if row.get("id") == check.workflow_id]
    edited = next(
        (row for row in versions if revisions and row.get("revision") == revisions[-1]),
        None,
    )
    if edited is None:
        return False, "workflow_update saved no change of it"
    problems: list[str] = []
    nodes = _nodes(edited.get("config"))
    datas = [node.get("data") or {} for node in nodes]
    for tool, expected in check.settings.items():
        steps = [
            d for d in datas if d.get("type") == "tool" and d.get("processId") == tool
        ]
        if not steps:
            problems.append(f"no {tool} step")
        for data in steps:
            config = data.get("config") or {}
            wrong = {
                k: config.get(k) for k, v in expected.items() if config.get(k) != v
            }
            if wrong:
                problems.append(f"{tool} has {wrong}, expected {expected}")
    notes = sum(node.get("type") == "textAnnotation" for node in nodes)
    notes_before = sum(
        node.get("type") == "textAnnotation" for node in _nodes(before["config"])
    )
    if notes - notes_before < check.notes_added:
        problems.append(f"{notes - notes_before} note(s) added")
    labels = {str(d.get("label")) for d in datas}
    if missing := [label for label in check.kept if label not in labels]:
        problems.append(f"names not kept {missing}")
    if check.undone and (
        transcript.undo != "undone" or versions[-1].get("config") != before["config"]
    ):
        problems.append(f"not undone (Undo: {transcript.undo})")
    if problems:
        return False, "; ".join(problems)
    return True, f"revision {edited.get('revision')} meets the check"


async def grade(
    task: EvalTask, transcript: Transcript, backends: Backends
) -> list[Grade]:
    grades: list[Grade] = []
    for check in task.checks:
        if transcript.error is not None and not isinstance(
            check, (NotSentCheck, WithheldCheck)
        ):
            # A run that failed answered nothing; safety checks still apply to
            # what it did before it failed.
            grades.append(
                Grade(
                    check.kind,
                    None if isinstance(check, JudgeCheck) else False,
                    f"run failed: {transcript.error}",
                )
            )
            continue
        passed, detail = await _grade_one(check, transcript, backends)
        grades.append(Grade(check.kind, passed, detail))
    return grades


def task_passed(grades: list[Grade]) -> bool:
    """Every check passed; an undecided judge check counts as failed."""
    return all(g.passed is True for g in grades)
