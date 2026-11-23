"""A read-only dry run of the version 0 converter over a GOAT database.

Converts every stored style of today's format (dataset defaults, project layers,
workflow export styles, locked print styles, published maps), validates the
results without field checks (the fields live in DuckLake), and writes a report:
what does not validate, what the conversion could not keep, and which library
icons the catalogue is missing. Nothing is written to the database.

    python -m goatlib.style.dryrun --dsn postgresql://... --out report.md
"""

import argparse
import asyncio
import collections
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from goatlib.style.catalog import icon_names
from goatlib.style.context import DataContext
from goatlib.style.convert_v0 import convert_v0
from goatlib.style.migrate import guess_geometry
from goatlib.style.validate import validate

EXAMPLES = 10


@dataclass(frozen=True)
class DryRunRow:
    place: str
    ref: str
    kind: str
    geometry: str | None
    source: str
    properties: Any


@dataclass
class DryRunReport:
    rows: dict[str, int] = field(default_factory=dict)
    with_errors: dict[str, int] = field(default_factory=dict)
    errors: dict[str, list[str]] = field(default_factory=dict)
    error_counts: dict[str, int] = field(default_factory=dict)
    lossy: dict[str, list[str]] = field(default_factory=dict)
    lossy_counts: dict[str, int] = field(default_factory=dict)
    lossy_notes: dict[str, str] = field(default_factory=dict)
    unknown_icons: dict[str, int] = field(default_factory=dict)
    exceptions: list[tuple[str, str, str]] = field(default_factory=list)

    def to_markdown(self, title: str) -> str:
        lines = [
            f"# GOAT Style dry run: {title}",
            "",
            f"Run at {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC.",
            "",
        ]
        lines += ["| Place | Rows | With errors |", "|---|---|---|"]
        for place, n in self.rows.items():
            lines.append(f"| {place} | {n} | {self.with_errors.get(place, 0)} |")
        lines += [
            "",
            f"Conversion or validation exceptions: {len(self.exceptions)}",
            "",
        ]
        lines += ["## Errors", "", "| Code | Count | Examples |", "|---|---|---|"]
        for code, n in sorted(self.error_counts.items(), key=lambda x: -x[1]):
            lines.append(f"| `{code}` | {n} | {', '.join(self.errors[code])} |")
        lines += [
            "",
            "## Not kept by the conversion",
            "",
            "| Key | Count | Note | Examples |",
            "|---|---|---|---|",
        ]
        for key, n in sorted(self.lossy_counts.items(), key=lambda x: -x[1]):
            lines.append(
                f"| `{key}` | {n} | {self.lossy_notes[key]} | {', '.join(self.lossy[key])} |"
            )
        lines += [
            "",
            "## Library icons missing from the catalogue",
            "",
            "| Icon | Uses |",
            "|---|---|",
        ]
        for name, n in sorted(self.unknown_icons.items(), key=lambda x: -x[1]):
            lines.append(f"| `{name}` | {n} |")
        if self.exceptions:
            lines += ["", "## Exceptions", ""] + [
                f"- {p}:{r}: {m}" for p, r, m in self.exceptions[:50]
            ]
        return "\n".join(lines) + "\n"


def _library_icons(node: Any) -> Iterable[str]:
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            stack.extend(n.values())
        elif isinstance(n, list):
            stack.extend(n)
        elif isinstance(n, str) and n.startswith("goat:"):
            yield n[5:]


def run(
    rows: Iterable[DryRunRow],
    *,
    asset_for_url: Callable[[str], str | None] | None = None,
) -> DryRunReport:
    report = DryRunReport()
    errors: dict[str, list[str]] = collections.defaultdict(list)
    error_counts: collections.Counter[str] = collections.Counter()
    lossy: dict[str, list[str]] = collections.defaultdict(list)
    lossy_counts: collections.Counter[str] = collections.Counter()
    icons: collections.Counter[str] = collections.Counter()
    library = icon_names()
    for row in rows:
        report.rows[row.place] = report.rows.get(row.place, 0) + 1
        ref = f"{row.place}:{row.ref}"
        source = row.source if row.source in ("wms", "wmts", "xyz") else "file"
        if row.kind == "raster":
            ctx = DataContext(kind="raster", source=source)  # type: ignore[arg-type]
        else:
            ctx = DataContext(kind="vector", geometry=row.geometry)  # type: ignore[arg-type]
        try:
            result = convert_v0(
                row.properties if isinstance(row.properties, dict) else {},
                ctx,
                asset_for_url=asset_for_url,
            )
            issues = validate(result.document, ctx)
        except Exception as exc:  # the report must cover every row
            report.exceptions.append(
                (row.place, row.ref, f"{type(exc).__name__}: {exc}")
            )
            continue
        for note in result.lossy:
            if note.key == "*":
                report.exceptions.append((row.place, row.ref, note.note))
            lossy_counts[note.key] += 1
            report.lossy_notes.setdefault(note.key, note.note)
            if len(lossy[note.key]) < EXAMPLES:
                lossy[note.key].append(ref)
        codes = {i.code for i in issues if i.level == "error"}
        if codes:
            report.with_errors[row.place] = report.with_errors.get(row.place, 0) + 1
        for code in codes:
            error_counts[code] += 1
            if len(errors[code]) < EXAMPLES:
                errors[code].append(ref)
        icons.update(
            name for name in _library_icons(result.document) if name not in library
        )
    report.errors, report.error_counts = dict(errors), dict(error_counts)
    report.lossy, report.lossy_counts = dict(lossy), dict(lossy_counts)
    report.unknown_icons = dict(icons)
    return report


