"""The mirror goat-data publishes, read in place over S3 for one area.

The parquet is pruned by row group, so a city-sized area touches a few megabytes
of a multi-gigabyte file and nothing is downloaded. What differs between OSM and
Overture is in `Source`; the rest is written once.
"""

import json
import logging
import os
import threading
from dataclasses import dataclass
from typing import Any

from cachetools import TTLCache

from goatlib.io.fetch.mirror.osm import (
    FEATURE_TYPES,
    OSM_LICENCE,
    _quote,
)
from goatlib.io.fetch.mirror.overture import (
    MIXED_THEMES,
    OVERTURE_FIELDS,
    OVERTURE_LICENCES,
    OVERTURE_OSM_LICENCE,
    OVERTURE_TYPES,
)
from goatlib.storage.ducklake import load_extensions
from goatlib.storage.s3_config import apply_duckdb_s3_settings, duckdb_s3_endpoint

logger = logging.getLogger(__name__)


#: goat-data publishes the mirror beside the catalog, in the catalog bucket.
#: No catalog bucket (Windmill hands an unset one on as "") means no mirror.
CATALOG_BUCKET = (os.environ.get("CATALOG_S3_BUCKET") or "").strip()
MIRROR_URI = f"s3://{CATALOG_BUCKET}/mirror/osm" if CATALOG_BUCKET else ""
OVERTURE_MIRROR_URI = f"s3://{CATALOG_BUCKET}/mirror/overture" if CATALOG_BUCKET else ""

#: Above this the extract fails rather than writing a layer cut at an arbitrary row.
MAX_FEATURES = 1_000_000


#: Above this many features in the area a fetch is refused, whatever its filters.
MAX_READ_FEATURES = 5_000_000
#: Above this much compressed geometry in the area too: unpacked it would not fit
#: a job's memory (one country's divisions: 86 MB).
MAX_READ_BYTES = 100_000_000
#: Above this many features in the row groups an area touches, no filter makes it fit:
#: filters only shorten the result, and the read alone would be a continent's worth.
MAX_FILTERED_READ_FEATURES = 50_000_000


#: A GOAT layer holds one geometry type, and a base type mixes them (water has
#: lakes and rivers), so each option keeps the rows of its own.
GEOMETRY_TYPES: dict[str, tuple[str, ...]] = {
    "point": ("POINT", "MULTIPOINT"),
    "line": ("LINESTRING", "MULTILINESTRING"),
    "polygon": ("POLYGON", "MULTIPOLYGON"),
}


@dataclass(frozen=True)
class Source:
    """What differs between the mirrors, in one place.

    Everything else -- coverage, clipping, dedup, the picker -- is written once
    against this rather than branching on the source name.
    """

    mirror: str
    #: Geometry column. GDAL writes `geom`, Overture publishes `geometry`.
    geom: str
    #: Stable feature id, for dropping a feature two extracts both carry.
    id_column: str
    #: Whether attributes live in one hstore string rather than in columns.
    tagged: bool

    def unit_of(self, type_key: str) -> str | None:
        """The pointer unit holding a type: any continent for OSM, one theme for Overture."""
        return None if self.tagged else OVERTURE_TYPES[type_key][0].split("/")[0]

    def layer_of(self, type_key: str) -> str:
        return type_key if self.tagged else OVERTURE_TYPES[type_key][0].split("/")[1]

    def split_layer_of(self, type_key: str) -> str | None:
        """The layer holding only this option's geometry, where the mirror splits one.

        The base theme mixes geometries in a type, so the mirror writes each as its
        own layer -- ``water_polygon``, ``water_line`` -- and nothing has to read a
        geometry to tell them apart.
        """
        if self.tagged or self.unit_of(type_key) not in MIXED_THEMES:
            return None
        return f"{self.layer_of(type_key)}_{self.geometry_of(type_key)}"

    def geometry_filter(self, type_key: str, files: list[str] | None = None) -> str:
        """SQL keeping only this option's geometry type.

        Only where a type mixes them: OSM layers and most Overture types hold one
        already, and the test reads the geometry column, the largest in the file.
        Files of a split layer hold one geometry too.
        """
        if self.tagged or self.unit_of(type_key) not in MIXED_THEMES:
            return "TRUE"
        split = self.split_layer_of(type_key)
        if files and all(f.endswith(f"/{split}.parquet") for f in files):
            return "TRUE"
        kinds = ", ".join(f"'{k}'" for k in GEOMETRY_TYPES[self.geometry_of(type_key)])
        return f'ST_GeometryType("{self.geom}")::VARCHAR IN ({kinds})'

    def licence_of(self, type_key: str) -> tuple[str, str]:
        """The SPDX licence and the attribution notice it obliges."""
        if self.tagged:
            return OSM_LICENCE
        return OVERTURE_LICENCES.get(self.unit_of(type_key) or "", OVERTURE_OSM_LICENCE)

    def field_sql(self, type_key: str, field: str) -> str:
        """A filterable Overture attribute as SQL text, or a refusal for any other."""
        fields = OVERTURE_FIELDS.get(OVERTURE_TYPES[type_key][0], {})
        if field not in fields:
            raise ValueError(
                f"'{field}' is not an attribute you can filter this type on."
            )
        return f"CAST({fields[field]} AS VARCHAR)"

    def geometry_of(self, type_key: str) -> str:
        return FEATURE_TYPES[type_key] if self.tagged else OVERTURE_TYPES[type_key][1]


