"""What an XPlanGML file only points at, written next to it.

- every code field gets a `<field>Wert` column with the code's name;
- `refTextInhalt` links become `refTextInhaltWert`, the linked clauses' text;
- every object gets the plan columns, so one feature says which plan it is from.

A code its version's list does not hold, or a field using a municipality's own
code list, gets no name: decoding never guesses.
"""

import pyarrow as pa

from goatlib.bundles.importers.xplan.schema import CodeList
from goatlib.models.bundle import XPLAN_PLAN_COLUMNS

_CODES = CodeList()

#: The plan field holding the date it took effect, by plan class.
_DATE_FIELDS = ("inkrafttretensDatum", "wirksamkeitsDatum", "datumDesInkrafttretens")


def _ids(value: object) -> list[str]:
    """The object ids a link column holds: `#A`, `#A,#B` or a list of them."""
    if value is None:
        return []
    values = value if isinstance(value, list) else str(value).split(",")
    return [v.strip().rsplit("#", 1)[-1] for v in values if v and v.strip()]


def _name(version: str | None, code_list: str, value: object) -> str | None:
    if value is None or version is None:
        return None
    if isinstance(value, list):
        names = [_CODES.name(version, code_list, str(v)) for v in value]
        names = [n for n in names if n]
        return "; ".join(names) if names else None
    return _CODES.name(version, code_list, str(value))


def _roman(value: object) -> str | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if not 0 < n < 40:
        return str(n)
    out = ""
    for amount, digit in ((10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= amount:
            out, n = out + digit, n - amount
    return out


def _number(value: object) -> str | None:
    """`0.6` as a plan writes it: `0,6`."""
    if value is None:
        return None
    return f"{float(value):g}".replace(".", ",")


def _label(version: str | None, cls: str, table: pa.Table) -> list[str | None]:
    """The label a printed plan writes into a building area: the kind of use
    (`M-MU`), GRZ and GFZ, the storeys (`III–V`) and the building style
    (`g`), each part only where the plan states it."""

    def shorts(field: str) -> list[str | None]:
        code_list = _CODES.field_list(version or "", cls, field)
        if code_list is None:
            return [None] * table.num_rows
        return [
            None if v is None else _CODES.short(version or "", code_list, str(v))
            for v in _column(table, field)
        ]

    rows = zip(
        shorts("allgArtDerBaulNutzung"),
        shorts("besondereArtDerBaulNutzung"),
        _column(table, "GRZ"),
        _column(table, "GFZ"),
        _column(table, "Z"),
        _column(table, "Zmin"),
        _column(table, "Zmax"),
        shorts("bauweise"),
    )
    labels = []
    for general, special, grz, gfz, z, zmin, zmax, style in rows:
        use = "-".join(p for p in (general, special) if p)
        measures = "  ".join(
            f"{name} {_number(v)}"
            for name, v in (("GRZ", grz), ("GFZ", gfz))
            if v is not None
        )
        storeys = _roman(z) or "–".join(p for p in (_roman(zmin), _roman(zmax)) if p)
        lines = [use, measures, "  ".join(p for p in (storeys, style) if p)]
        labels.append("\n".join(line for line in lines if line) or None)
    return labels


def _text(value: object) -> str | None:
    """A plan field as text, without the blanks a file has around a value;
    one with several values (the keys of a plan lying in several
    municipalities) joined like every other list."""
    if value is None:
        return None
    if isinstance(value, list):
        return "; ".join(str(v).strip() for v in value if v is not None) or None
    return str(value).strip() or None


def _with(table: pa.Table, name: str, values: list) -> pa.Table:
    return table.append_column(name, pa.array(values, type=pa.string()))


def _column(table: pa.Table, name: str) -> list:
    """One column's values, or Nones when the class has no such field."""
    if name in table.column_names:
        return table.column(name).to_pylist()
    return [None] * table.num_rows


def decorate(
    tables: dict[str, tuple[pa.Table, str | None]], version: str | None
) -> dict[str, tuple[pa.Table, str | None]]:
    # Read column by column, only the fields a meaning needs: a city-wide plan
    # holds tens of thousands of objects, too many to hold as Python rows.
    clauses: dict[str, str] = {}
    for cls, (table, _) in tables.items():
        if cls.endswith("TextAbschnitt"):
            ids, keys, texts = (
                _column(table, c) for c in ("gml_id", "schluessel", "text")
            )
            for gml_id, key, text in zip(ids, keys, texts):
                clauses[gml_id] = " | ".join(str(p) for p in (key, text) if p)

    plans: dict[str, tuple] = {}
    area_plan: dict[str, str] = {}
    for cls, (table, _) in tables.items():
        ids = _column(table, "gml_id")
        if cls.endswith("_Plan"):
            rechtsstand = _CODES.field_list(version or "", cls, "rechtsstand")
            dates = [_column(table, f) for f in _DATE_FIELDS]
            for n, (gml_id, name, state, ags, areas) in enumerate(
                zip(
                    ids,
                    _column(table, "name"),
                    _column(table, "rechtsstand"),
                    _column(table, "ags"),
                    _column(table, "bereich_href"),
                )
            ):
                plans[gml_id] = (
                    name,
                    cls,
                    version,
                    _name(version, rechtsstand, state) if rechtsstand else None,
                    next((str(d[n]) for d in dates if d[n]), None),
                    ags,
                )
                for area in _ids(areas):
                    area_plan.setdefault(area, gml_id)
        elif cls.endswith("_Bereich"):
            for gml_id, plan_ref in zip(ids, _column(table, "gehoertZuPlan_href")):
                for plan in _ids(plan_ref):
                    area_plan[gml_id] = plan
    only_plan = next(iter(plans)) if len(plans) == 1 else None
    no_plan = (None,) * len(XPLAN_PLAN_COLUMNS)

    out = {}
    for cls, (table, crs) in tables.items():
        ids = _column(table, "gml_id")
        for field, code_list in sorted(_CODES.fields(version or "", cls).items()):
            if field in table.column_names:
                table = _with(
                    table,
                    f"{field}Wert",
                    [_name(version, code_list, v) for v in _column(table, field)],
                )
        # One column for the kind of use, specific if the plan states it, else
        # general: plans stating only the general use are coloured by it too.
        if {"besondereArtDerBaulNutzungWert", "allgArtDerBaulNutzungWert"} & set(
            table.column_names
        ):
            table = _with(
                table,
                "artDerBaulNutzungWert",
                [
                    special or general
                    for special, general in zip(
                        _column(table, "besondereArtDerBaulNutzungWert"),
                        _column(table, "allgArtDerBaulNutzungWert"),
                    )
                ],
            )
            table = _with(table, "beschriftung", _label(version, cls, table))
        if "refTextInhalt_href" in table.column_names:
            table = _with(
                table,
                "refTextInhaltWert",
                [
                    "\n".join(clauses[i] for i in _ids(ref) if i in clauses) or None
                    for ref in _column(table, "refTextInhalt_href")
                ],
            )
        if cls.endswith("_Plan"):
            owners = ids
        elif cls.endswith("_Bereich"):
            owners = [area_plan.get(i) or only_plan for i in ids]
        else:
            owners = [
                next((area_plan[a] for a in _ids(ref) if a in area_plan), only_plan)
                for ref in _column(table, "gehoertZuBereich_href")
            ]
        values = [plans.get(owner, no_plan) for owner in owners]
        for n, column in enumerate(XPLAN_PLAN_COLUMNS):
            table = _with(table, column, [_text(v[n]) for v in values])
        out[cls] = (table, crs)
    return out
