import numpy as np
import pytest
from goatlib.raster.formula import FormulaError, parse_formula, single_band


def _bands(**values: list[float]) -> dict[int, np.ndarray]:
    return {int(k[1:]): np.array(v, dtype="float32") for k, v in values.items()}


def test_formulas_accept_bands_numbers_the_four_operators_and_brackets() -> None:
    ndvi = parse_formula("(b4 - b1) / (b4 + b1)")
    assert ndvi.bands == (1, 4)
    out = ndvi.evaluate(_bands(b1=[10, 20], b4=[30, 20]))
    assert out.dtype == np.float32
    assert out.tolist() == pytest.approx([0.5, 0.0])
    assert parse_formula("b1 + b2 * 2").evaluate(_bands(b1=[1], b2=[3])).tolist() == [7]
    assert parse_formula("-b1 + 3").evaluate(_bands(b1=[1])).tolist() == [2]
    assert parse_formula("2 * (b1 - 0.5)").evaluate(_bands(b1=[1])).tolist() == [1]
    assert parse_formula("b1 - -b1").evaluate(_bands(b1=[2])).tolist() == [4]
    assert parse_formula("b1 / 2 / 2").evaluate(_bands(b1=[8])).tolist() == [2]


def test_a_band_beyond_the_files_bands_is_a_formula_error() -> None:
    assert parse_formula("b9").bands == (9,)
    with pytest.raises(FormulaError):
        parse_formula("b9 - b1", bands=8)


@pytest.mark.parametrize(
    "expression",
    [
        "",
        "   ",
        "b0",
        "abs(b1)",
        "b1 ** 2",
        "b1.real",
        "__import__('os')",
        "b1 +",
        "(b1",
        "b1)",
        "1e3",
        "b1 b2",
        "x",
        "b1 % 2",
        "(" * 200 + "b1" + ")" * 200,
        "b1" + " + b1" * 400,
        "5",
        "(2 + 3) * 4",
    ],
)
def test_anything_else_is_a_formula_error_never_evaluated(expression: str) -> None:
    with pytest.raises(FormulaError):
        parse_formula(expression)


def test_division_by_zero_and_invalid_values_are_no_data() -> None:
    out = parse_formula("(b1 - b2) / (b1 + b2)").evaluate(
        _bands(b1=[0, 1, np.nan], b2=[0, -1, 1])
    )
    assert np.isnan(out).all()


@pytest.mark.parametrize(
    ("expression", "band"),
    [
        ("b2", 2),
        (" b2 ", 2),
        ("b02", 2),
        ("b12", 12),
        ("b2 + 0", None),
        ("(b2)", None),
        ("-b2", None),
        ("b2 b3", None),
        ("B2", None),
        ("2", None),
        ("", None),
    ],
)
def test_a_formula_of_one_band_alone_is_that_band(
    expression: str, band: int | None
) -> None:
    """Shared by the style check and geoapi's raster info, and as the style
    panel takes it (`wholeBand`): only a band's name alone, however typed."""
    assert single_band(expression) == band