SOURCES: dict[str, Source] = {
    "osm": Source(MIRROR_URI, "geom", "osm_id", True),
    "overture": Source(OVERTURE_MIRROR_URI, "geometry", "id", False),
}


def mirror_columns(con: "Any", files: list[str]) -> dict[str, str]:
    """Every column the files hold, with its type; read once per file."""
    with _cache_lock:
        known = {f: _schemas[f] for f in files if f in _schemas}
    for f in files:
        if f not in known:
            known[f] = {
                str(r[0]): str(r[1])
                for r in con.execute(
                    f"DESCRIBE SELECT * FROM read_parquet('{_quote(f)}')"
                ).fetchall()
            }
            with _cache_lock:
                _schemas[f] = known[f]
    out: dict[str, str] = {}
    for f in files:
        out.update(known[f])
    return out


def ensure_s3(con: "Any") -> None:
    """Point a connection at our object storage and the catalog bucket's mirror."""
    load_extensions(con, "httpfs", "spatial")
    apply_duckdb_s3_settings(
        con,
        endpoint_url=os.environ.get("S3_ENDPOINT_URL"),
        access_key=os.environ.get("S3_ACCESS_KEY_ID"),
        secret_key=os.environ.get("S3_SECRET_ACCESS_KEY"),
    )
    # The catalog bucket may sit in another store than GOAT's own; a secret
    # scoped to it leaves every other s3:// read on the settings above. Each
    # CATALOG_S3_* falls back to S3_*, as in the catalog service's settings.
    if CATALOG_BUCKET:

        def env(name: str) -> str:
            return (
                os.environ.get(f"CATALOG_S3_{name}")
                or os.environ.get(f"S3_{name}")
                or ""
            )

        host, use_ssl = duckdb_s3_endpoint(env("ENDPOINT_URL"))
        options = "TYPE s3, KEY_ID ?, SECRET ?, REGION ?, URL_STYLE 'path', SCOPE ?"
        params: list[object] = [
            env("ACCESS_KEY_ID"),
            env("SECRET_ACCESS_KEY"),
            env("REGION") or "us-east-1",
            f"s3://{CATALOG_BUCKET}",
        ]
        # No endpoint is real AWS: DuckDB's own default then.
        if host:
            options += ", ENDPOINT ?"
            params.append(host)
        if use_ssl is not None:
            options += ", USE_SSL ?"
            params.append(use_ssl)
        con.execute(f"CREATE SECRET IF NOT EXISTS goat_mirror ({options})", params)


# Keyed by versioned paths, which never change; the pointer is read every time.
_indexes: TTLCache[str, list[tuple]] = TTLCache(maxsize=1000, ttl=3600)
_footers: TTLCache[str, list[tuple]] = TTLCache(maxsize=5000, ttl=3600)
_schemas: TTLCache[str, dict[str, str]] = TTLCache(maxsize=5000, ttl=3600)
_cache_lock = threading.Lock()


def pointer(con: "Any", source: Source) -> dict:
    """Which version of each unit is current: one small object the mirror writes last."""
    if not source.mirror:
        return {}
    try:
        row = con.execute(
            f"SELECT content FROM read_text('{source.mirror}/_current.json')"
        ).fetchone()
    except Exception as e:  # noqa: BLE001 - no pointer is no data, not an error
        logger.warning("no mirror pointer at %s: %s", source.mirror, e)
        return {}
    return (json.loads(row[0]) if row else {}).get("units", {})