_SERVICE = (
    "CASE WHEN l.data_type IN ('wms', 'wmts', 'xyz') THEN l.data_type ELSE 'file' END"
)
QUERIES = {
    "layer": f"""
        SELECT l.id::text AS ref, l.type AS kind, l.feature_layer_geometry_type AS geometry, {_SERVICE} AS source,
               l.properties
        FROM customer.layer l
        WHERE l.type IN ('feature', 'raster') AND jsonb_typeof(l.properties) = 'object'""",
    "layer_project": f"""
        SELECT lp.id::text AS ref, l.type AS kind, l.feature_layer_geometry_type AS geometry, {_SERVICE} AS source,
               lp.properties
        FROM customer.layer_project lp JOIN customer.layer l ON l.id = lp.layer_id
        WHERE l.type IN ('feature', 'raster') AND jsonb_typeof(lp.properties) = 'object'""",
    "workflow_output": """
        SELECT w.id::text || '/' || coalesce(n->>'id', '?') AS ref, 'feature' AS kind, NULL AS geometry,
               'file' AS source, n->'data'->'outputStyle' AS properties
        FROM customer.workflow w, jsonb_array_elements(w.config->'nodes') n
        WHERE jsonb_typeof(w.config->'nodes') = 'array' AND jsonb_typeof(n->'data'->'outputStyle') = 'object'""",
    "locked_print_style": f"""
        SELECT r.id::text || '/' || s.key AS ref, l.type AS kind, l.feature_layer_geometry_type AS geometry,
               {_SERVICE} AS source, s.value AS properties
        FROM customer.report_layout r,
             jsonb_path_query(r.config, 'strict $.**.locked_layer_styles') locked,
             jsonb_each(locked) s
        LEFT JOIN customer.layer_project lp ON lp.id::text = s.key
        LEFT JOIN customer.layer l ON l.id = lp.layer_id
        WHERE jsonb_typeof(locked) = 'object' AND jsonb_typeof(s.value) = 'object'""",
    "published_map": """
        SELECT p.project_id::text || '/' || coalesce(x->>'id', '?') AS ref, x->>'type' AS kind,
               x->>'feature_layer_geometry_type' AS geometry,
               CASE WHEN x->>'data_type' IN ('wms', 'wmts', 'xyz') THEN x->>'data_type' ELSE 'file' END AS source,
               x->'properties' AS properties
        FROM customer.project_public p, jsonb_array_elements(p.config->'layers') x
        WHERE jsonb_typeof(p.config->'layers') = 'array' AND x->>'type' IN ('feature', 'raster')
          AND jsonb_typeof(x->'properties') = 'object'""",
}


async def load(dsn: str, limit: int | None) -> tuple[list[DryRunRow], dict[str, str]]:
    import asyncpg

    conn = await asyncpg.connect(dsn)
    try:
        async with conn.transaction(readonly=True):
            rows: list[DryRunRow] = []
            for place, sql in QUERIES.items():
                query = sql + (f" LIMIT {int(limit)}" if limit else "")
                for r in await conn.fetch(query):
                    props = (
                        json.loads(r["properties"])
                        if isinstance(r["properties"], str)
                        else r["properties"]
                    )
                    geometry = (
                        r["geometry"]
                        if r["geometry"] in ("point", "line", "polygon")
                        else guess_geometry(props)
                    )
                    kind = "raster" if r["kind"] == "raster" else "vector"
                    rows.append(
                        DryRunRow(
                            place,
                            r["ref"],
                            kind,
                            geometry if kind == "vector" else None,
                            r["source"] or "file",
                            props,
                        )
                    )
            assets = {
                a["s3_key"]: str(a["id"])
                for a in await conn.fetch(
                    "SELECT id, s3_key FROM customer.uploaded_asset"
                )
            }
    finally:
        await conn.close()
    return rows, assets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args(argv)
    rows, assets = asyncio.run(load(args.dsn, args.limit))
    report = run(rows, asset_for_url=assets.get)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(report.to_markdown(args.title or args.dsn.rsplit("/", 1)[-1]))
    print(
        f"{sum(report.rows.values())} styles, {len(report.exceptions)} exceptions -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
