"""Bounding-box columns are storage detail, not data.

GOAT writes one ``bbox`` struct into each GeoParquet file so that queries can
skip row groups. Data written by older versions carries renamed copies of it
(``bbox_1``, ``bbox_2``, …: a new ``bbox`` was appended beside an inherited
one), and GDAL writes its own covering column (``<geometry>_bbox``). Nobody
sets these, yet every tool carried them along like any other column, and they
showed up in field lists and join results.

Any STRUCT of exactly ``xmin``, ``ymin``, ``xmax``, ``ymax`` is one of them.
Where data is written, all but the canonical ``bbox`` are dropped.
"""

from collections.abc import Iterable, Sequence
from typing import Any

BBOX_COLUMN = "bbox"
_BBOX_FIELDS = ["xmax", "xmin", "ymax", "ymin"]


def is_bbox_struct(data_type: str) -> bool:
    """Whether a DuckDB type string is a ``STRUCT(xmin, ymin, xmax, ymax)``."""
    text = data_type.strip()
    if not text.upper().startswith("STRUCT(") or not text.endswith(")"):
        return False
    names = [field.split()[0].strip('"').lower() for field in _fields(text[7:-1])]
    return sorted(names) == _BBOX_FIELDS


def _fields(inner: str) -> list[str]:
    """Split a struct's field list at top-level commas (``DECIMAL(9,6)`` has one)."""
    fields, depth, start = [], 0, 0
    for i, char in enumerate(inner):
        depth += {"(": 1, ")": -1}.get(char, 0)
        if char == "," and depth == 0:
            fields.append(inner[start:i])
            start = i + 1
    fields.append(inner[start:])
    return [field.strip() for field in fields if field.strip()]


def stray_bbox_columns(columns: Iterable[Sequence[Any]]) -> list[str]:
    """Bounding-box columns other than ``bbox``, from ``DESCRIBE`` rows
    (column name first, type second)."""
    return [
        str(col[0])
        for col in columns
        if col[0] != BBOX_COLUMN and is_bbox_struct(str(col[1]))
    ]


def star_excluding(columns: Iterable[str]) -> str:
    """``*``, or ``* EXCLUDE (...)`` when there are columns to leave out."""
    names = list(columns)
    if not names:
        return "*"
    quoted = ", ".join('"' + name.replace('"', '""') + '"' for name in names)
    return f"* EXCLUDE ({quoted})"
