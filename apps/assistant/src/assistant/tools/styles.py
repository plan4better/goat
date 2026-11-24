"""The style tools of the map page: ``style_get`` reads a layer's style with
its issues and legend numbers, ``style_catalog`` looks up the palettes,
library icons and emoji a style refers to by id, and ``style_update`` changes
a style or creates a named one. On the map page only, never over MCP.

``style_update`` follows the workflow edit: the model sends operations (or a
whole document), goatlib applies them in process, core's check route judges
the result before anything is written, and the save goes on the revision that
was read, so core merges it onto a change made elsewhere in between. Whatever
can be refused is refused before the first write; after it the call always
returns its result with the undo record. A call that ends without one (a
Stop, the answer's clock) leaves the record of what landed, which it keeps
in ``ToolEnv.landed`` as its writes land. A save that got no answer is read
back, since it may have landed all the same.
"""

import asyncio
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from goatlib.style.data_check import referenced_fields
from goatlib.style.map_rows import MAX_STYLES
from goatlib.style.pointer import find_index, item_key, parse_pointer, to_pointer
from pydantic import BaseModel, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import consented
from assistant.maps.state import NO_PROJECT, MapRead, read_map
from assistant.styles import edits
from assistant.styles.catalog import CatalogInput, CatalogResult, search
from assistant.styles.edits import Mode, StyleUpdated, StyleUpdateInput
from assistant.styles.legend import LegendNumbers, legend_numbers
from assistant.styles.view import (
    MAX_ISSUES,
    CutList,
    IssueView,
    compact,
    issue_views,
)
from assistant.surfaces import Surface
from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.project import (
    GET_LAYERS,
    LayerInput,
    _fields,
    _Layer,
    _listed_layer,
    _project_id,
)
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.tools.workflows import open_project

logger = logging.getLogger(__name__)

#: The pages of the style tools.
STYLE_SURFACES: frozenset[Surface] = frozenset({"project.map"})


async def _catalog(env: ToolEnv, args: CatalogInput) -> CatalogResult:
    if args.kind != "icons":
        return search(args)
    # No await between the count and its read: the calls of one response run
    # concurrently, and only one of them is the answer's first.
    env.icon_lookups.append(
        tuple(args.queries) if args.queries is not None else (args.query or "",)
    )
    return search(args, again=len(env.icon_lookups) > 1)


CATALOG: ToolSpec[CatalogInput, CatalogResult] = ToolSpec(
    name="style.catalog",
    description=(
        "Look up what a layer's style can refer to by id: color palettes (by kind, "
        "colorblind safety and number of classes, with their colors), GOAT's "
        "library icons (goat:<name>) and emoji (emoji:<code>). One call is "
        "enough: icons without a query, or with one that matches nothing, lists "
        "all of them by group; a search by English words answers at most 30 rows "
        "and how many matched. For several icons, pass every search word in "
        "queries, in one call, or leave the query out for all of them; one call "
        "per icon is never needed. For styling only; datasets are found with "
        "catalog_search."
    ),
    input_model=CatalogInput,
    output_model=CatalogResult,
    run=_catalog,
    surfaces=STYLE_SURFACES,
)


# -- style.get --------------------------------------------------------------------

NOT_THIS_LAYERS = "This style does not belong to the layer."
NO_LAYER_ACCESS = "The user has no access to this layer."
NO_STYLE_YET = "This layer has no style yet."
NO_TABLE_STYLE = "A table has no style."
NOT_CHECKED = "The style could not be checked against the data right now."
#: The skill that holds how to style.
STYLE_SKILL = "style-a-map"
SKILL_FIRST = (
    f"Before you change this style, load the skill {STYLE_SKILL} with "
    "skills_load: it holds the forms and the rules."
)


def _skill_missing(env: ToolEnv) -> bool:
    """Whether the conversation is known and has not loaded the skill."""
    return env.skills is not None and STYLE_SKILL not in env.skills


