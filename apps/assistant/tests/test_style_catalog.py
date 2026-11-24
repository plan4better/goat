"""``style_catalog``: palettes, library icons and emoji looked up by word."""

import json
import re
import subprocess
import sys
from typing import Any

import pytest
from goatlib.style.catalog import Palette, emoji, icon_libraries, palettes
from pydantic import ValidationError

from assistant.styles import catalog
from assistant.styles.catalog import (
    ALL_ICONS,
    ICONS_LISTED,
    MAX_RESULTS,
    NOTHING_MATCHED,
    NOTHING_MATCHED_EMOJI,
    PASS_THE_EMOJI,
    CatalogInput,
    CatalogResult,
    search,
)
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.styles import CATALOG, STYLE_TOOLS
from assistant.tools.testing import fake_clients, tool_env


def _search(**kwargs: Any) -> CatalogResult:
    return search(CatalogInput(**kwargs))


def test_palettes_filter_by_kind_and_colorblind_safety() -> None:
    held = [
        p
        for p in palettes().values()
        if p.kind == "sequential" and p.colorblind_safe is True
    ]
    assert held, "the catalogue rates some sequential palettes colorblind safe"
    result = _search(kind="palettes", palette_kind="sequential", colorblind_safe=True)
    assert result.total == len(held)
    assert {row["id"] for row in result.results} == {p.id for p in held}
    for row in result.results:
        assert (row["kind"], row["colorblind_safe"]) == ("sequential", True)


#: A catalogue with one sequential palette and no rating, so every filter
#: below empties the answer whatever goatlib's catalogue holds.
_ONE_PALETTE = {
    "test:blues": Palette(
        id="test:blues",
        name="Blues",
        kind="sequential",
        colors=("#eff3ff", "#6baed6", "#08519c"),
        colorblind_safe=None,
        variants={},
    )
}


@pytest.mark.parametrize(
    ("args", "note"),
    [
        ({"query": "zzzqx"}, NOTHING_MATCHED),
        ({"query": "zzzqx", "classes": 3}, NOTHING_MATCHED),
        (
            {"palette_kind": "diverging"},
            "No palette has these properties. Leave one of the filters out.",
        ),
        (
            {"palette_kind": "sequential", "colorblind_safe": True},
            "No palette has these properties. Leave one of the filters out. "
            "Only a few palettes are rated for colorblind safety.",
        ),
        (
            {"colorblind_safe": False},
            "No palette has these properties. Leave one of the filters out. "
            "Only a few palettes are rated for colorblind safety.",
        ),
        (
            {"query": "blues", "palette_kind": "diverging"},
            "Nothing matched. Or leave a filter out.",
        ),
        (
            {"query": "zzzqx", "colorblind_safe": True},
            "Nothing matched. Or leave a filter out.",
        ),
    ],
    ids=str,
)
def test_the_note_of_an_empty_answer_names_what_emptied_it(
    monkeypatch: pytest.MonkeyPatch, args: dict[str, Any], note: str
) -> None:
    monkeypatch.setattr(catalog, "palettes", lambda: _ONE_PALETTE)
    result = _search(kind="palettes", **args)
    assert (result.results, result.total, result.note) == ([], 0, note)


def test_palette_filters_on_icons_leave_the_note_of_a_query() -> None:
    result = _search(kind="icons", query="zzzqx", palette_kind="diverging")
    assert result.note == (
        'Nothing matched "zzzqx": this is the whole library by group. '
        "An icon's id is goat:<name>."
    )


def test_an_icon_search_that_finds_nothing_answers_the_whole_library() -> None:
    """The model tried other words one call at a time after an empty
    search: the empty search answers the library itself, its note naming
    the query and the id rule."""
    result = _search(kind="icons", query="  train ")
    library = _search(kind="icons")
    assert (result.results, result.total, result.groups) == (
        [],
        library.total,
        library.groups,
    )
    assert result.note == (
        'Nothing matched "train": this is the whole library by group. '
        "An icon's id is goat:<name>."
    )
    # Emoji and palettes still answer an empty list.
    for kind in ("emoji", "palettes"):
        empty = _search(kind=kind, query="zzzqx")
        assert (empty.results, empty.total, empty.groups) == ([], 0, None), kind


