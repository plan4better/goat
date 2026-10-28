from goatlib.style import template


def test_placeholders_handle_odd_names_and_escapes() -> None:
    assert template.placeholders("{Einwohner 2020} people in {Straße}") == [
        "Einwohner 2020",
        "Straße",
    ]
    assert template.placeholders(r"\{literal\} {name}") == ["name"]
    assert template.placeholders("{name}\n{area_km2} km²") == ["name", "area_km2"]


def test_problems() -> None:
    assert template.problems("{{ name }}")
    assert template.problems("{name")
    assert template.problems("name}")
    assert template.problems("{}")
    assert template.problems("{name} and {a.b}") == []


def test_braces_inside_a_field_name_are_escaped() -> None:
    assert template.placeholders(r"{a\}b}") == ["a}b"]
    assert template.problems(r"{a\}b}") == []