async def read_style(
    env: ToolEnv,
    project_id: UUID,
    layer_project_id: int,
    style_id: str,
    *,
    check: bool,
) -> dict[str, Any]:
    """One named style of a layer as core answers it (``StyleRead``: id, name,
    position, revision, document, issues, stale); ``check`` asks core to check
    it against the data, which adds its issues. A style id that is no UUID,
    or names another layer's style, is refused as core refuses it."""
    try:
        canonical = UUID(style_id)
    except ValueError:
        raise ToolFailed(NOT_THIS_LAYERS) from None
    try:
        reply = await env.call(
            "core",
            "GET",
            f"/api/v2/project/{project_id}/layer/{layer_project_id}/style/{canonical}",
            params={"check": "true"} if check else None,
        )
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        detail = exc.body.get("detail") if isinstance(exc.body, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        if exc.status == 404:
            raise ToolFailed(NOT_THIS_LAYERS) from exc
        if exc.status == 403 and code == "locked":
            raise ToolFailed(NO_LAYER_ACCESS) from exc
        # Core's authorization answers 401 for "no access" too.
        if exc.status in (401, 403):
            raise ToolFailed(NO_PROJECT) from exc
        raise
    if not isinstance(reply, dict) or not isinstance(reply.get("document"), dict):
        raise ToolFailed("Core answered the style without its document.")
    return reply


class StyleGetInput(LayerInput):
    style_id: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "The style's id (style.id, or an id of style.others, from "
            "project_get_layers). Leave it out for the style the map draws."
        ),
    )
    part: str | None = Field(
        default=None,
        max_length=200,
        description=(
            "A JSON pointer to one part of the style, answered in full: e.g. "
            "/classify/density, /classify/density/classes, /symbol or /popup. A "
            "list item with an id is named by its id. Leave it out for the whole "
            "style in compact form."
        ),
    )


class FieldBrief(BaseModel):
    name: str
    #: The field's type from the layer's queryables; None when they could not
    #: be read.
    type: str | None = None


class StyleView(BaseModel):
    layer_project_id: int
    style_id: str
    name: str
    #: The map draws this style for the layer.
    active: bool
    revision: int
    #: Compact (``assistant.styles.view.compact``), or the part asked for in full.
    document: dict[str, Any]
    cut: list[CutList] = []
    issues: list[IssueView] = []
    legend: list[LegendNumbers] = []
    #: Set when legend numbers could not be read, or not all.
    legend_note: str | None = None
    #: The fields the style reads.
    fields: list[FieldBrief] = []
    #: Issues left out, or a check that could not run.
    note: str | None = None


async def _listed_or_refused(env: ToolEnv, args: LayerInput) -> _Layer | Exception:
    try:
        return await _listed_layer(env, args)
    except (ToolFailed, InputInvalid) as exc:
        return exc


def _classification(document: dict[str, Any], part: str | None) -> list[str] | None:
    """The classification a part lies in, as the pointer the legend numbers
    name it by; None for a part outside the classifications, or none."""
    if part is None:
        return None
    segments = parse_pointer(part)
    classify = document.get("classify")
    if len(segments) < 2 or segments[0] != "classify" or not isinstance(classify, list):
        return None
    index = find_index(classify, segments[1])
    if index is None:
        return None
    return [to_pointer(["classify", item_key(classify[index], index)])]


async def _field_briefs(
    env: ToolEnv, layer: _Layer | None, document: dict[str, Any]
) -> list[FieldBrief]:
    names = sorted(referenced_fields(document))
    kinds: dict[str, str] = {}
    if layer is not None and names:
        try:
            kinds = await _fields(env, layer)
        except (ToolFailed, KeyError, AttributeError, TypeError):
            kinds = {}
    return [FieldBrief(name=name, type=kinds.get(name)) for name in names]


async def _styled_layer(
    env: ToolEnv, project_id: UUID, link: int
) -> tuple[MapRead, dict[str, Any], _Layer | None]:
    """The project's map, the layer's row and the layer whose features the
    legend numbers count: None for a raster, which has a style but no
    features. A table, a locked layer and a layer still being copied are
    refused."""
    read, listed = await asyncio.gather(
        read_map(env, project_id),
        _listed_or_refused(
            env, LayerInput(project_id=project_id, layer_project_id=link)
        ),
    )
    row = read.rows.get(link) or {}
    if row.get("type") == "raster":
        # A raster has a style but no features to count: its data is not read.
        if row.get("locked"):
            name = str(row.get("name") or f"layer {link}")
            raise ToolFailed(
                f"{name!r} is in the project, but the user has no access to its data."
            )
        return read, row, None
    if isinstance(listed, Exception):
        raise listed
    if row.get("type") == "table":
        raise ToolFailed(NO_TABLE_STYLE)
    return read, row, listed


