"""Unit tests for the ÖV-Güteklassen layer style (a GOAT Style document)."""

from goatlib.style.context import DataContext
from goatlib.style.validate import validate
from goatlib.tools.style import oev_gueteklassen_style

POLYGONS = DataContext(kind="vector", geometry="polygon")


def colors_of(style: dict) -> dict[str, str]:
    [c] = style["classify"]
    assert (c["field"], c["method"]) == ("pt_class_label", "categories")
    return {k["values"][0]: k["fill"]["color"] for k in c["classes"]}


class TestOevGueteklassenStyle:
    """Test dynamic and backward-compatible ÖV style mappings."""

    def test_preserves_legacy_a_to_f_colors(self: "TestOevGueteklassenStyle") -> None:
        """A-F classes keep the established color mapping."""
        colors = colors_of(oev_gueteklassen_style())
        assert colors == {
            "A": "#199741",
            "B": "#8bcc62",
            "C": "#dcf09e",
            "D": "#ffdf9a",
            "E": "#f69053",
            "F": "#e4696a",
        }

    def test_generates_colors_beyond_f(self: "TestOevGueteklassenStyle") -> None:
        """Additional classes (G and later) for scalable configurations."""
        style = oev_gueteklassen_style(class_count=26)
        colors = colors_of(style)
        assert "G" in colors and "Z" in colors
        assert colors["G"] != colors["F"]
        assert [i for i in validate(style, POLYGONS) if i.level == "error"] == []