def test_colorblind_safe_false_keeps_only_palettes_rated_unsafe() -> None:
    """A palette without a rating is not known to be unsafe."""
    held = {p.id for p in palettes().values() if p.colorblind_safe is False}
    result = _search(kind="palettes", colorblind_safe=False)
    assert result.total == len(held)
    assert {row["id"] for row in result.results} <= held


def test_palettes_come_colorblind_safe_first_then_by_id() -> None:
    held = sorted(
        palettes().values(), key=lambda p: (p.colorblind_safe is not True, p.id)
    )
    assert held[0].colorblind_safe is True and held[-1].colorblind_safe is not True
    rows = _all(kind="palettes")
    assert [row["id"] for row in rows] == [p.id for p in held]
    assert [row["id"] for row in _search(kind="palettes").results] == [
        p.id for p in held[:MAX_RESULTS]
    ]


def test_a_palette_row_has_the_contract_keys_and_the_stored_rating() -> None:
    result = _search(kind="palettes", query="ylgnbu")
    row = next(r for r in result.results if r["id"] == "colorbrewer:YlGnBu")
    assert set(row) == {"id", "name", "kind", "colorblind_safe", "colors"}
    assert row["colorblind_safe"] is palettes()["colorbrewer:YlGnBu"].colorblind_safe
    assert row["colors"] == list(palettes()["colorbrewer:YlGnBu"].colors)


def test_a_class_count_answers_that_many_colors_where_the_palette_has_them() -> None:
    with_variants = next(p for p in palettes().values() if 5 in p.variants)
    without = next(
        p for p in palettes().values() if not p.variants and len(p.colors) != 5
    )
    by_id = {
        row["id"]: row
        for row in _search(kind="palettes", classes=5, query=None).results
    }
    by_id |= {
        row["id"]: row
        for row in _search(kind="palettes", classes=5, query=with_variants.name).results
    }
    by_id |= {
        row["id"]: row
        for row in _search(kind="palettes", classes=5, query=without.name).results
    }
    row = by_id[with_variants.id]
    assert row["colors"] == list(with_variants.variants[5])
    assert row["classes"] == 5
    row = by_id[without.id]
    assert row["colors"] == list(without.colors)
    assert row["classes"] == len(without.colors)


def test_at_most_thirty_results_and_the_total_says_how_many_matched() -> None:
    result = _search(kind="palettes")
    assert MAX_RESULTS == 30
    assert len(result.results) == 30
    assert result.total == len(palettes())
    assert result.note == (
        f"Showing 30 of {len(palettes())}. Narrow the list with palette_kind "
        "(sequential, diverging or qualitative) or a palette's name as query."
    )


def test_icons_are_found_by_word_and_answer_goat_ids() -> None:
    result = _search(kind="icons", query="bus")
    assert {"id": "goat:bus", "group": "transportation_vehicles"} in result.results
    assert result.results[0]["id"] == "goat:bus"
    assert result.total == len(result.results)


def test_icon_names_read_hyphens_and_underscores_as_spaces() -> None:
    parked = _search(kind="icons", query="parked").results
    assert "goat:bicycle_parked" in {row["id"] for row in parked}
    gallery = _search(kind="icons", query="art gallery").results
    assert [row["id"] for row in gallery] == ["goat:art-gallery"]


def test_a_query_word_matches_a_whole_word_or_its_start_never_its_middle() -> None:
    names = {row["id"] for row in _search(kind="icons", query="bicycle").results}
    assert {"goat:bicycle", "goat:bicycle-share", "goat:bicycle_parked"} <= names
    prefix = {row["id"] for row in _search(kind="icons", query="bicy").results}
    assert "goat:bicycle" in prefix
    assert "goat:bus" not in {
        row["id"] for row in _search(kind="icons", query="us").results
    }


def test_icons_whose_group_matched_come_after_those_whose_name_matched() -> None:
    result = _search(kind="icons", query="transportation")
    assert result.total == len(
        next(g for g in _icon_groups() if g["id"] == "transportation_vehicles")["icons"]
    )
    by_name = _search(kind="icons", query="shop").results
    hits = ["shop" in row["id"] for row in by_name]
    assert hits == sorted(hits, reverse=True)


