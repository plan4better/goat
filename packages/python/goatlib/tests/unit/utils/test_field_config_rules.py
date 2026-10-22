"""The field-config rules goatlib shares with geoapi's feature writes."""

from goatlib.utils.field_config import (
    allowed_value_columns,
    column_defaults,
    parse_computed_columns,
)


def test_column_defaults_reads_default_entries() -> None:
    config = {"status": {"default_value": "zu prüfen"}, "n": {}}
    assert column_defaults(config) == {"status": "zu prüfen"}


def test_allowed_value_columns_skips_allow_other() -> None:
    config = {
        "status": {"allowed_values": ["zu prüfen", "fertig"]},
        "tag": {"allowed_values": ["a"], "allow_other": True},
    }
    assert allowed_value_columns(config) == {"status": ["zu prüfen", "fertig"]}


def test_parse_computed_columns_formula() -> None:
    config = {"double": {"is_computed": True, "kind": "formula", "formula": "n * 2"}}
    specs = parse_computed_columns(config)
    assert [s.name for s in specs] == ["double"]
    assert specs[0].compute_sql == "(n * 2)"
