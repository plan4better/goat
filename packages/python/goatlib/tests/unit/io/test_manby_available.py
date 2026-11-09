"""manby is installed, and it is the plan4better build.

The tile builder and geoapi's tile filter run manby; upstream 0.1.9 has no
`ilike` in its feature filter and no `--largest-maximum-zoom-guess`, which the
polygon recipe uses, so both only work with our fork's wheel (pinned by URL
in the root pyproject.toml).
"""

import subprocess
from pathlib import Path

import duckdb
import manby
from pmtiles.reader import MmapSource, all_tiles


def test_manby_is_our_build(tmp_path: Path) -> None:
    # manby prints its version on stderr
    version = subprocess.run(
        [manby.binary(), "--version"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=True,
    )
    assert version.stdout.startswith("manby 0.1.9")
    usage = subprocess.run(
        [manby.binary(), "--help"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert "--largest-maximum-zoom-guess" in usage.stdout

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    points = con.sql(
        "SELECT * FROM (VALUES "
        "('Lidl Markt', ST_AsWKB(ST_Point(7.6, 47.5))), "
        "('Aldi', ST_AsWKB(ST_Point(7.6001, 47.5001)))"
        ") AS t(name, geometry)"
    )
    archive = tmp_path / "points.pmtiles"
    manby.tile(points, archive, "-z10", "-r1", "--no-tile-compression")

    with open(archive, "rb") as f:
        ((z, x, y), tile) = next(t for t in all_tiles(MmapSource(f)) if t[0][0] == 10)
    source = tmp_path / "source.pbf"
    source.write_bytes(tile)
    assert b"Lidl Markt" in tile
    assert b"Aldi" in tile

    filtered = tmp_path / "filtered.pbf"
    subprocess.run(
        [
            manby.binary(),
            "overzoom",
            "-o",
            str(filtered),
            "--no-tile-compression",
            '--feature-filter={"*":["ilike","name","%lidl%"]}',
            str(source),
            f"{z}/{x}/{y}",
            f"{z}/{x}/{y}",
        ],
        capture_output=True,
        check=True,
    )

    assert b"Lidl Markt" in filtered.read_bytes()
    assert b"Aldi" not in filtered.read_bytes()
