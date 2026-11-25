"""``style_catalog``: the palettes, library icons and emoji a style refers to by
id, looked up by word in goatlib's catalogues (``goatlib.style.catalog``).

A record's text is its words: lower case, every run of characters other than
letters and digits read as a space, so ``bicycle_parked`` and ``travel_places``
are two words each. Every word of the query must start one of the record's
words; a word is never matched in its middle. An emoji in the query finds
itself by its code. ``queries`` runs several searches in one call. Icons
without a query, or with one that matches nothing, answer the whole library by
group, so one call is enough; so does an answer's second icon lookup, whatever
its query.
"""

import re
from functools import cache
from typing import Annotated, Any, Literal, Self

from goatlib.style.catalog import Palette, emoji, icon_groups, icon_names, palettes
from pydantic import BaseModel, ConfigDict, Field, model_validator

Kind = Literal["palettes", "icons", "emoji"]

MAX_RESULTS = 30
#: The searches one call takes, and the rows each of them answers: up to
#: ``FEW_SEARCHES`` searches answer ``MAX_PER_SEARCH`` rows each, more
#: answer ``MAX_PER_MANY`` each, so the answer stays small.
MAX_SEARCHES = 30
FEW_SEARCHES = 10
MAX_PER_SEARCH = 8
MAX_PER_MANY = 3
#: Fewer icons than this found by a query point to the whole list.
FEW_ICONS = 3
NOTHING_MATCHED = "Nothing matched. Search with English words, one or two at a time."
NOTHING_MATCHED_FILTERED = "Nothing matched. Or leave a filter out."
NO_PALETTE = "No palette has these properties. Leave one of the filters out."
FEW_RATED = "Only a few palettes are rated for colorblind safety."
ICON_ID = "An icon's id is goat:<name>."
ICONS_LISTED = f"Every library icon, by group. {ICON_ID}"
#: The note of an icon search that matched nothing, which answers the whole
#: library in its place.
NOTHING_MATCHED_ICONS = (
    'Nothing matched "{query}": this is the whole library by group. ' + ICON_ID
)
#: The note of an answer's second and later icon lookups, which answer the
#: whole library by group whatever their query.
ICONS_AGAIN = (
    "This answer looked up icons already, so here is the whole library by "
    "group: pick every icon you need from it, no further icon lookup is "
    f"needed. {ICON_ID}"
)
ALL_ICONS = (
    "call style_catalog once with kind icons and no query for the whole list "
    "instead of trying other words"
)
PASS_THE_EMOJI = "When the user named an emoji, pass the emoji itself as query."
SEARCHES_CUT = "Each search shows at most {rows} rows."
#: The note of icon searches of one call of which some matched nothing, which
#: answer the whole library once beside them.
SOME_MATCHED_NOTHING_ICONS = (
    "Nothing matched {queries}: the whole library by group follows, pick from "
    "it. " + ICON_ID
)
BOTH_QUERIES = "Pass query for one search or queries for several, not both."
QUERIES_NOT_PALETTES = (
    "queries is for icons and emoji; find palettes with query or palette_kind."
)
NOTHING_MATCHED_EMOJI = f"{NOTHING_MATCHED} {PASS_THE_EMOJI}"
PALETTES_CUT = (
    "Narrow the list with palette_kind (sequential, diverging or qualitative) "
    "or a palette's name as query."
)
_WORD = re.compile(r"[^\W_]+")
_VARIATION = "fe0f"


class CatalogInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Kind = Field(
        description=(
            "What to look up: palettes (color ramps and schemes, by id for a "
            "style's colors), icons (GOAT's library icons) or emoji."
        )
    )
    query: str | None = Field(
        default=None,
        max_length=60,
        description=(
            "English words, one or two at a time, e.g. 'bus' or 'park' for icons, "
            "'fire' for emoji. Every word must start a word of the record's name, "
            "group or keywords; an emoji the user named finds itself. Palettes "
            "are named by their source and colors (e.g. 'blues', 'viridis', "
            "'colorbrewer'); find them mostly with palette_kind. Leave it out "
            "for every library icon by group, or the first palettes or emoji."
        ),
    )
    queries: list[Annotated[str, Field(min_length=1, max_length=60)]] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_SEARCHES,
        description=(
            f"Icons and emoji only: several searches in one call, 1 to "
            f"{MAX_SEARCHES}, each read as query, e.g. ['restaurant', 'school', "
            "'park'] for an icon per kind. Each search answers its own rows: "
            f"{MAX_PER_SEARCH} each up to {FEW_SEARCHES} searches, "
            f"{MAX_PER_MANY} rows each beyond. Pass query or queries, not both."
        ),
    )
    palette_kind: Literal["sequential", "diverging", "qualitative"] | None = Field(
        default=None,
        description=(
            "Palettes only (ignored for icons and emoji): sequential for ordered "
            "values, diverging for values around a middle, qualitative for categories."
        ),
    )
    colorblind_safe: bool | None = Field(
        default=None,
        description=(
            "Palettes only (ignored for icons and emoji): true keeps the palettes "
            "rated colorblind safe, false those rated unsafe. Few palettes are "
            "rated; most have no rating and are left out by either value."
        ),
    )
    classes: int | None = Field(
        default=None,
        ge=2,
        le=12,
        description=(
            "Palettes only (ignored for icons and emoji): the number of classes "
            "to color. Each palette answers its scheme for that many classes "
            "where it has one, else its own colors; the row's classes says how "
            "many colors it answered."
        ),
    )

    @model_validator(mode="after")
    def _one_query_form(self) -> Self:
        if self.query is not None and self.queries is not None:
            raise ValueError(BOTH_QUERIES)
        if self.queries is not None and self.kind == "palettes":
            raise ValueError(QUERIES_NOT_PALETTES)
        return self


