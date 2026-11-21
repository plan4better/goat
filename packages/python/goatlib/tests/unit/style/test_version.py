import json
from importlib import resources

import pytest
from goatlib.style import version
from goatlib.style.parse import (
    check_version,
    parse,
    parse_for_write,
    parse_map_document,
)
from goatlib.style.upgrade import upgrade
from goatlib.style.validate import validate, validate_map
from goatlib.style.version import (
    BASE_VERSION,
    RELEASES,
    SPEC_VERSION,
    format_version,
    parse_version,
    required_version,
    schema_keys,
    stamped,
    used_keys,
)

from .conftest import load_examples

VALID = [e for e in load_examples() if not e["expect"] and e["target"] != "maplibre"]


def _parsed(doc: dict) -> object:
    model, issues = (
        parse_map_document(doc) if "kind" not in doc else parse_for_write(doc)
    )
    assert issues == [], issues
    return model


def test_parse_version_reads_semver_and_the_old_integer() -> None:
    assert parse_version("1.0.0") == (1, 0, 0)
    assert parse_version("12.3.45") == (12, 3, 45)
    assert parse_version("10.0.0") == (10, 0, 0)
    assert parse_version(1) == (1, 0, 0)
    for raw in ("1.0", "1", "1.0.0.0", "v1.0.0", " 1.0.0", "1.0.0-beta", 2, 0, True):
        assert parse_version(raw) is None, raw
    for raw in ("01.0.0", "1.00.0", "1.0.01", "\u0661.0.0"):
        assert parse_version(raw) is None, raw
    assert parse_version(None) is None
    assert format_version((1, 2, 3)) == "1.2.3"


def test_spec_and_base_versions() -> None:
    assert SPEC_VERSION == BASE_VERSION == "1.0.0"
    assert set(RELEASES) == {"1.0.0"}


def test_newer_minor_is_an_error_naming_versions_and_release() -> None:
    issues = check_version({"version": "1.1.0", "kind": "vector"})
    assert [(i.code, i.level, i.path) for i in issues] == [
        ("newer_version", "error", "/version")
    ]
    assert issues[0].message == (
        "This document needs GOAT Style 1.1.0 (a newer GOAT); "
        "this server reads up to 1.0.0."
    )


def test_newer_major_is_an_error() -> None:
    assert [i.code for i in check_version({"version": "2.0.0"})] == ["newer_version"]


