"""OpenStreetMap in the mirror: tags, and how they are matched and counted.

Tags are matched the way `osm/poi/_base.sql` matches them: a regex over the raw
hstore text first, so only candidate rows pay for the parse, then the parsed map
for an exact comparison. `LIKE '%amenity%'` alone would also match `amenity:parking`.
"""

import logging
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Tags naming or dating one feature rather than a kind: not offered as filter keys.
IDENTIFIER_TAGS = (
    "name",
    "ref",
    "website",
    "phone",
    "email",
    "wikidata",
    "wikipedia",
    "opening_hours",
    "check_date",
)


#: A cached tag list unused this long is deleted, and the check runs at most
#: this often -- the files are disposable, and without it they pile up forever.
TAG_CACHE_MAX_IDLE_SECONDS = 60 * 60
_tag_cache_swept = 0.0
_tag_cache_sweep_lock = threading.Lock()


#: The GDAL OSM layers the mirror converts, and the geometry each yields.
FEATURE_TYPES: dict[str, str] = {
    "points": "point",
    "lines": "line",
    "multipolygons": "polygon",
}


#: OSM is ODbL; Overture's licence is per theme, see `overture.py`.
OSM_LICENCE = ("ODbL-1.0", "© OpenStreetMap contributors")


#: hstore text -> a map, as `osm/poi/_base.sql` does it.
TAGS_SQL = """CAST(TRY_CAST('{' || replace(replace(replace(replace(
    all_tags, '"=>"', '":"'), chr(10), '\\n'), chr(13), '\\r'),
    chr(9), '\\t') || '}' AS JSON) AS MAP(VARCHAR, VARCHAR))"""


def tag_storage(columns: dict[str, str]) -> str:
    """How the files hold OSM tags: a native `tags` map, the hstore `all_tags`
    text, or "both" while a republish has reached some countries only."""
    mapped = columns.get("tags", "").startswith("MAP")
    if mapped and "all_tags" in columns:
        return "both"
    return "map" if mapped else "text"


def _tags_from(storage: str, parsed: str = TAGS_SQL) -> str:
    """The tags as a map, whichever way the files hold them."""
    if storage == "map":
        return "tags"
    return parsed if storage == "text" else f"coalesce(tags, {parsed})"


def _has_key_sql(key: str, storage: str) -> str:
    """Whether a feature carries a key, tested on the stored tags unparsed."""
    text = f"regexp_matches(all_tags, '\"{_quote(re.escape(key))}\"=>')"
    mapped = f"map_contains(tags, '{_quote(key)}')"
    if storage == "map":
        return mapped
    return text if storage == "text" else f"coalesce({mapped}, {text})"


def _tag_cache_path(
    cache_key: str, feature_type: str, parts: list, envelope: tuple
) -> Path:
    """Where this area's parsed tags are kept between calls.

    Keyed on the snapshots too, so next week's mirror does not answer from last
    week's file. An area edited without moving its bounding box is the case this
    misses; the file is disposable, so deleting it is the remedy.
    """
    import hashlib

    stamp = "|".join(
        ["raw", cache_key, feature_type, *(f"{e}/{s}" for e, s in parts)]
        + [f"{v:.5f}" for v in envelope]
    )
    digest = hashlib.sha256(stamp.encode()).hexdigest()[:24]
    # The shared volume where it belongs, falling back to scratch where that is
    # not writable -- a cache is an optimisation, and losing it between restarts
    # costs one slow call, where failing to place it would cost the feature.
    for root in (
        Path(os.environ.get("DATA_DIR", "/app/data")) / "cache" / "osm_tags",
        Path(tempfile.gettempdir()) / "goat_osm_tags",
    ):
        try:
            root.mkdir(parents=True, exist_ok=True)
            _sweep_tag_cache(root)
            return root / f"{digest}.parquet"
        except OSError as e:
            logger.info("tag cache unavailable at %s: %s", root, e)
    raise OSError("no writable location for the tag cache")


def _sweep_tag_cache(root: Path) -> None:
    """Delete cached tag lists nobody has read for an hour, at most once an hour.

    Run from a request rather than a timer. A file is touched on every read, so
    only lists out of use go -- an old mirror version's, an area left behind.
    """
    global _tag_cache_swept
    now = time.time()
    if now - _tag_cache_swept < TAG_CACHE_MAX_IDLE_SECONDS:
        return
    with _tag_cache_sweep_lock:
        if now - _tag_cache_swept < TAG_CACHE_MAX_IDLE_SECONDS:
            return
        _tag_cache_swept = now
        for path in root.glob("*.parquet"):
            try:
                if now - path.stat().st_mtime > TAG_CACHE_MAX_IDLE_SECONDS:
                    path.unlink(missing_ok=True)
            except OSError:
                pass