async def _get_style(env: ToolEnv, args: StyleGetInput) -> StyleView:
    project_id = _project_id(env, args.project_id)
    link = args.layer_project_id
    read, row, layer = await _styled_layer(env, project_id, link)
    style_id = args.style_id or read.active_style_id(link)
    if style_id is None:
        raise ToolFailed(NO_STYLE_YET)
    reply = await read_style(env, project_id, link, style_id, check=True)
    document: dict[str, Any] = reply["document"]
    shown, cuts = compact(document, args.part)
    raw_issues = [i for i in reply.get("issues") or [] if isinstance(i, dict)]
    issues = issue_views(raw_issues)
    query = row.get("query")
    query_cql = query.get("cql") if isinstance(query, dict) else None
    if layer is None:
        legend: tuple[list[LegendNumbers], str | None] = ([], None)
        fields = await _field_briefs(env, None, document)
    else:
        legend, fields = await asyncio.gather(
            legend_numbers(
                env, layer, query_cql, document, _classification(document, args.part)
            ),
            _field_briefs(env, layer, document),
        )
    notes = []
    if _skill_missing(env):
        notes.append(SKILL_FIRST)
    if reply.get("stale") is True:
        notes.append(NOT_CHECKED)
    if len(raw_issues) > len(issues):
        notes.append(
            f"{len(raw_issues) - len(issues)} more issues are not shown; errors "
            "come first, then warnings, then info."
        )
    active = read.active_style_id(link)
    return StyleView(
        layer_project_id=link,
        style_id=str(reply.get("id") or style_id),
        name=str(reply.get("name") or ""),
        active=active is not None
        and str(active).lower() == str(reply.get("id") or style_id).lower(),
        revision=int(reply.get("revision") or 0),
        document=shown,
        cut=cuts,
        issues=issues,
        legend=legend[0],
        legend_note=legend[1],
        fields=fields,
        note=" ".join(notes) or None,
    )


GET_STYLE: ToolSpec[StyleGetInput, StyleView] = ToolSpec(
    name="style.get",
    description=(
        "Read a layer's style; read it before changing it. Answers the GOAT Style "
        "document in compact form (computed values left out, class lists longer "
        "than 12 cut to their first 12 and listed in cut), its revision, whether "
        "the map draws it (active), the check's issues with their fixes, the "
        "fields it reads with their types, and the legend numbers: per "
        "classification, how many of the features the layer's saved filter keeps "
        "fall in each class, in no class (other) and have no value. part, a JSON "
        "pointer such as /classify/density or /popup, answers that part in full. "
        "Leave style_id out for the style the map draws."
    ),
    input_model=StyleGetInput,
    output_model=StyleView,
    run=_get_style,
    surfaces=STYLE_SURFACES,
)


# -- style.update -----------------------------------------------------------------