def test_a_known_release_is_named(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(version, "RELEASES", {**RELEASES, "1.1.0": "GOAT 3.4 or newer"})
    (issue,) = check_version({"version": "1.1.0"})
    assert "1.1.0 (GOAT 3.4 or newer)" in issue.message


def test_newer_patch_is_a_warning_and_reading_goes_on(contexts: dict) -> None:
    doc = {"version": "1.0.1", "kind": "vector"}
    issues = check_version(doc)
    assert [(i.code, i.level) for i in issues] == [("newer_patch", "warning")]
    assert issues[0].message == (
        "This document is written for GOAT Style 1.0.1; this server reads up to "
        "1.0.0 and may draw small differences."
    )
    model, issues = parse_for_write(doc)
    assert model is not None
    assert [i.code for i in issues] == ["newer_patch"]
    assert [i.code for i in validate(doc, contexts["districts"])] == ["newer_patch"]


def test_newer_patch_map_document_is_read() -> None:
    from goatlib.style.context import MapContext

    doc = {"version": "1.0.1", "locale": "de-DE"}
    model, issues = parse_map_document(doc)
    assert model is not None and [i.code for i in issues] == ["newer_patch"]
    assert [i.code for i in validate_map(doc, MapContext(layers={}))] == ["newer_patch"]


def test_newer_minor_is_refused_before_the_rest_is_read(contexts: dict) -> None:
    doc = {"version": "1.1.0", "kind": "vector", "no_such_key": 1}
    assert parse_for_write(doc) == (None, check_version(doc))
    assert [i.code for i in validate(doc, contexts["districts"])] == ["newer_version"]


def test_unknown_versions() -> None:
    for raw in ("1", "1.0", "0.9.0", 2, True, None, 1.0):
        assert [i.code for i in check_version({"version": raw})] == [
            "unknown_version"
        ], raw
    assert [i.code for i in check_version({})] == ["missing_required"]


def test_major_0_has_its_own_message() -> None:
    (issue,) = check_version({"version": "0.9.0"})
    assert issue.code == "unknown_version"
    assert issue.message == "GOAT Style versions start at 1.0.0."


def test_integer_one_is_current() -> None:
    assert check_version({"version": 1, "kind": "vector"}) == []


def test_integer_one_upgrades_to_semver(contexts: dict) -> None:
    doc = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#ff0000"}}}
    for strict in (False, True):
        r = upgrade(doc, contexts["districts"], strict=strict)
        assert r.document == {**doc, "version": "1.0.0"}
        assert (r.lossy, r.version_from) == ((), 1)
    assert doc["version"] == 1


def test_a_strict_upgrade_of_integer_one_changes_nothing_else(contexts: dict) -> None:
    doc = {"version": 1, "kind": "raster", "render": {"type": "terrain"}}
    r = upgrade(doc, contexts["elevation"], strict=True)
    assert r.document == {**doc, "version": "1.0.0"}
    assert r.lossy == ()


def test_current_documents_are_returned_as_they_are(contexts: dict) -> None:
    doc = {"version": "1.0.0", "kind": "vector"}
    r = upgrade(doc, contexts["districts"])
    assert (r.document, r.version_from, r.lossy) == (doc, 1, ())
    assert upgrade(doc, contexts["districts"], strict=True).document is doc


def test_documents_not_read_come_back_as_they_are(contexts: dict) -> None:
    for raw in ("1.1.0", "2.0.0", "0.9.0", "x", 2):
        doc = {"version": raw, "kind": "vector"}
        r = upgrade(doc, contexts["districts"])
        assert (r.document, r.version_from, r.lossy) == (doc, -1, ()), raw


def test_version_0_converts_to_semver(contexts: dict) -> None:
    r = upgrade({"color": [1, 2, 3]}, contexts["districts"])
    assert (r.document["version"], r.version_from) == ("1.0.0", 0)


def test_the_model_takes_three_numbers_only() -> None:
    from goatlib.style.models.layer import LayerStyle

    assert parse(LayerStyle, {"version": "1.0.0", "kind": "vector"})[1] == []
    for raw in (1, "1.0", "1.0.0-beta", "01.0.0", "1.0.00"):
        _, issues = parse(LayerStyle, {"version": raw, "kind": "vector"})
        assert [i.path for i in issues] == ["/version"], raw


def test_required_version_is_base_for_every_current_key() -> None:
    assert VALID
    for ex in VALID:
        assert required_version(_parsed(ex["doc"])) == BASE_VERSION, ex["line"]


def test_required_version_takes_the_highest_since(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        version, "SINCE", {"RasterPopup.bands=all": "1.2.0", "View.mode": "1.1.0"}
    )
    raster = {"version": "1.0.0", "kind": "raster", "render": {"type": "image"}}
    with_all = {**raster, "popup": {"bands": "all"}}
    assert required_version(_parsed(with_all)) == "1.2.0"
    assert required_version(_parsed({**raster, "popup": {"bands": "styled"}})) == (
        "1.0.0"
    )
    assert required_version(_parsed(raster)) == "1.0.0"
    assert required_version(_parsed({"version": "1.0.0", "view": {"mode": "3d"}})) == (
        "1.1.0"
    )


def test_raster_popup_with_blocks_is_1_0_0() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "continuous", "domain": [0, 9]},
        "popup": {
            "trigger": "click_and_hover",
            "mode": "simple",
            "blocks": [{"type": "field_list", "attributes": [{"field": "value"}]}],
            "layout": "pinned",
            "anchor": "top_left",
            "width": 300,
            "max_height": 200,
            "header": "compact",
            "bands": "all",
        },
    }
    new = {
        "RasterPopup.blocks",
        "RasterPopup.trigger=click_and_hover",
        "RasterPopup.header=compact",
    }
    assert new <= used_keys(_parsed(doc))
    assert new <= schema_keys()
    assert required_version(_parsed(doc)) == "1.0.0"


def test_keys_left_at_their_default_do_not_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(version, "SINCE", {"Classification.reverse": "1.1.0"})
    classify = {"field": "land_use", "method": "categories"}
    doc = {"version": "1.0.0", "kind": "vector", "classify": [classify]}
    assert required_version(_parsed(doc)) == "1.0.0"
    doc = {**doc, "classify": [{**classify, "reverse": False}]}
    assert required_version(_parsed(doc)) == "1.1.0"


def test_stamped_is_a_copy_with_the_needed_version() -> None:
    doc = {"version": "1.0.1", "kind": "vector"}
    out = stamped(doc, _parsed({**doc, "version": "1.0.0"}))
    assert out == {"version": "1.0.0", "kind": "vector"}
    assert doc["version"] == "1.0.1"


