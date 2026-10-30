"""The mini feed's Explorer snapshot, for the web app's tests.

The web app derives what the Explorer shows from snapshot files with DuckDB-WASM;
its tests read the snapshot of ``explorer_mini_gtfs`` committed under
``apps/web/lib/explorer/__fixtures__/mini``. This writes it. A goatlib test
(``test_explorer_snapshot.py``) fails when the committed copy no longer matches
what the converter writes, so the two cannot drift.

    uv run python packages/python/goatlib/tests/fixtures/explorer_web_fixture.py
"""

import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
FEED = HERE / "explorer_mini_gtfs"
WEB_FIXTURE = (
    HERE.parents[4] / "apps" / "web" / "lib" / "explorer" / "__fixtures__" / "mini"
)


def build(out: Path) -> dict:
    """Write the mini feed's snapshot files into ``out``; return the manifest."""
    import duckdb
    from goatlib.bundles.explorer.snapshot import build_snapshot
    from goatlib.bundles.importers.base import bound_duckdb
    from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter

    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "mini_gtfs.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            for f in sorted(FEED.iterdir()):
                zf.write(f, f.name)
        work = Path(tmp) / "work"
        work.mkdir()
        paths = {
            layer.role: layer.file_path
            for layer in GtfsImporter().extract_layers(str(archive), str(work))
        }
        con = bound_duckdb(duckdb.connect(), str(work))
        return build_snapshot(
            con,
            lambda role: f"read_parquet('{paths[role]}')" if role in paths else None,
            str(out),
        )


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else WEB_FIXTURE
    shutil.rmtree(target, ignore_errors=True)
    manifest = build(target)
    print(f"Wrote {len(manifest['files'])} files to {target}")