VIEWER_STYLES = "The user can view this project but not change it."
TOO_LARGE = "The style is larger than 1 MB. Make it smaller."
NOT_SAVED_NOW = "The style could not be saved right now. Try once more."
NOT_CHECKED_NOW = "The style could not be checked right now. Try once more."
CHECK_REFUSED = (
    "The style could not be checked, and the same call would be refused again. "
    "Nothing was saved."
)
NO_DATASET_DEFAULT = "This layer has no dataset default style the user can read."
NOT_THIS_LAYERS_STYLE = (
    "This style does not belong to the layer; its styles are: {styles}."
)
REPLACE_NEEDS_PICK = (
    "Replacing a style whole needs the user's pick in a card. Ask with ask_user: "
    "one single-select question with one option whose value is "
    "replace_style:{style_id} and one option that keeps the style as it is. "
    "Call style_update again once the user picked the replacement."
)
TOO_MANY_STYLES = (
    f"This layer has {MAX_STYLES} styles, the most a layer takes. Ask the user "
    "with ask_user which style to replace, in one single-select question: up "
    "to three styles as options that carry their value, and one option that "
    "keeps every style. The styles: "
    "{styles}. Then call style_update with that style_id, the whole document "
    "and name."
)
NO_REVISION = (
    "The style came without its revision, so it cannot be saved safely; nothing "
    "was changed. Try again in a moment."
)
NOTHING_CHANGED = "Nothing changed."
NOT_SAVED_PATHS = (
    "The paths in not_saved kept their stored values: the new values have "
    "errors there (see issues)."
)
CONTENT_NOT_SAVED = (
    "The style was created but its content could not be saved: {reason} It "
    "holds a copy of the current style."
)
NOT_RENAMED = "The style was saved but not renamed: {reason}"
NOT_MADE_ACTIVE = (
    "The style was saved but the layer still shows the style it showed before: "
    "{reason}"
)
SAVE_UNKNOWN = (
    "The save may have landed: core did not answer it, and reading the style "
    "afterwards could not tell. Read the style with style_get before you change "
    "it again; do not send the same change blindly."
)
CREATED_SAVE_UNKNOWN = (
    "The style was created, but whether its content was saved is not known: "
    "core did not answer the save, and reading the style afterwards could not "
    "tell. Read it with style_get before you change it again."
)
STOPPED = "An unexpected error stopped the call."
REPEATED_STYLE_EDIT = (
    "You made this style change earlier in this answer; this is its result again."
)
THIRD_CHANGE = (
    "This is the third style change of this layer in this answer: finish with "
    "this one unless an error is left."
)
MORE_CHANGES = (
    "This layer's style has changed {count} times in this answer: finish with "
    "this change unless an error is left."
)

ASKED_NOT_SAID = (
    "new_style.asked must quote the user's own words exactly as typed, and these "
    "are not in the conversation. If the user asked for a new style or for "
    "options, send the call again with their exact words; if not, edit the "
    "active style in place: send the operations without new_style."
)
SKILL_BEFORE_NEXT = (
    f"Load the skill {STYLE_SKILL} with skills_load before the next change: it "
    "holds the forms and the rules."
)
#: The fewest letters and digits a quote of the user's words holds.
MIN_ASKED_CHARS = 6
#: A run of anything but letters and digits: punctuation, quotation marks,
#: hyphens, apostrophes and whitespace.
_NOT_A_WORD = re.compile(r"[\W_]+")

_NEW: frozenset[Mode] = frozenset({"new_from", "new_whole"})


def _plain_words(text: str) -> str:
    """The words of ``text``: its letters and digits in NFKC form, case-folded,
    each run of anything else one space, framed by spaces."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return f" {_NOT_A_WORD.sub(' ', folded).strip()} "


def _user_said(env: ToolEnv, asked: str) -> bool:
    """Whether ``asked`` quotes whole words the user typed in this
    conversation, in their order, whatever stands between them; without the
    conversation's text (``typed`` None) only its length counts."""
    quote = _plain_words(asked)
    if len(quote.replace(" ", "")) < MIN_ASKED_CHARS:
        return False
    if env.typed is None:
        return True
    return any(quote in _plain_words(text) for text in env.typed)


def _canonical(style_id: Any) -> str:
    try:
        return str(UUID(str(style_id)))
    except ValueError:
        return str(style_id).lower()


def _styles_of(read: MapRead, link: int) -> dict[str, str]:
    """The layer's named styles, id to name, the drawn one first."""
    held = read.styles.get(link) or {}
    others = held.get("others")
    found: dict[str, str] = {}
    for style in (held.get("active"), *(others if isinstance(others, list) else [])):
        if isinstance(style, dict) and style.get("id") is not None:
            found[_canonical(style["id"])] = str(style.get("name") or "")
    return found


def _code(exc: ServiceError) -> str | None:
    detail = exc.body.get("detail") if isinstance(exc.body, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) else None


def _in_words(
    exc: ToolFailed, styles: dict[str, str], *, checking: bool = False
) -> str:
    """Core's refusal of a style write, or of the check before it
    (``checking``), in plain words; any other failure in its own."""
    if not isinstance(exc, ServiceError):
        return exc.message
    if sign_in_expired(exc):
        return SIGN_IN_EXPIRED
    code = _code(exc)
    if exc.status == 403 and code == "locked":
        return NO_LAYER_ACCESS
    if exc.status == 403 and code == "forbidden":
        return VIEWER_STYLES
    if exc.status == 409 and code == "too_many_styles":
        return _too_many(styles)
    if exc.status == 422 and code == "document_too_large":
        return TOO_LARGE
    if exc.status == 422 and code in ("newer_version", "unknown_version"):
        message = (exc.issues or [{}])[0].get("message")
        if isinstance(message, str) and message:
            return message
    if exc.status == 422 and code == "check_failed":
        return CHECK_REFUSED
    if exc.status == 503 and code in ("check_unavailable", "save_conflict"):
        return NOT_CHECKED_NOW if checking else NOT_SAVED_NOW
    return exc.message