def test_catalogue_ids_count_as_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    icons = {"zoom": [[10, "goat:airport"], [14, "emoji:1f525"]], "interpolate": "step"}
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"marker": {"shape": "icon", "icon": icons}},
        "classify": [
            {"field": "type", "method": "categories", "palette": "colorbrewer:BuGn"}
        ],
        "rules": [
            {
                "when": {"op": "isNull", "args": [{"property": "type"}]},
                "marker": {"icon": "asset:7f3a"},
            }
        ],
    }
    used = {k for k in used_keys(_parsed(doc)) if k.startswith("catalog.")}
    assert used == {
        "catalog.palettes=colorbrewer:BuGn",
        "catalog.icons=goat:airport",
        "catalog.icons=emoji:1f525",
    }
    assert used <= schema_keys()
    monkeypatch.setattr(version, "SINCE", {"catalog.icons=emoji:1f525": "1.3.0"})
    assert required_version(_parsed(doc)) == "1.3.0"


def test_values_in_mappings_count() -> None:
    badge = {"type": "badge", "field": "type", "labels": {"a": "Alpha"}}
    doc = {"version": "1.0.0", "kind": "vector", "popup": {"blocks": [badge]}}
    assert "BadgeBlock.labels=Alpha" in used_keys(_parsed(doc))


def test_used_keys_are_schema_keys() -> None:
    keys = schema_keys()
    used: set[str] = set()
    for ex in VALID:
        used |= {k for k in used_keys(_parsed(ex["doc"])) if "=" not in k}
    assert "ClassRecord.from" in used
    assert used <= keys, sorted(used - keys)


def test_schema_keys_name_properties_and_enum_values() -> None:
    keys = schema_keys()
    assert {
        "VectorStyle.version",
        "RasterPopup.bands",
        "RasterPopup.bands=all",
        "ImageRender.type=image",
        "VectorStyle.legend=false",
        "MapDocument.scene",
        "catalog.palettes=colorbrewer:BuGn",
        "catalog.icons=goat:airport",
        "catalog.icons=emoji:1f525",
    } <= keys
    assert not any(k.startswith("catalog.icons=asset:") for k in keys)


def test_every_schema_key_has_a_version() -> None:
    base = set(
        json.loads(
            resources.files("goatlib.style")
            .joinpath("data", "keys-1.0.0.json")
            .read_text()
        )
    )
    missing = schema_keys() - base - set(version.SINCE)
    # A new key, catalogue palette or library icon gets the version that adds
    # it in SINCE (spec 21); a version that is released never changes its keys file.
    assert not missing, sorted(missing)
    assert set(version.SINCE) <= schema_keys()
    spec = parse_version(SPEC_VERSION)
    for v in version.SINCE.values():
        parsed = parse_version(v)
        assert parsed is not None and isinstance(v, str) and parsed <= spec, v


def test_map_document_carries_the_same_version() -> None:
    model, issues = parse_map_document({"version": "1.0.0", "locale": "de-DE"})
    assert issues == [] and model.version == "1.0.0"
    assert [i.code for i in parse_map_document({"version": "1.1.0"})[1]] == [
        "newer_version"
    ]


def test_stamp_writes_the_lowest_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """The one stamp every writer uses: the lowest version the keys need, the
    integer 1 and a newer patch included; what goatlib cannot read keeps its
    own version."""
    monkeypatch.setattr(version, "SPEC_VERSION", "1.2.0")
    monkeypatch.setattr(version, "SINCE", {"VectorStyle.opacity": "1.2.0"})
    plain = {"version": "1.0.9", "kind": "vector"}
    assert version.stamp(plain) == {"version": "1.0.0", "kind": "vector"}
    assert plain["version"] == "1.0.9"
    assert version.stamp({"version": 1, "kind": "vector"})["version"] == "1.0.0"
    faded = {"version": "1.0.0", "kind": "vector", "opacity": 0.5}
    assert version.stamp(faded)["version"] == "1.2.0"
    unread = {"version": "1.0.0", "kind": "vector", "bogus": 1}
    assert version.stamp(unread) == unread
    newer = {"version": "1.9.0", "kind": "vector"}
    assert version.stamp(newer) == newer


def test_stamp_reads_a_map_document_as_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(version, "SPEC_VERSION", "1.2.0")
    monkeypatch.setattr(version, "SINCE", {"MapDocument.locale": "1.2.0"})
    doc = {"version": "1.2.0", "locale": "de-DE", "layers": []}
    assert version.stamp(doc, map_document=True)["version"] == "1.2.0"
    bare = {"version": "1.2.0", "layers": []}
    assert version.stamp(bare, map_document=True)["version"] == "1.0.0"
    assert version.stamp(bare) == bare  # not a layer style


def test_as_read_gives_the_integer_one_as_three_numbers() -> None:
    from goatlib.style.parse import as_read

    assert as_read({"version": 1, "kind": "vector"}) == {
        "version": "1.0.0",
        "kind": "vector",
    }
    for doc in ({"version": "1.0.0"}, {"version": 2}, {"kind": "vector"}, [1]):
        assert as_read(doc) == doc