class IconGroup(BaseModel):
    group: str
    #: The icons' names; an icon's id is ``goat:<name>``.
    icons: list[str]


class Search(BaseModel):
    query: str
    #: The search's first rows (``MAX_PER_SEARCH``, or ``MAX_PER_MANY`` of
    #: more than ``FEW_SEARCHES`` searches), as ``CatalogResult.results``.
    results: list[dict[str, Any]]
    #: How many records matched.
    total: int


class CatalogResult(BaseModel):
    kind: Kind
    #: Palette ``{id, name, kind, colorblind_safe, colors}`` (and ``classes``
    #: when asked); icon ``{id: "goat:<name>", group}``; emoji
    #: ``{id: "emoji:<code>", name, group}``. At most ``MAX_RESULTS``; empty
    #: when ``groups`` lists the icons or ``searches`` answers the rows.
    results: list[dict[str, Any]]
    #: How many records matched; with ``groups``, how many icons they list;
    #: with ``searches`` alone, how many all searches matched.
    total: int
    #: Several searches (``queries``): each with its own rows.
    searches: list[Search] | None = None
    #: Icons without a query, with one that matched nothing (of several
    #: searches: any), or after the answer's first icon lookup: every library
    #: icon, in the picker's groups.
    groups: list[IconGroup] | None = None
    note: str | None = None


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _matches(query: list[str], words: list[str]) -> bool:
    return all(any(word.startswith(q) for word in words) for q in query)


def _position(query: list[str], name: list[str]) -> int:
    """Where the first query word starts a word of the name; after every name
    when it matched only the group or keywords."""
    if not query:
        return 0
    return next(
        (i for i, word in enumerate(name) if word.startswith(query[0])), len(name) + 1
    )


@cache
def _icon_groups() -> dict[str, list[str]]:
    """Each library icon's groups, in the picker's order."""
    found: dict[str, list[str]] = {}
    for group in icon_groups():
        for name in group["icons"]:
            found.setdefault(name, []).append(group["id"])
    return found


def _palette_row(palette: Palette, classes: int | None) -> dict[str, Any]:
    colors = palette.colors
    if classes is not None:
        colors = palette.variants.get(classes, colors)
    row: dict[str, Any] = {
        "id": palette.id,
        "name": palette.name,
        "kind": palette.kind,
        "colorblind_safe": palette.colorblind_safe,
        "colors": list(colors),
    }
    if classes is not None:
        row["classes"] = len(colors)
    return row


def _palettes(args: CatalogInput, query: list[str]) -> list[dict[str, Any]]:
    found = [
        p
        for p in palettes().values()
        if (args.palette_kind is None or p.kind == args.palette_kind)
        and (args.colorblind_safe is None or p.colorblind_safe is args.colorblind_safe)
        and _matches(query, _words(" ".join((p.id, p.name, p.group or ""))))
    ]
    found.sort(key=lambda p: (p.colorblind_safe is not True, p.id))
    return [_palette_row(p, args.classes) for p in found]


def _icons(query: list[str]) -> list[dict[str, Any]]:
    groups = _icon_groups()
    found: list[tuple[int, str, dict[str, Any]]] = []
    for name in icon_names():
        listed = groups.get(name, [])
        words = _words(name)
        if _matches(query, words + _words(" ".join(listed))):
            row = {"id": f"goat:{name}", "group": listed[0] if listed else None}
            found.append((_position(query, words), name.lower(), row))
    found.sort(key=lambda hit: hit[:2])
    return [row for *_, row in found]


def _code(parts: list[str]) -> str:
    return "-".join(part for part in parts if part != _VARIATION)


