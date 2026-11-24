"""The production assistant has no DuckDB, numpy or shapely: the service's
modules must import without them, directly or through goatlib."""

import os
import subprocess
import sys
import textwrap

#: The modules the service runs from: the tools, the undo route, the run
#: manager and the app itself (``main`` builds it with the test settings).
SERVICE_MODULES = (
    "assistant.tools.registry",
    "assistant.undo",
    "assistant.runs.manager",
    "assistant.main",
)

_SCRIPT = textwrap.dedent(
    """
    import importlib
    import sys

    REFUSED = ("duckdb", "numpy", "shapely")


    class Refuse:
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in REFUSED:
                raise ImportError(f"{name} is not installed in production")
            return None


    sys.meta_path.insert(0, Refuse())
    for module in sys.argv[1:]:
        importlib.import_module(module)
    """
)


def test_the_service_imports_without_duckdb_numpy_and_shapely() -> None:
    done = subprocess.run(
        [sys.executable, "-c", _SCRIPT, *SERVICE_MODULES],
        capture_output=True,
        text=True,
        env=os.environ.copy(),
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-4000:]
