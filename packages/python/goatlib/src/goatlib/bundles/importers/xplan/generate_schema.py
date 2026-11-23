"""Regenerate the XPlan schema the importer decodes with (`versions/`).

Run by hand when the XLeitstelle publishes an XPlanGML release:

    uv run python -m goatlib.bundles.importers.xplan.generate_schema

For each version it downloads two files from the XLeitstelle's release page
(https://xleitstelle.de/xplanung/releases-xplanung): the code dictionaries with
short forms (`GML_Dictionaries_<v>_Kuerzel.zip`) and the XML schema. It writes
`versions/xplangml_<v>.json` beside this file: per class its
code fields (field to code list), per code list each code's name and short
form (`MI`, `MU`). A class's code fields include the ones inside the data
types it holds (from version 6 a green area's purpose is
`zweckbestimmung/BP_KomplexeZweckbestGruen/allgemein`), under the innermost
name, which is the column GDAL reads such a field into.

The tables come from the standard's own publication on purpose: an open source
XPlan server ships the same lists under the AGPL, GOAT is GPL.
"""

import io
import json
import re
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

BASE = "https://xleitstelle.de/filebrowser/download/"

# Version: (code dictionaries with short forms, schema). File ids on the
# XLeitstelle release page.
RELEASES = {
    "5.0": (2404, 1917),
    "5.1": (2405, 1903),
    "5.2": (2406, 1871),
    "5.3": (2407, 1891),
    "5.4": (2408, 1859),
    "6.0": (2409, 1827),
    "6.1": (2410, 2281),
}

OUT = Path(__file__).parent / "versions"

GML = "{http://www.opengis.net/gml/3.2}"
XS = "{http://www.w3.org/2001/XMLSchema}"


def _download(file_id: int) -> zipfile.ZipFile:
    with urllib.request.urlopen(f"{BASE}{file_id}", timeout=120) as response:
        return zipfile.ZipFile(io.BytesIO(response.read()))


def readable(name: str) -> str:
    """`GeschlosseneBauweise` to `Geschlossene Bauweise`: words split where a
    lower-case letter or digit meets an upper-case one, spelling kept."""
    return re.sub(r"(?<=[a-z0-9äöüß])(?=[A-ZÄÖÜ])", " ", name)


def code_lists(archive: zipfile.ZipFile) -> dict[str, dict[str, dict]]:
    lists: dict[str, dict[str, dict]] = {}
    for member in archive.namelist():
        if not member.endswith(".xml"):
            continue
        root = ET.fromstring(archive.read(member))
        for definition in root.iter(f"{GML}Definition"):
            identifier = definition.findtext(f"{GML}identifier") or ""
            if ":" not in identifier:
                continue
            code_list, code = identifier.rsplit(":", 1)
            names = definition.findall(f"{GML}name")
            name = next((n.text for n in names if not n.get("codeSpace")), None)
            short = next(
                (n.text for n in names if n.get("codeSpace") == "kuerzel"), None
            )
            lists.setdefault(code_list, {})[code] = {
                "name": readable(name or code),
                "short": short,
            }
    return lists


_PROPERTY = "PropertyType"


