import pytest
from goatlib.style.issues import CODES, Issue, make_issue
from pydantic import ValidationError

SPEC_CODES = {  # GOAT Style spec, section 11, code table (code: default level)
    "unknown_key": "error",
    "missing_required": "error",
    "invalid_value": "error",
    "unknown_version": "error",
    "newer_version": "error",
    "geometry_mismatch": "error",
    "part_not_for_geometry": "error",
    "value_form_not_allowed": "error",
    "zoom_stops": "error",
    "zoom_needs_step": "error",
    "zoom_nesting": "error",
    "zoom_not_whole": "error",
    "zoom_range_invalid": "error",
    "override_not_per_feature": "error",
    "dash_on_point_outline": "error",
    "template_syntax": "error",
    "like_pattern_unsupported": "error",
    "unknown_field": "error",
    "field_type_mismatch": "error",
    "operator_type_mismatch": "error",
    "unknown_icon": "error",
    "unknown_palette": "error",
    "unknown_pattern": "error",
    "palette_too_short": "error",
    "classes_invalid": "error",
    "category_duplicate": "error",
    "range_invalid": "error",
    "domain_invalid": "error",
    "stops_order": "error",
    "render_not_for_geometry": "error",
    "render_type_mismatch": "error",
    "render_not_for_source": "error",
    "unknown_band": "error",
    "invalid_band_expression": "error",
    "too_many_features_for_render": "error",
    "not_supported_yet": "error",
    "classify_target_conflict": "warning",
    "classify_partial_overlap": "info",
    "classes_merged": "info",
    "no_values": "info",
    "classes_stale": "warning",
    "too_many_classes": "warning",
    "too_many_categories": "warning",
    "unknown_category": "warning",
    "domain_outside_data": "warning",
    "nothing_drawn": "warning",
    "palette_kind_mismatch": "warning",
    "mixed_icon_kinds": "info",
    "unclassified_values": "info",
    "low_opacity": "info",
    "unknown_layer": "error",
    "unknown_style": "error",
    "duplicate_layer": "error",
    "unknown_position": "error",
}


def test_codes_match_the_spec_table() -> None:
    assert CODES == SPEC_CODES


def test_make_issue_uses_the_default_level_and_rejects_unknown_codes() -> None:
    assert make_issue("zoom_stops", "/symbol/fill/opacity", "m").level == "error"
    assert make_issue("unknown_field", "/x", "m", level="damaged").level == "damaged"
    with pytest.raises(KeyError):
        make_issue("no_such_code", "/", "m")


def test_allowed_is_capped_at_20() -> None:
    with pytest.raises(ValidationError):
        Issue(
            level="error",
            code="invalid_value",
            path="/",
            message="m",
            allowed=list(range(21)),
        )