def _index_rows(con: "Any", paths: list[str]) -> dict[str, list[tuple]]:
    """Every row of each index, read once per path, in one read for the new ones."""
    with _cache_lock:
        known = {p: _indexes[p] for p in paths if p in _indexes}
    missing = [p for p in paths if p not in known]
    if missing:

        def read(paths: list[str]) -> list[tuple]:
            listed = ", ".join(f"'{_quote(p)}'" for p in paths)
            return con.execute(
                "SELECT filename, path, layer, rows, xmin, ymin, xmax, ymax "
                f"FROM read_parquet([{listed}], filename = true, union_by_name = true) "
                "ORDER BY filename, path"
            ).fetchall()

        fresh: dict[str, list[tuple]] = {p: [] for p in missing}
        try:
            rows = read(missing)
        except Exception:
            # One unit without an index must not hide the others: each alone,
            # and the one that fails is left out, as a missing pointer is.
            rows = []
            for p in missing:
                try:
                    rows += read([p])
                except Exception as e:
                    logger.warning("no mirror index at %s: %s", p, e)
                    del fresh[p]
        for index, *row in rows:
            fresh.setdefault(index, []).append(tuple(row))
        with _cache_lock:
            _indexes.update(fresh)
        known.update(fresh)
    return {p: known.get(p, []) for p in paths}


def row_groups(con: "Any", files: list[str], geom: str) -> list[tuple]:
    """(file, first row, rows, xmin, ymin, xmax, ymax, geometry bytes) per row group, from the footers."""
    with _cache_lock:
        known = {f: _footers[f] for f in files if f in _footers}
    missing = [f for f in files if f not in known]
    if missing:
        listed = ", ".join(f"'{_quote(f)}'" for f in missing)
        stat = "max(CASE WHEN path_in_schema = 'bbox, {0}' THEN TRY_CAST(stats_{1} AS DOUBLE) END)"
        fresh: dict[str, list[tuple]] = {f: [] for f in missing}
        for f, _, n, *bounds in con.execute(f"""
            SELECT file_name, row_group_id, any_value(row_group_num_rows),
                {stat.format("xmin", "min")}, {stat.format("ymin", "min")},
                {stat.format("xmax", "max")}, {stat.format("ymax", "max")},
                sum(total_compressed_size) FILTER (
                    WHERE split_part(path_in_schema, ', ', 1) = '{_quote(geom)}'
                )
            FROM parquet_metadata([{listed}])
            GROUP BY file_name, row_group_id ORDER BY file_name, row_group_id
        """).fetchall():
            groups = fresh.setdefault(f, [])
            first = groups[-1][1] + groups[-1][2] if groups else 0
            groups.append((f, first, int(n), *bounds[:4], int(bounds[4] or 0)))
        with _cache_lock:
            _footers.update(fresh)
        known.update(fresh)
    return [g for f in files for g in known.get(f, [])]


def covering(
    con: "Any", units: dict, source: Source, type_key: str, envelope: tuple
) -> tuple[list[str], list[tuple[str, str]]]:
    """The data files that can hold something in this envelope, and the unit versions read.

    Decided from each version's index, which holds every file's actual bounds, so
    no data file or footer is opened to decide."""
    return _files_of(*_indexed(con, units, source, type_key, envelope))


def _files_of(bases: dict, rows: list) -> tuple[list[str], list[tuple[str, str]]]:
    files = [f"{index.removesuffix('/_index.parquet')}/{p}" for index, p, *_ in rows]
    read = [bases[i] for i in bases if any(r[0] == i for r in rows)]
    return files, read


def _indexed(
    con: "Any", units: dict, source: Source, type_key: str, envelope: tuple
) -> tuple[dict, list]:
    """Every index entry for this type that touches the envelope, with its rows and bounds."""
    xmin, ymin, xmax, ymax = envelope
    wanted = source.unit_of(type_key)
    bases: dict[str, tuple[str, str]] = {}
    for unit, state in sorted(units.items()):
        b = state.get("bbox")
        if (wanted is not None and unit != wanted) or (
            b and (b[0] > xmax or b[2] < xmin or b[1] > ymax or b[3] < ymin)
        ):
            continue
        # Overture's mirror puts the version on top and says where; OSM's is unit/version.
        path = state.get("path") or f"{unit}/{state['version']}"
        base = f"{source.mirror}/{path}"
        bases[f"{base}/_index.parquet"] = (unit, state["version"])
    if not bases:
        return {}, []
    # One read over every index: they are remote, and one round trip per
    # country made a large area cost ten seconds before any data was touched.
    # The split layer where the mirror has one, the combined layer of an older
    # version otherwise -- per index, so a pointer mid-switch still reads.
    split = source.split_layer_of(type_key)
    layers = (
        [split, source.layer_of(type_key)] if split else [source.layer_of(type_key)]
    )
    by_index = _index_rows(con, list(bases))
    found = sorted(
        (index, p, layer, n, x0, y0, x1, y1)
        for index, entries in by_index.items()
        for p, layer, n, x0, y0, x1, y1 in entries
        if layer in layers
        and None not in (x0, y0, x1, y1)
        and x0 <= xmax
        and x1 >= xmin
        and y0 <= ymax
        and y1 >= ymin
    )
    has_split = {r[0] for r in found if r[2] == split}
    rows = [
        (index, p, n or 0, *bounds)
        for index, p, layer, n, *bounds in found
        if layer == split or index not in has_split
    ]
    return bases, rows