def classes(archive: zipfile.ZipFile, enum_names: set[str]) -> dict[str, dict]:
    types: dict[str, tuple[str | None, dict[str, str]]] = {}
    #: Per type, the data types its fields hold (`<data type>PropertyType`),
    #: and the names of all its fields, code or not.
    holds: dict[str, list[str]] = {}
    names: dict[str, set[str]] = {}
    abstract: set[str] = set()
    substitutes: dict[str, str] = {}
    for member in archive.namelist():
        if not member.endswith(".xsd") or "GmlProfile" in member:
            continue
        root = ET.fromstring(archive.read(member))
        for element in root.findall(f"{XS}element"):
            if element.get("abstract") == "true":
                abstract.add(element.get("name", ""))
            substitutes[element.get("name", "")] = element.get("substitutionGroup", "")
        for complex_type in root.iter(f"{XS}complexType"):
            name = complex_type.get("name", "")
            if not name.endswith("Type"):
                continue
            extension = complex_type.find(f".//{XS}extension")
            base = (
                extension.get("base", "").split(":")[-1]
                if extension is not None
                else None
            )
            fields = {}
            held = []
            for element in complex_type.iter(f"{XS}element"):
                element_type = element.get("type", "").split(":")[-1]
                if element.get("name") and element_type.endswith(_PROPERTY):
                    held.append(element_type[: -len(_PROPERTY)])
                # 6.1 names the code types `<list>Type`.
                if element_type not in enum_names and element_type.endswith("Type"):
                    element_type = element_type[: -len("Type")]
                if element.get("name") and element_type in enum_names:
                    fields[element.get("name")] = element_type
            types[name[: -len("Type")]] = (
                base[: -len("Type")] if base and base.endswith("Type") else None,
                fields,
            )
            holds[name[: -len("Type")]] = held
            names[name[: -len("Type")]] = {
                e.get("name", "") for e in complex_type.iter(f"{XS}element")
            } - {""}

    def chain(cls: str) -> list[str]:
        seen = []
        while cls in types and cls not in seen:
            seen.append(cls)
            cls = types[cls][0] or ""
        return seen

    def is_feature(cls: str) -> bool:
        """Data types (`XP_Hoehenangabe`) are elements too; only a feature's
        substitution chain ends at `gml:AbstractFeature`."""
        seen = set()
        while cls and cls not in seen:
            seen.add(cls)
            group = substitutes.get(cls, "")
            if group == "gml:AbstractFeature":
                return True
            cls = group.split(":")[-1] if group.startswith("xplan:") else ""
        return False

    def own_fields(cls: str) -> dict[str, str]:
        """The code fields of a type and of the types it extends."""
        fields: dict[str, str] = {}
        for ancestor in reversed(chain(cls)):
            fields.update(types[ancestor][1])
        return fields

    def data_types(cls: str, seen: set[str]) -> list[str]:
        """The data types a type holds, and the ones those hold in turn."""
        found = []
        for ancestor in chain(cls):
            for data_type in holds.get(ancestor, []):
                if data_type in types and data_type not in seen:
                    seen.add(data_type)
                    if not is_feature(data_type):
                        found += [data_type, *data_types(data_type, seen)]
        return found

    def all_names(cls: str) -> set[str]:
        return set().union(*(names.get(a, set()) for a in chain(cls)))

    def held_fields(cls: str) -> dict[str, str]:
        """The code fields inside the data types a class holds, by their
        innermost name. Only a name that is one field's alone: where the class
        itself or another of its data types has a field of the same name, a
        column of that name may be either, and decoding never guesses."""
        held = data_types(cls, set())
        taken = all_names(cls)
        found: dict[str, str] = {}
        for data_type in held:
            others = taken.union(*(all_names(d) for d in held if d != data_type))
            for field, code_list in own_fields(data_type).items():
                if field not in others:
                    found[field] = code_list
        return found

    result = {}
    for cls in types:
        # Abstract classes never occur in a file; they only pass fields on.
        if (
            not re.match(r"^(BP|FP|LP|RP|SO|XP)_", cls)
            or cls in abstract
            or not is_feature(cls)
        ):
            continue
        result[cls] = {**held_fields(cls), **own_fields(cls)}
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for version, (dictionaries, schema) in RELEASES.items():
        lists = code_lists(_download(dictionaries))
        table = {
            "version": version,
            "classes": classes(_download(schema), set(lists)),
            "lists": lists,
        }
        path = OUT / f"xplangml_{version.replace('.', '_')}.json"
        path.write_text(
            json.dumps(table, ensure_ascii=False, sort_keys=True, indent=0),
            encoding="utf-8",
        )
        codes = sum(len(v) for v in lists.values())
        print(
            f"{version}: {len(table['classes'])} classes, {len(lists)} lists, {codes} codes"
        )


if __name__ == "__main__":
    main()
