import warnings

import numpy as np
import pytest
from goatlib.raster.values import MAX_Q, value_encoding


def _q(rgba: np.ndarray) -> np.ndarray:
    rgb = rgba[..., :3].astype("int64")
    return rgb[..., 0] * 65536 + rgb[..., 1] * 256 + rgb[..., 2]


@pytest.mark.parametrize(
    "dtype,lo", [("uint8", 0), ("int8", -128), ("uint16", 0), ("int16", -32768)]
)
def test_small_integer_types_are_stored_exactly(dtype: str, lo: int) -> None:
    e = value_encoding(dtype, scaled=False, value_range=(5, 9))
    assert e.step == 1.0 and e.base == lo - 1 and e.integer is True
    assert e.range == (5, 9)
    info = np.iinfo(dtype)
    values = np.arange(info.min, info.max + 1, dtype=dtype).reshape(-1, 256)
    assert np.array_equal(e.decode(e.encode(values)), values.astype("float64"))


def test_wide_integers_are_exact_when_their_span_fits() -> None:
    e = value_encoding("int32", scaled=False, value_range=(-1_000_000, 2_000_000))
    # A tenth of the span below the sampled minimum stays exact too.
    assert e.step == 1.0 and e.base == -1_300_001 and e.integer is True
    values = np.array([[-1_250_000, -1_000_000, 0, 2_000_000]], dtype="int32")
    assert np.array_equal(e.decode(e.encode(values)), values.astype("float64"))
    wide = value_encoding("int32", scaled=False, value_range=(0, 2**25))
    assert wide.integer is False and wide.step != 1.0


def test_the_room_below_a_wide_integer_range_takes_only_the_codes_left() -> None:
    full = value_encoding("int32", scaled=False, value_range=(0, MAX_Q - 2))
    assert full.integer is True and full.base == -1
    tight = value_encoding("int32", scaled=False, value_range=(0, MAX_Q - 7))
    assert tight.integer is True and tight.base == -6
    top = np.array([[MAX_Q - 7]], dtype="int32")
    assert _q(tight.encode(top)).tolist() == [[MAX_Q - 1]]


def test_floats_spread_over_the_widened_range() -> None:
    e = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    assert e.base < 70.0 and e.base + MAX_Q * e.step > 403.0
    assert 0 < e.step < 1e-3
    assert e.integer is False and e.range == (100.0, 400.0)
    values = np.linspace(100.0, 400.0, 3001, dtype="float32").reshape(1, -1)
    decoded = e.decode(e.encode(values))
    assert np.all(np.abs(decoded - values) <= e.step)


def test_a_float_below_the_sampled_minimum_still_round_trips() -> None:
    e = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    # Statistics come from an overview: the file may hold lower cells.
    [[decoded]] = e.decode(e.encode(np.array([[85.0]], dtype="float32")))
    assert abs(decoded - 85.0) <= e.step


def test_a_range_beyond_float32_spreads_over_the_codes_without_warnings() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        e = value_encoding("float64", scaled=False, value_range=(-3.4e38, 3.4e38))
    assert np.isfinite(e.step) and e.step > 0 and np.isfinite(e.base)
    assert e.base + MAX_Q * e.step > 3.4e38


def test_no_data_and_nan_are_code_zero_and_alpha_stays_opaque() -> None:
    e = value_encoding("float32", scaled=False, value_range=(0.0, 10.0))
    data = np.array([[1.0, 2.0, np.nan], [4.0, 5.0, 6.0]], dtype="float32")
    values = np.ma.masked_array(
        data, mask=[[False, False, False], [True, False, False]]
    )
    rgba = e.encode(values)
    assert rgba.shape == (2, 3, 4) and rgba.dtype == np.uint8
    assert np.all(rgba[..., 3] == 255)
    assert rgba[0, 2, :3].tolist() == [0, 0, 0] and rgba[1, 0, :3].tolist() == [0, 0, 0]
    decoded = e.decode(rgba)
    assert np.isnan(decoded[0, 2]) and np.isnan(decoded[1, 0])
    assert np.isfinite(decoded[0, :2]).all() and np.isfinite(decoded[1, 1:]).all()
    assert np.all(_q(rgba)[np.isfinite(decoded)] >= 1)


def test_values_beyond_the_range_clamp_to_the_end_codes() -> None:
    e = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    q = _q(e.encode(np.array([[-1e12, 1e12]])))
    assert q.tolist() == [[1, MAX_Q]]
    exact = value_encoding("int32", scaled=False, value_range=(100, 200))
    rgba = exact.encode(np.array([[50, 95, 100, 200]], dtype="int32"))
    assert _q(rgba).tolist() == [[1, 6, 11, 111]]
    # 95 is below the sampled minimum by less than the room the codes keep.
    assert exact.decode(rgba)[0, 1] == 95.0


def test_a_constant_band_gets_a_positive_step() -> None:
    e = value_encoding("float32", scaled=False, value_range=(7.0, 7.0))
    assert e.step > 0 and e.range == (7.0, 7.0)
    [[decoded]] = e.decode(e.encode(np.array([[7.0]], dtype="float32")))
    assert abs(decoded - 7.0) <= e.step


def test_adjacent_codes_decode_apart_in_float32() -> None:
    e = value_encoding("float32", scaled=False, value_range=(500.0, 600.0))
    f = {k: np.float32(v) for k, v in e.factors().items()}

    def unpack(q: int) -> np.float32:
        """MapLibre's custom unpack, in float32."""
        r, g, b = (np.float32(c) for c in (q >> 16, (q >> 8) & 255, q & 255))
        return (
            r * f["redFactor"]
            + g * f["greenFactor"]
            + b * f["blueFactor"]
            - f["baseShift"]
        )

    top = int(round((600.0 - e.base) / e.step))
    for q in range(top - 3, top + 4):
        assert unpack(q + 1) > unpack(q)


def test_formulas_always_take_the_float_path() -> None:
    e = value_encoding("uint8", scaled=False, value_range=(0, 255), formula=True)
    assert e.integer is False
    scaled = value_encoding("int16", scaled=True, value_range=(0.0, 10.0))
    assert scaled.integer is False


def test_factors_decode_like_maplibre() -> None:
    for e in (
        value_encoding("int16", scaled=False, value_range=None),
        value_encoding("float32", scaled=False, value_range=(-12.5, 3000.0)),
    ):
        f = e.factors()
        assert set(f) == {"redFactor", "greenFactor", "blueFactor", "baseShift"}
        for q in (1, 255, 256, 65_537, 1_234_567, MAX_Q):
            r, g, b = q >> 16, (q >> 8) & 255, q & 255
            unpacked = (
                r * f["redFactor"]
                + g * f["greenFactor"]
                + b * f["blueFactor"]
                - f["baseShift"]
            )
            assert unpacked == pytest.approx(e.base + q * e.step, rel=1e-12)
            rgba = e.encode(np.array([[e.base + q * e.step]]))
            assert rgba[0, 0].tolist() == [r, g, b, 255]