def _offer_replacing(env: ToolEnv, styles: dict[str, str]) -> None:
    """Lets the answer's card offer to replace each of the layer's styles
    (``ToolEnv.confirm_values``)."""
    env.confirm_values.update(f"replace_style:{style_id}" for style_id in styles)


def _too_many(styles: dict[str, str]) -> str:
    offered = ", ".join(
        f"{name} (replace_style:{style_id})" for style_id, name in styles.items()
    )
    return TOO_MANY_STYLES.format(styles=offered)


class _SaveUnknown(ToolFailed):
    """A save got no answer, and reading the style afterwards could not tell
    whether it landed."""


#: The statuses a proxy in front of core answers when core's own answer is
#: lost; core's own refusals carry a code.
_GATEWAY = frozenset({502, 503, 504})


async def _saved(
    env: ToolEnv,
    project_id: UUID,
    link: int,
    style_id: str,
    base_rev: int,
    document: dict[str, Any],
    base: dict[str, Any] | None,
) -> dict[str, Any]:
    """Core's answer to a save of ``document`` on ``base_rev``, whose
    document was ``base`` (None when not read). A save without an answer
    (core did not answer in time, the connection dropped, a gateway error,
    or the answer came without the revision) may have landed all the same:
    core checks the document against the data, which can outlast the
    request. The style is then read once, without that check, and when its
    revision moved on and the paths the save changed hold its values, that
    read stands for the answer. Otherwise core may still be saving, so the
    outcome is not known."""
    try:
        return await edits.save_document(
            env, project_id, link, style_id, base_rev, document
        )
    except ServiceError as exc:
        if exc.status not in _GATEWAY or _code(exc) is not None:
            raise
        lost: ToolFailed = exc
    except ToolFailed as exc:
        lost = exc
    try:
        held = await read_style(env, project_id, link, style_id, check=False)
    except ToolFailed:
        raise _SaveUnknown(SAVE_UNKNOWN) from lost
    revision = edits.revision_of(held)
    if revision is not None and revision > base_rev:
        found = held["document"]
        if base is None:
            landed = await asyncio.to_thread(edits.holds, found, document)
        else:
            landed = await asyncio.to_thread(edits.holds_changes, found, document, base)
        if landed:
            return held
    raise _SaveUnknown(SAVE_UNKNOWN) from lost


@dataclass
class _Written:
    """What a call's writes have landed so far."""

    style_id: str
    name: str
    created: bool = False
    revision_before: int | None = None
    revision_after: int | None = None
    #: The document and the issues of core's answer to the save.
    stored: dict[str, Any] | None = None
    issues: list[Any] = field(default_factory=list)
    made_active: bool = False
    #: A write was answered: from here on the call returns.
    landed: bool = False
    #: The sentence that says what did not happen, should the write under
    #: way fail.
    failing: str = "{reason}"
    #: What did not happen of the steps the call went on past.
    missed: list[str] = field(default_factory=list)
    incomplete: str | None = None

    def saved(self, reply: dict[str, Any]) -> None:
        self.revision_after = edits.revision_of(reply)
        self.stored = reply["document"]
        issues = reply.get("issues")
        self.issues = issues if isinstance(issues, list) else []


