"""Issues: what validation reports about a GOAT Style document.

Every finding carries one of the codes of the specification's section 11, its
level, and a JSON pointer to the place in the document it is about. One message
text serves people and the AI.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Level = Literal["error", "warning", "info", "damaged"]

#: The specification's code table: code to default level. `damaged` is the level a
#: stored style gets when a later data change broke it (`unknown_field`,
#: `field_type_mismatch`); it is passed explicitly, never a default.
CODES: dict[str, Level] = {
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


class Fix(BaseModel):
    """One operation of the specification's closed fix list."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["set", "remove", "retarget", "use_field", "round"]
    path: str
    value: Any = None
    target: str | None = None
    field: str | None = None


class Issue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: Level
    code: str
    path: str
    message: str
    fix: Fix | None = None
    allowed: list[Any] | None = Field(default=None, max_length=20)


def make_issue(
    code: str,
    path: str,
    message: str,
    *,
    level: Level | None = None,
    fix: Fix | None = None,
    allowed: list[Any] | None = None,
) -> Issue:
    """An issue with the code's default level unless one is given."""
    default = CODES[code]
    return Issue(
        level=level or default,
        code=code,
        path=path,
        message=message,
        fix=fix,
        allowed=allowed[:20] if allowed is not None else None,
    )
