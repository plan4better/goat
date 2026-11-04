"""Importing a light goatlib.io module must not load the converters.

core and geoapi install goatlib without the `full` extra, and both reach
goatlib.io.config (parquet options) from the code they import at startup.
Importing any submodule runs the package's __init__, so an eager import there
of the converters (pyproj, duckdb) or of S3 discovery (boto3) stops either
service from starting.
"""

import subprocess
import sys

#: Modules that need packages core's or geoapi's image does not install.
HEAVY = ("goatlib.io.converter", "goatlib.io.ingest", "goatlib.io.discover")


def test_config_loads_without_the_converters() -> None:
    # A fresh interpreter: this process has loaded the converters already.
    code = (
        "import sys, goatlib.io.config\n"
        f"print(','.join(m for m in {HEAVY!r} if m in sys.modules))"
    )
    loaded = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    ).stdout.strip()

    assert loaded == ""


def test_the_package_exports_still_resolve() -> None:
    import goatlib.io

    for name in goatlib.io.__all__:
        assert getattr(goatlib.io, name) is not None