def _icon_groups() -> list[dict[str, Any]]:
    from goatlib.style.catalog import icon_groups

    return icon_groups()


def test_emoji_are_found_by_keyword() -> None:
    def words(text: str) -> list[str]:
        return re.findall(r"[^\W_]+", text.lower())

    # A keyword word that starts no word of the emoji's name or group.
    record, word = next(
        (e, w)
        for e in emoji()
        for k in e["keywords"]
        for w in words(k)
        if not any(n.startswith(w) for n in words(f"{e['name']} {e['group']}"))
    )
    result = _search(kind="emoji", query=word)
    ids = {row["id"] for row in _all(kind="emoji", query=word)}
    assert f"emoji:{record['code']}" in ids
    row = result.results[0]
    assert set(row) == {"id", "name", "group"}


def test_emoji_rows_name_their_group_and_name_hits_come_first() -> None:
    result = _search(kind="emoji", query="fire")
    first = result.results[0]
    assert first["id"].startswith("emoji:")
    assert "fire" in first["name"]
    fire = next(e for e in emoji() if e["name"] == "fire")
    assert {"id": f"emoji:{fire['code']}", "name": "fire", "group": fire["group"]} in (
        result.results
    )


def _all(**kwargs: Any) -> list[dict[str, Any]]:
    """Every row a search matches, past the 30 shown."""
    return catalog.matches(CatalogInput(**kwargs))


@pytest.mark.parametrize(
    "args",
    [
        {"kind": "palettes"},
        {"kind": "palettes", "classes": 3},
        {"kind": "icons"},
        {"kind": "icons", "query": "shop"},
        {"kind": "emoji"},
        {"kind": "emoji", "query": "face"},
    ],
    ids=str,
)
def test_every_answered_id_is_one_the_validator_accepts(args: dict[str, Any]) -> None:
    libraries = icon_libraries()
    for row in _all(**args):
        library, _, name = row["id"].partition(":")
        if args["kind"] == "palettes":
            assert row["id"] in palettes()
        else:
            assert library == {"icons": "goat", "emoji": "emoji"}[args["kind"]]
            assert name in libraries[library], row["id"]


def test_no_match_answers_an_empty_list_with_a_note_to_search_in_english() -> None:
    result = _search(kind="palettes", query="zzzqx")
    assert (result.results, result.total) == ([], 0)
    assert result.note == NOTHING_MATCHED
    assert NOTHING_MATCHED == (
        "Nothing matched. Search with English words, one or two at a time."
    )


def test_a_blank_query_is_no_query() -> None:
    assert _search(kind="icons", query="  ") == _search(kind="icons")


def test_palette_filters_are_ignored_for_icons_and_emoji() -> None:
    plain = _search(kind="icons", query="bus")
    filtered = _search(
        kind="icons",
        query="bus",
        classes=5,
        palette_kind="diverging",
        colorblind_safe=True,
    )
    assert filtered == plain


@pytest.mark.parametrize(
    "args",
    [
        {"kind": "palettes", "classes": 1},
        {"kind": "palettes", "classes": 13},
        {"kind": "icons", "query": "x" * 61},
        {"kind": "colors"},
        {"kind": "icons", "extra": 1},
    ],
    ids=str,
)
def test_out_of_range_arguments_are_refused(args: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        CatalogInput(**args)


def test_the_largest_answer_stays_small() -> None:
    """The 30 largest rows any search could answer, of each kind."""

    def size(row: dict[str, Any]) -> int:
        return len(json.dumps(row, separators=(",", ":"), ensure_ascii=False).encode())

    for args in (
        {"kind": "palettes"},
        {"kind": "palettes", "classes": 12},
        {"kind": "icons", "query": "solid"},
        {"kind": "emoji"},
    ):
        rows = sorted((size(r) for r in _all(**args)), reverse=True)[:MAX_RESULTS]
        assert sum(rows) + 500 < 20_000, args


def _size(result: CatalogResult) -> int:
    payload = result.model_dump(mode="json", exclude_none=True)
    return len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())