def _glyph(text: str) -> str | None:
    """The code of the emoji in a query, as the catalogue writes codes but
    without variation selectors; None for a query without one."""
    marks = [
        f"{ord(char):x}"
        for char in text
        if not char.isascii() and not char.isalnum() and not char.isspace()
    ]
    return _code(marks) or None


def _emoji(query: list[str], glyph: str | None = None) -> list[dict[str, Any]]:
    found: list[tuple[int, str, dict[str, Any]]] = []
    for record in emoji():
        name: str = record["name"]
        words = _words(name)
        text = _words(" ".join((record["group"], *record.get("keywords", ()))))
        if (
            _code(record["code"].split("-")) == glyph
            if glyph is not None
            else _matches(query, words + text)
        ):
            row = {
                "id": f"emoji:{record['code']}",
                "name": name,
                "group": record["group"],
            }
            found.append((_position(query, words), name, row))
    found.sort(key=lambda hit: hit[:2])
    return [row for *_, row in found]


def _found(args: CatalogInput, text: str) -> list[dict[str, Any]]:
    """Every row a search for ``text`` matches, in its order."""
    query = _words(text)
    if args.kind == "palettes":
        return _palettes(args, query)
    if args.kind == "icons":
        return _icons(query)
    # A query without words is read as the emoji it holds.
    return _emoji(query, None if query else _glyph(text))


def matches(args: CatalogInput) -> list[dict[str, Any]]:
    """Every row the search matches, in its order."""
    return _found(args, args.query or "")


def _empty_note(args: CatalogInput) -> str:
    """Why nothing matched: the query, the palette filters, or both."""
    if args.kind == "emoji":
        return NOTHING_MATCHED_EMOJI
    filtered = args.palette_kind is not None or args.colorblind_safe is not None
    if not filtered:
        return NOTHING_MATCHED
    if _words(args.query or ""):
        return NOTHING_MATCHED_FILTERED
    if args.colorblind_safe is not None:
        return f"{NO_PALETTE} {FEW_RATED}"
    return NO_PALETTE


_CUT: dict[Kind, str] = {
    "palettes": PALETTES_CUT,
    "icons": f"If none fits, {ALL_ICONS}.",
    "emoji": PASS_THE_EMOJI,
}


def _library(note: str = ICONS_LISTED) -> CatalogResult:
    groups = [
        IconGroup(group=group["id"], icons=list(group["icons"]))
        for group in icon_groups()
    ]
    return CatalogResult(
        kind="icons",
        results=[],
        total=sum(len(group.icons) for group in groups),
        groups=groups,
        note=note,
    )


def _searches(args: CatalogInput, queries: list[str]) -> CatalogResult:
    shown = MAX_PER_SEARCH if len(queries) <= FEW_SEARCHES else MAX_PER_MANY
    searches = []
    for text in queries:
        rows = _found(args, text)
        searches.append(
            Search(
                query=" ".join(text.split()),
                results=rows[:shown],
                total=len(rows),
            )
        )
    notes = []
    if any(found.total > shown for found in searches):
        notes.append(SEARCHES_CUT.format(rows=shown))
    missed = ", ".join(f'"{found.query}"' for found in searches if not found.total)
    library = None
    if missed and args.kind == "icons":
        # Replacements for the words that found nothing, without another call.
        library = _library(SOME_MATCHED_NOTHING_ICONS.format(queries=missed))
        notes.append(library.note or "")
    elif missed:
        notes.append(f"Nothing matched {missed}. {PASS_THE_EMOJI}")
    return CatalogResult(
        kind=args.kind,
        results=[],
        total=library.total if library else sum(found.total for found in searches),
        searches=searches,
        groups=library.groups if library else None,
        note=" ".join(notes) or None,
    )


def search(args: CatalogInput, *, again: bool = False) -> CatalogResult:
    """``again``: an icon lookup after the answer's first, which answers the
    whole library whatever its query or queries."""
    if args.kind == "icons" and again:
        return _library(ICONS_AGAIN)
    if args.queries is not None:
        return _searches(args, args.queries)
    if args.kind == "icons" and not _words(args.query or ""):
        return _library()
    rows = matches(args)
    if not rows and args.kind == "icons":
        # The next call would ask for the whole list: answer it now.
        query = " ".join((args.query or "").split())
        return _library(NOTHING_MATCHED_ICONS.format(query=query))
    note = None
    if not rows:
        note = _empty_note(args)
    elif len(rows) > MAX_RESULTS:
        note = f"Showing {MAX_RESULTS} of {len(rows)}. {_CUT[args.kind]}"
    elif args.kind == "icons" and len(rows) < FEW_ICONS:
        note = f"Few icons matched. If none fits, {ALL_ICONS}."
    return CatalogResult(
        kind=args.kind, results=rows[:MAX_RESULTS], total=len(rows), note=note
    )