def _raw_tags_sql(
    files: list[str], envelope: tuple, prefilter: str, storage: str = "text"
) -> str:
    """Every feature's tags in the envelope, for suggestions only: the hstore
    text left unparsed, or the map as stored."""
    xmin, ymin, xmax, ymax = envelope
    listed = ", ".join(f"'{_quote(f)}'" for f in files)
    picked = "all_tags" if storage == "text" else f"{_tags_from(storage)} AS tags"
    return f"""SELECT {picked} FROM read_parquet([{listed}], union_by_name = true)
        WHERE bbox.xmin <= {xmax} AND bbox.xmax >= {xmin}
          AND bbox.ymin <= {ymax} AND bbox.ymax >= {ymin} AND {prefilter}"""


def _count_tags(
    con: "Any", source: str, key: str | None, limit: int, storage: str = "text"
) -> tuple[list, int]:
    """The commonest keys or values, and how many were counted before the limit.

    Read from the raw hstore text with a regex: parsing every feature's tags
    into a map was most of a ten-second first call, and a list needs no map.
    Files holding a native map are read as one.
    """
    if storage != "text":
        picked = "unnest(map_keys(tags))" if key is None else f"tags['{_quote(key)}']"
    elif key is None:
        picked = """unnest(regexp_extract_all(all_tags, '"([^"]+)"=>', 1))"""
    else:
        picked = f"""regexp_extract(all_tags, '"{_quote(re.escape(key))}"=>"((?:[^"\\\\]|\\\\.)*)"', 1)"""
    # A colon marks a sub-attribute by OSM convention -- `addr:street`,
    # `contact:phone`, `crossing:markings` describe a feature rather than say
    # what it is, and they crowd out the keys worth querying: in Munich the six
    # commonest keys are all `addr:*`. Only when listing the keys; a value list
    # is already about one key the user chose.
    identifiers = ", ".join(f"'{t}'" for t in IDENTIFIER_TAGS)
    noise = "" if key else f" AND value NOT LIKE '%:%' AND value NOT IN ({identifiers})"
    rows = con.execute(f"""
        WITH picked AS (SELECT {picked} AS value FROM ({source}))
        SELECT value, count(*) AS count, sum(count(*)) OVER () AS seen FROM picked
        WHERE value IS NOT NULL AND value <> ''{noise}
        GROUP BY value ORDER BY count DESC, value LIMIT {int(limit)}
    """).fetchall()
    return [(v, n) for v, n, _ in rows], int(rows[0][2]) if rows else 0


#: Columns of an OSM file that are not tags.
NOT_TAGS = {
    "osm_id",
    "osm_way_id",
    "address",
    "is_in",
    "z_order",
    "all_tags",
    *IDENTIFIER_TAGS,
}


def _quote(value: str) -> str:
    return value.replace("'", "''")


def _tag_sql(
    filters: list, joiner: str = " AND ", storage: str = "text"
) -> tuple[str, str]:
    """(cheap prefilter on the raw text, exact test on the parsed map)."""
    if not filters:
        return "TRUE", "TRUE"
    if storage != "text":
        # A stored map needs no parsing, so nothing to spare it from.
        return "TRUE", _tag_sql(filters, joiner)[1]
    pre, exact = [], []
    for f in filters:
        key = _quote(re.escape(f.key))
        quoted = f"'{_quote(f.key)}'"
        if not f.values:
            pre.append(f"regexp_matches(all_tags, '\"{key}\"=>')")
            exact.append(f"map_contains(tags, {quoted})")
            continue
        # Several values on one key is "any of them": a feature has one value
        # per key, so AND-ing them could never match anything.
        alts = "|".join(re.escape(v) for v in f.values)
        pre.append(f'regexp_matches(all_tags, \'"{key}"=>"({_quote(alts)})"\')')
        listed = ", ".join(f"'{_quote(v)}'" for v in f.values)
        exact.append(f"tags[{quoted}] IN ({listed})")
    return joiner.join(pre), joiner.join(exact)