async def _write(
    env: ToolEnv,
    args: StyleUpdateInput,
    mode: Mode,
    project_id: UUID,
    document: dict[str, Any],
    active_id: str,
    written: _Written,
    before: dict[str, Any] | None,
    styles: dict[str, str],
) -> None:
    """The call's writes in order: create, save, rename, make active. Each
    one that core answered is noted in ``written`` before the next starts.
    ``before``: the document the save is built on, for an edit or a replace.
    A failed rename stops nothing after it: it is noted in ``written``."""
    link = args.layer_project_id
    if args.new_style is not None:
        reply = await edits.create_style(
            env, project_id, link, args.new_style.name, active_id
        )
        written.style_id = _canonical(reply["id"])
        written.name = str(reply.get("name") or args.new_style.name)
        written.created = True
        written.revision_after = edits.revision_of(reply) or 1
        written.landed = True
        written.failing = CONTENT_NOT_SAVED
        written.saved(
            await _saved(
                env,
                project_id,
                link,
                written.style_id,
                written.revision_after,
                document,
                None,
            )
        )
    else:
        if written.revision_before is None:
            raise ToolFailed(NO_REVISION)
        written.saved(
            await _saved(
                env,
                project_id,
                link,
                written.style_id,
                written.revision_before,
                document,
                before,
            )
        )
        written.landed = True
        if args.name is not None and args.name != written.name:
            written.failing = NOT_RENAMED
            try:
                await edits.rename_style(
                    env, project_id, link, written.style_id, args.name
                )
                written.name = args.name
            except ToolFailed as exc:
                reason = edits.sentence(_in_words(exc, styles))
                written.missed.append(NOT_RENAMED.format(reason=reason))
    wanted = args.make_active if args.make_active is not None else mode != "edit"
    if wanted and written.style_id != active_id:
        written.failing = NOT_MADE_ACTIVE
        await edits.make_active(env, project_id, link, written.style_id)
        written.made_active = True
        written.landed = True