def test_icons_without_a_query_answer_the_whole_library_by_group() -> None:
    result = _search(kind="icons")
    library = icon_libraries()["goat"]
    assert result.groups is not None and result.results == []
    listed = [name for group in result.groups for name in group.icons]
    assert sorted(listed) == sorted(library) and len(listed) == len(set(listed))
    assert result.total == len(library)
    assert [g.group for g in result.groups] == [g["id"] for g in _icon_groups()]
    assert result.note == ICONS_LISTED
    assert "goat:<name>" in ICONS_LISTED and "Narrow" not in ICONS_LISTED
    # Names only: the id prefix is said once, in the note.
    assert not any(name.startswith("goat:") for name in listed)
    assert _size(result) < 4_500


def test_the_other_kinds_answer_no_groups() -> None:
    for args in (
        {"kind": "palettes"},
        {"kind": "emoji"},
        {"kind": "icons", "query": "bus"},
    ):
        payload = _search(**args).model_dump(mode="json", exclude_none=True)
        assert "groups" not in payload, args


@pytest.mark.parametrize(
    ("query", "note"),
    [
        ("bus", f"Few icons matched. If none fits, {ALL_ICONS}."),
        ("solid", f"Showing 30 of {{total}}. If none fits, {ALL_ICONS}."),
    ],
    ids=str,
)
def test_an_icon_search_that_finds_little_points_to_the_whole_list(
    query: str, note: str
) -> None:
    result = _search(kind="icons", query=query)
    assert result.note == note.format(total=result.total)
    assert "no query" in ALL_ICONS and "instead of trying other words" in ALL_ICONS


def test_an_icon_search_that_finds_enough_has_no_note() -> None:
    result = _search(kind="icons", query="bicycle")
    assert 3 <= result.total <= MAX_RESULTS and result.note is None


def test_an_emoji_is_found_by_itself() -> None:
    trolley = _search(kind="emoji", query="\U0001f6d2")
    assert [row["id"] for row in trolley.results] == ["emoji:1f6d2"]
    # A variation selector on either side does not matter.
    bags = _search(kind="emoji", query="\U0001f6cd")
    assert [row["id"] for row in bags.results] == ["emoji:1f6cd-fe0f"]
    assert _search(kind="emoji", query="\U0001f6d2\ufe0f").results == trolley.results
    # Words with typographic marks are read as words, not as an emoji.
    assert _search(kind="emoji", query="fire\u2019s") == _search(
        kind="emoji", query="fire s"
    )


def test_an_empty_or_cut_emoji_search_says_to_pass_the_emoji() -> None:
    empty = _search(kind="emoji", query="zzzqx")
    assert empty.note == NOTHING_MATCHED_EMOJI
    cut = _search(kind="emoji", query="face")
    assert cut.total > MAX_RESULTS
    assert cut.note == f"Showing 30 of {cut.total}. {PASS_THE_EMOJI}"
    for note in (empty.note, cut.note):
        assert "the emoji itself" in note


def test_the_description_says_one_call_is_enough() -> None:
    description = " ".join(CATALOG.description.split())
    assert "One call is enough" in description
    assert (
        "icons without a query, or with one that matches nothing, lists all of "
        "them by group" in description
    )


def test_the_tool_is_a_read_on_the_map_page_only() -> None:
    assert CATALOG in STYLE_TOOLS
    assert BY_WIRE_NAME["style_catalog"] is CATALOG
    assert (CATALOG.risk, CATALOG.scope, CATALOG.mcp) == ("read", "goat:read", False)
    assert CATALOG.surfaces == frozenset({"project.map"})
    properties = CATALOG.json_schema()["properties"]
    assert set(properties) == {
        "kind",
        "query",
        "palette_kind",
        "colorblind_safe",
        "classes",
    }
    for name, schema in properties.items():
        assert schema.get("description"), name


async def test_the_tool_answers_what_search_answers() -> None:
    env = tool_env(fake_clients())
    args = CatalogInput(kind="icons", query="bus")
    assert await CATALOG.run(env, args) == search(args)


def test_the_search_loads_no_data_libraries() -> None:
    code = (
        "import sys, assistant.styles.catalog, assistant.tools.styles;"
        "print(sorted({'duckdb', 'numpy', 'shapely'} & set(sys.modules)))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert out.stdout.strip() == "[]"