def area_size(
    con: "Any", groups: list[tuple], boxes: list[tuple], enough: int | None = None
) -> tuple[int, int]:
    """Features whose bbox touches the area, and about how much geometry they carry.

    Counted from the features' bbox columns, not from each row group's share of
    the area: a row group spans a whole region and its features crowd into the
    region's towns, so that share made a city centre many times too small. The
    count reads only the bbox of the row groups touching each part. Row groups
    wholly inside count whole without a read, and once they alone are over
    ``enough`` (the limit the caller checks) that is the answer. The geometry is
    the touched row groups' bytes per feature times the features counted.
    """
    enough = MAX_READ_FEATURES if enough is None else enough
    touched = [
        [
            g
            for g in groups
            if g[3] is None or (g[3] <= x1 and g[5] >= x0 and g[4] <= y1 and g[6] >= y0)
        ]
        for x0, y0, x1, y1 in boxes
    ]
    # Parts' boxes can overlap (neighbouring regions, islands): a row group or
    # feature in several of them counts once.
    unique = {(g[0], g[1]): g for gs in touched for g in gs}
    inside = sum(
        g[2]
        for g in unique.values()
        if g[3] is not None
        and any(
            x0 <= g[3] and y0 <= g[4] and g[5] <= x1 and g[6] <= y1
            for x0, y0, x1, y1 in boxes
        )
    )

    def touches(box: tuple) -> str:
        x0, y0, x1, y1 = box
        return (
            f"bbox.xmin <= {x1} AND bbox.xmax >= {x0} "
            f"AND bbox.ymin <= {y1} AND bbox.ymax >= {y0}"
        )

    # One count per part, as an OR of the parts is not pruned by row group;
    # each leaves out what an earlier, overlapping part counted.
    counts = []
    for i, (box, gs) in enumerate(zip(boxes, touched)):
        if gs:
            listed = ", ".join(
                f"'{_quote(f)}'" for f in dict.fromkeys(g[0] for g in gs)
            )
            counted = "".join(
                f" AND NOT ({touches(earlier)})"
                for earlier in boxes[:i]
                if earlier[0] <= box[2]
                and earlier[2] >= box[0]
                and earlier[1] <= box[3]
                and earlier[3] >= box[1]
            )
            counts.append(
                f"SELECT count(*) AS n FROM read_parquet([{listed}], union_by_name = true) "
                f"WHERE {touches(box)}{counted}"
            )
    if inside > enough or not counts:
        rows = inside
    else:
        rows = int(
            con.execute(
                f"SELECT sum(n) FROM ({' UNION ALL '.join(counts)})"
            ).fetchone()[0]
        )
    n = sum(g[2] for g in unique.values())
    geometry = sum(g[7] for g in unique.values())
    return rows, geometry * rows // n if n else 0


def inside_rows(rows: list, boxes: list[tuple]) -> int:
    """Features in the files wholly inside the area, from the index without a read."""
    return sum(
        n
        for _, _, n, x0, y0, x1, y1 in rows
        if any(
            bx0 <= x0 and by0 <= y0 and x1 <= bx1 and y1 <= by1
            for bx0, by0, bx1, by1 in boxes
        )
    )


def filters_can_fit(
    con: "Any",
    indexed: tuple[dict, list],
    files: list[str],
    boxes: list[tuple],
    geom: str,
) -> bool:
    """Whether the read a filtered fetch makes here stays under the ceiling.

    The index first: a continent is over it by its whole countries alone, before
    any of their footers is fetched.
    """
    if inside_rows(indexed[1], boxes) > MAX_FILTERED_READ_FEATURES:
        return False
    return touched_rows(con, files, boxes, geom) <= MAX_FILTERED_READ_FEATURES


def touched_rows(con: "Any", files: list[str], boxes: list[tuple], geom: str) -> int:
    """Features in the row groups the area touches: what a filtered fetch reads at most."""
    unique = {
        (g[0], g[1]): g
        for g in row_groups(con, files, geom)
        if g[3] is None
        or any(
            g[3] <= x1 and g[5] >= x0 and g[4] <= y1 and g[6] >= y0
            for x0, y0, x1, y1 in boxes
        )
    }
    return sum(g[2] for g in unique.values())


def _too_large(rows: int, geometry: int) -> bool:
    """More features or more geometry in the area than one fetch reads."""
    return rows > MAX_READ_FEATURES or geometry > MAX_READ_BYTES


def check_read_size(
    con: "Any", files: list[str], boxes: list[tuple], geom: str
) -> None:
    """Refuse an area holding more than a fetch reads, before reading it."""
    if _too_large(*area_size(con, row_groups(con, files, geom), boxes)):
        raise ValueError("This area is too large. Zoom in or choose a smaller area.")
