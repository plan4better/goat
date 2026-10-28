"""The JSON Schema of GOAT Style, generated from the models.

The web's TypeScript types and the AI tool's schema are generated from the
checked-in file (`data/goat-style.schema.json`); `--check` fails when it is out
of date and `--write` rewrites it.
"""

import argparse
import json
import sys
from importlib import resources
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from goatlib.style.catalog import icon_groups, icon_libraries, palettes

SCHEMA_ID = "https://goat.plan4better.de/schemas/goat-style-1.json"


def json_schema() -> dict[str, Any]:
    """`$defs` for `LayerStyle`, `MapDocument` and the catalogue; the reference defaults
    (`x-defaults`), the per-layer keys (`x-per-layer`), the default ranges of number
    targets (`x-default-ranges`) and the icon groups (`x-icon-groups`) for editors; the
    zoom from which each H3 resolution draws under "auto" (`x-h3-auto`) for the
    compiler; the root is a layer style."""
    from goatlib.style.colors import DEFAULT_RANGES
    from goatlib.style.defaults import REFERENCE_DEFAULTS
    from goatlib.style.h3 import AUTO_FROM_ZOOM
    from goatlib.style.models.layer import LayerStyle
    from goatlib.style.models.map_document import MapDocument
    from goatlib.style.models.parts import PER_LAYER_KEYS

    keys, schema = TypeAdapter.json_schemas(
        [
            ("LayerStyle", "validation", TypeAdapter(LayerStyle)),
            ("MapDocument", "validation", TypeAdapter(MapDocument)),
        ],
        ref_template="#/$defs/{model}",
    )
    defs = dict(schema.get("$defs", {}))
    for name in ("LayerStyle", "MapDocument"):
        key = keys[(name, "validation")]
        if key.get("$ref") != f"#/$defs/{name}":
            defs[name] = key
    defs["catalog"] = {
        "description": "The ids GOAT knows: catalogue palettes and library icons (<library>:<name>).",
        "type": "object",
        "properties": {
            "palettes": {"enum": sorted(palettes())},
            "icons": {
                "enum": sorted(
                    f"{lib}:{n}"
                    for lib, names in icon_libraries().items()
                    for n in names
                )
            },
        },
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": SCHEMA_ID,
        "title": "GOAT Style 1",
        "$ref": "#/$defs/LayerStyle",
        "$defs": dict(sorted(defs.items())),
        "x-defaults": REFERENCE_DEFAULTS,
        "x-per-layer": sorted(PER_LAYER_KEYS),
        "x-default-ranges": {k: list(v) for k, v in DEFAULT_RANGES.items()},
        "x-icon-groups": icon_groups(),
        "x-h3-auto": [list(pair) for pair in AUTO_FROM_ZOOM],
    }


def _path() -> Path:
    return Path(
        str(resources.files("goatlib.style").joinpath("data", "goat-style.schema.json"))
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--check",
        action="store_true",
        help="fail when the checked-in schema is out of date",
    )
    group.add_argument(
        "--write", action="store_true", help="rewrite the checked-in schema"
    )
    args = parser.parse_args(argv)
    text = json.dumps(json_schema(), indent=1, ensure_ascii=False) + "\n"
    if args.write:
        _path().write_text(text, encoding="utf-8")
        return 0
    if _path().read_text(encoding="utf-8") != text:
        print(
            f"{_path()} is out of date: run python -m goatlib.style.schema --write",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
