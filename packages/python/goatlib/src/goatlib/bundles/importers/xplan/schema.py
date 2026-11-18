"""The XPlan schema: what GOAT knows about the XPlanGML format, per version.

The XPlan counterpart of the GTFS importer's `gtfs_schema.py`. A plan states
codes, not meanings (`besondereArtDerBaulNutzung = 1500`); the schema says
which fields of a class hold codes, from which code list, and what each code
means. The standard is too large to write by hand (about 1,700 codes per
version), so `generate_schema.py` builds `versions/` from the XLeitstelle's
own publication.
"""

import json
import re
from functools import cache
from pathlib import Path

DATA = Path(__file__).parent / "versions"

SUPPORTED_VERSIONS: tuple[str, ...] = ("5.0", "5.1", "5.2", "5.3", "5.4", "6.0", "6.1")

_NAMESPACE = re.compile(r"^http://www\.xplanung\.de/xplangml/(\d+)/(\d+)$")


def version_from_namespace(ns: str) -> str | None:
    """`http://www.xplanung.de/xplangml/5/4` to `5.4`; None for any other namespace."""
    match = _NAMESPACE.match(ns)
    return f"{match.group(1)}.{match.group(2)}" if match else None


@cache
def _table(version: str) -> dict | None:
    path = DATA / f"xplangml_{version.replace('.', '_')}.json"
    return json.loads(path.read_text()) if path.exists() else None


def classes(version: str) -> set[str]:
    """The plan object classes the version defines."""
    return set((_table(version) or {}).get("classes", {}))


class CodeList:
    """Which code list a class field uses, and what a code in it means."""

    def field_list(self, version: str, cls: str, field: str) -> str | None:
        table = _table(version) or {}
        return table.get("classes", {}).get(cls, {}).get(field)

    def fields(self, version: str, cls: str) -> dict[str, str]:
        """Every code field of the class, with its code list."""
        table = _table(version) or {}
        return dict(table.get("classes", {}).get(cls, {}))

    def name(self, version: str, code_list: str, code: str) -> str | None:
        table = _table(version) or {}
        entry = table.get("lists", {}).get(code_list, {}).get(code)
        return entry["name"] if entry else None

    def short(self, version: str, code_list: str, code: str) -> str | None:
        """The code's short form on a printed plan (`MI`, `MU`, `g`), if it has one."""
        table = _table(version) or {}
        entry = table.get("lists", {}).get(code_list, {}).get(code)
        return entry.get("short") if entry else None

    def codes(self, version: str, code_list: str) -> dict[str, str]:
        """Code to name, for a whole list."""
        table = _table(version) or {}
        return {
            code: entry["name"]
            for code, entry in table.get("lists", {}).get(code_list, {}).items()
        }
