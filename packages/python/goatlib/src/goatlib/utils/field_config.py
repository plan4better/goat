"""A layer's `field_config`: what each column means beyond its storage type.

Kept here rather than in a service because several writers use it — geoapi when
a column is added to a layer that already exists or a row is edited by hand,
the layer-create tool when a layer is declared with its columns up front, and
finalize_layer when a workflow's "Save as dataset" adds rows to an existing
dataset. A column created or filled either way has to mean the same thing
afterwards, so the rules for building an entry and the ones a tool needs to
write rows (computed, locked and default columns, allowed values) live in one
place. Checks only geoapi's hand edits run stay in geoapi.
"""

from typing import Any

from goatlib.computed_columns import COMPUTED_KIND_REGISTRY


def coerce_allowed_values(kind: str | None, values: list[Any]) -> list[Any]:
    """The vocabulary as the column's own type, or a ValueError naming the culprit.

    A number column holding the string "30" would never match the 30 a write
    sends, so the dropdown would offer a value that then fails validation. The
    list is coerced once, here, rather than compared loosely everywhere.
    """
    if kind not in ("number", "integer"):
        return [str(v) for v in values]
    coerced: list[Any] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError(
                f"'{value}' is not a number, so it cannot be an allowed value "
                "for a number column."
            ) from None
        coerced.append(int(number) if number.is_integer() else number)
    return coerced


class ComputedColumnSpec:
    """A computed column on a layer: name + dependency-set + compute SQL."""

    __slots__ = ("name", "depends_on", "compute_sql")

    def __init__(
        self,
        name: str,
        depends_on: tuple[str, ...],
        compute_sql: str,
    ) -> None:
        self.name = name
        self.depends_on = depends_on
        self.compute_sql = compute_sql


# Sentinel dependency meaning "recompute on any change to the row".
DEPENDS_ON_ANY = "*"


def parse_computed_columns(
    field_config: dict[str, Any] | None,
    geom_column: str = "geometry",
) -> list[ComputedColumnSpec]:
    """Convert a layer's `field_config` JSONB into a list of specs."""
    specs: list[ComputedColumnSpec] = []
    for name, entry in (field_config or {}).items():
        if not entry.get("is_computed"):
            continue
        kind_name = entry.get("kind")
        if kind_name == "formula":
            # Formula columns carry their own expression. The expression was
            # validated (function whitelist, column existence, no subqueries)
            # when it was stored; parenthesize so it splices safely into a
            # SET clause.
            formula_sql = entry.get("formula")
            if not formula_sql:
                continue
            specs.append(
                ComputedColumnSpec(
                    name=name,
                    depends_on=tuple(entry.get("depends_on") or (DEPENDS_ON_ANY,)),
                    compute_sql=f"({formula_sql})",
                )
            )
            continue
        kind = COMPUTED_KIND_REGISTRY.get(kind_name) if kind_name else None
        if kind is None:
            # Unknown kind (e.g. JSONB written by a newer release).
            # Skip — we can't safely generate SQL for it.
            continue
        specs.append(
            ComputedColumnSpec(
                name=name,
                depends_on=tuple(entry.get("depends_on", kind.depends_on)),
                compute_sql=kind.compute_sql(geom_column),
            )
        )
    return specs


def locked_column_names(field_config: dict[str, Any] | None) -> set[str]:
    """Columns whose owner maintains them, so no write may set them.

    Separate from a computed column, which this service also excludes from
    writes but can regenerate from its own formula. A locked column's value
    comes from somewhere the layer cannot express — a street network's edge
    endpoints are resolved against its nodes layer by the bundle editor — so
    there is nothing to recompute here, only something to refuse to overwrite.
    """
    return {
        name
        for name, entry in (field_config or {}).items()
        if isinstance(entry, dict) and entry.get("is_locked")
    }


def allowed_value_columns(
    field_config: dict[str, Any] | None,
) -> dict[str, list[Any]]:
    """Columns constrained to a vocabulary -> the values a write may set.

    Only columns that actually enforce one: an entry with ``allow_other`` true
    still carries its list, because an editor should offer it as suggestions,
    but a write is not refused for going outside it.
    """
    constrained: dict[str, list[Any]] = {}
    for name, entry in (field_config or {}).items():
        if not isinstance(entry, dict) or entry.get("allow_other"):
            continue
        values = entry.get("allowed_values")
        if isinstance(values, list) and values:
            constrained[name] = values
    return constrained


def column_defaults(field_config: dict[str, Any] | None) -> dict[str, Any]:
    """Columns that supply a value when a new feature leaves them blank."""
    return {
        name: entry["default_value"]
        for name, entry in (field_config or {}).items()
        if isinstance(entry, dict) and entry.get("default_value") is not None
    }