async def _update_style(env: ToolEnv, args: StyleUpdateInput) -> StyleUpdated:
    project_id = open_project(env)
    link = args.layer_project_id
    mode = args.mode()
    if args.new_style is not None and not _user_said(env, args.new_style.asked):
        raise ToolFailed(ASKED_NOT_SAID)
    read, row, layer = await _styled_layer(env, project_id, link)
    drawn = read.active_style_id(link)
    if drawn is None:
        raise ToolFailed(NO_STYLE_YET)
    active_id = _canonical(drawn)
    styles = _styles_of(read, link)
    styles.setdefault(active_id, "")
    # Before anything else: no call writes to a style of another layer.
    if args.style_id is not None and args.style_id not in styles:
        listed = ", ".join(f"{name} ({style_id})" for style_id, name in styles.items())
        raise ToolFailed(NOT_THIS_LAYERS_STYLE.format(styles=listed))
    target = args.style_id or active_id
    if mode == "replace" and not consented(env.asks, f"replace_style:{target}"):
        # The user's pick in a card of this request, read from the stored
        # conversation: never the model's word. The card may offer the value.
        env.confirm_values.add(f"replace_style:{target}")
        raise ToolFailed(REPLACE_NEEDS_PICK.format(style_id=target))
    if mode in _NEW and len(styles) >= MAX_STYLES:
        _offer_replacing(env, styles)
        raise ToolFailed(_too_many(styles))

    # The document the change starts from, and the issues it may keep.
    known: set[tuple[str, str]] = set()
    before: dict[str, Any] | None = None
    written = _Written(style_id=target, name=styles.get(target, ""))
    if mode == "new_from" and args.new_style is not None:
        start = args.new_style.start
        if start == "current":
            held = await read_style(env, project_id, link, active_id, check=True)
            base: dict[str, Any] = held["document"]
            known = edits.issue_keys(held.get("issues") or [])
        elif start == "dataset_default":
            try:
                base = await edits.dataset_default(env, str(row.get("layer_id")))
            except ServiceError as exc:
                if sign_in_expired(exc):
                    raise ToolFailed(SIGN_IN_EXPIRED) from exc
                if exc.status in (401, 403, 404):
                    raise ToolFailed(NO_DATASET_DEFAULT) from exc
                raise
        else:
            base = edits.empty_document(
                row.get("type"),
                row.get("feature_layer_geometry_type"),
                str(row.get("layer_id")),
            )
    elif mode in ("edit", "replace"):
        held = await read_style(env, project_id, link, target, check=mode == "edit")
        base = before = held["document"]
        if mode == "edit":
            known = edits.issue_keys(held.get("issues") or [])
        written.name = str(held.get("name") or written.name)
        written.revision_before = edits.revision_of(held)
        written.revision_after = written.revision_before
    else:
        base = {}
    name_before = written.name if mode in ("edit", "replace") else None

    added: dict[int, str] = {}
    own: list[str] = []
    if args.operations is not None:
        # Off the event loop: an edit copies the document once per operation.
        applied = await asyncio.to_thread(edits.edited, base, args.operations)
        document, added = applied.document, applied.added
        # A value the call writes is the call's own, also where the style
        # had an error before.
        own = edits.written_pointers(document, args.operations, added)
    elif args.document is not None:
        document = args.document
    else:
        document = base

    # The check runs on a style that exists: the target, or for a new style
    # the one the map draws.
    anchor = active_id if mode in _NEW else target
    try:
        found = await edits.check_document(env, project_id, link, anchor, document)
    except ToolFailed as exc:
        raise ToolFailed(_in_words(exc, styles, checking=True)) from exc
    new_errors = edits.added_errors(found, known, own)
    if new_errors:
        raise ToolFailed(
            edits.refusal(
                new_errors, "operations" if args.operations is not None else "document"
            )
        )

    def landed_record() -> dict[str, Any] | None:
        """The undo record of what landed so far, as the result gives it."""
        if not written.landed:
            return None
        return StyleUpdated(
            project_id=project_id,
            layer_project_id=link,
            style_id=written.style_id,
            name=written.name,
            created=written.created,
            active=written.made_active or written.style_id == active_id,
            made_active=written.made_active,
            revision_before=written.revision_before,
            revision_after=written.revision_after,
            before=before,
            name_before=name_before,
            active_before=active_id if written.made_active else None,
        ).undo()

    # A Stop or the answer's clock can end the call after a write landed.
    env.landed.keep(landed_record)
    try:
        await _write(
            env, args, mode, project_id, document, active_id, written, before, styles
        )
    except ToolFailed as exc:
        if not written.landed:
            if isinstance(exc, ServiceError) and _code(exc) == "too_many_styles":
                _offer_replacing(env, styles)
            raise ToolFailed(_in_words(exc, styles)) from exc
        if isinstance(exc, _SaveUnknown):
            written.incomplete = CREATED_SAVE_UNKNOWN
        else:
            reason = edits.sentence(_in_words(exc, styles))
            written.incomplete = written.failing.format(reason=reason)
    except Exception:
        if not written.landed:
            raise
        logger.exception("style_update stopped after a write landed")
        written.incomplete = written.failing.format(reason=STOPPED)
    # Every step that did not happen is named.
    written.incomplete = (
        " ".join([*written.missed, written.incomplete or ""]).strip() or None
    )

    changed: list[str] = []
    legend: tuple[list[LegendNumbers], str | None] = ([], None)
    try:
        if written.stored is not None and before is not None:
            changed = await asyncio.to_thread(
                edits.changed_pointers, before, written.stored
            )
        if written.stored is not None and layer is not None:
            pointers = (
                edits.touched_classifications(changed) if mode == "edit" else None
            )
            more = None
            if pointers is None:
                pointers, more = edits.first_classifications(written.stored)
            if pointers:
                query = row.get("query")
                numbers, said = await legend_numbers(
                    env,
                    layer,
                    query.get("cql") if isinstance(query, dict) else None,
                    written.stored,
                    pointers,
                )
                legend = (numbers, " ".join(filter(None, (said, more))) or None)
    except Exception:
        # The writes landed: what describes them never fails the call.
        logger.exception("style_update could not describe what it saved")
    shown, cut = edits.shown_changes(changed)
    not_saved = edits.kept_paths(written.issues, known, own)
    issues = edits.views(written.issues, known, own)
    moved = written.revision_after != written.revision_before
    renamed = name_before is not None and written.name != name_before
    notes = []
    if not (written.created or moved or renamed or written.made_active):
        notes.append(NOTHING_CHANGED)
    elif not written.created:
        # A style made for the user (a variant asked for) is no correction.
        count = env.style_changes.get(link, 0) + 1
        env.style_changes[link] = count
        if count == 3:
            notes.append(THIRD_CHANGE)
        elif count > 3:
            notes.append(MORE_CHANGES.format(count=count))
    if _skill_missing(env) and SKILL_BEFORE_NEXT not in env.notes_given:
        env.notes_given.add(SKILL_BEFORE_NEXT)
        notes.append(SKILL_BEFORE_NEXT)
    if not_saved:
        notes.append(NOT_SAVED_PATHS)
    if cut:
        notes.append(cut)
    listed_issues = [issue for issue in written.issues if isinstance(issue, dict)]
    if len(listed_issues) > MAX_ISSUES:
        notes.append(
            f"{len(listed_issues) - len(issues)} more issues are not shown; errors "
            "come first, then warnings, then info."
        )
    return StyleUpdated(
        project_id=project_id,
        layer_project_id=link,
        style_id=written.style_id,
        name=written.name,
        created=written.created,
        active=written.made_active or written.style_id == active_id,
        made_active=written.made_active,
        renamed=renamed,
        revision_before=written.revision_before,
        revision_after=written.revision_after,
        changed=shown,
        added=(
            {str(index): item for index, item in added.items()}
            if written.stored is not None
            else {}
        ),
        issues=issues,
        not_saved=not_saved,
        legend=legend[0],
        legend_note=legend[1],
        incomplete=written.incomplete,
        note=" ".join(notes) or None,
        before=before,
        name_before=name_before,
        active_before=active_id if written.made_active else None,
    )


UPDATE_STYLE: ToolSpec[StyleUpdateInput, StyleUpdated] = ToolSpec(
    name="style.update",
    description=(
        "Change a layer's style on the map, or create a new named style. One of "
        "four ways per call. Operations alone edit a style in place: the style "
        "the map draws, or the one style_id names. new_style with start "
        "creates a named style from a starting point, changed by operations or, "
        "without them, a plain copy. new_style with document creates a named "
        "style from a whole GOAT Style document. "
        "style_id with document replaces that style whole, which needs the "
        "user's pick in a card first. Always edit in place (operations alone), "
        "whatever the size of the change: the dock's undo button is the way "
        "back. Create a named style, or two or three variants, only when the "
        'user asks for one in words ("as a new style", "keep the current '
        'one", "give me two options"), quoted in new_style.asked; the current '
        "style then stays as it is. A "
        f"layer takes {MAX_STYLES} styles. Put every operation of a request into "
        "one call (each variant the user asked for is its own call); call again "
        "only to correct an error the first call returned or a lopsided legend, "
        "at most two corrections, then say what is left. "
        "Never write the class list of a "
        "computed method (quantile, equal_interval, natural_breaks and the "
        "like): write method and count, and the server computes the classes. "
        "Never set the colors of a computed classification class by class: set "
        "its palette (and reverse, count or method); a class's own color only "
        "when the user names that class. The result is checked "
        "before it is saved: an error the change adds is not saved and comes "
        "back with its path, the allowed values and its fix; errors the style "
        "had before, at paths the call does not write, do not stop the change. "
        "Answers with the revisions before "
        "and after, whether it renamed the style (renamed), the changed paths, "
        "the ids added items got (added, by the "
        "operation's index counting from 0), the issues left, the paths the "
        "server kept at their stored value (not_saved) and the legend numbers "
        "of the classifications the change touched. The legend numbers are the "
        "class counts (features per class, without a value, in no class) under "
        "the layer's saved filter: never count classes with "
        "project_count_features or project_group_statistics, and do not read "
        "the style back with style_get after a change that returned without an "
        "error. Read them to judge the result, and change the method or the "
        "classes when they are lopsided. Never answers the document. The user "
        "can take the change back with the dock's undo button."
    ),
    input_model=StyleUpdateInput,
    output_model=StyleUpdated,
    run=_update_style,
    surfaces=STYLE_SURFACES,
    risk="write",
    scope="goat:write",
    repeatable=REPEATED_STYLE_EDIT,
    # A read after the change shows the changed style, and the layers' style
    # briefs with it; an earlier change of the layer's styles made again
    # after this one is a new change, not a repeat.
    invalidates=frozenset({GET_STYLE.wire_name, GET_LAYERS.wire_name, "style_update"}),
    # Whichever of the layer's styles either call named.
    same=frozenset({"layer_project_id"}),
)

STYLE_TOOLS: tuple[ToolSpec[Any, Any], ...] = (CATALOG, GET_STYLE, UPDATE_STYLE)
"""The style tools of the map page."""
