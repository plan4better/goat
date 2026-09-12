"""The PT departure/arrival conversion, and the fallbacks it is asked to make."""

from datetime import date, datetime, timezone

import pytest
from goatlib.analysis.pt_time import (
    DEFAULT_NETWORK_ANCHORS,
    DEFAULT_SECONDS_OF_DAY,
    pt_anchor_unix_minutes,
)


def _moment(minutes: int) -> datetime:
    return datetime.fromtimestamp(minutes * 60, timezone.utc)


@pytest.mark.unit
@pytest.mark.parametrize("weekday", sorted(DEFAULT_NETWORK_ANCHORS))
def test_weekday_resolves_to_its_anchor(weekday: str) -> None:
    moment = _moment(pt_anchor_unix_minutes(weekday, DEFAULT_SECONDS_OF_DAY))
    assert moment.date() == DEFAULT_NETWORK_ANCHORS[weekday]
    assert (moment.hour, moment.minute) == (7, 0)


@pytest.mark.unit
def test_date_wins_over_weekday() -> None:
    """A bundle's timetable does not contain the anchors, so the picked date
    has to override the weekday rather than be reconciled with it."""
    moment = _moment(pt_anchor_unix_minutes("saturday", 32400, "2026-03-04"))
    assert moment.date() == date(2026, 3, 4)
    assert (moment.hour, moment.minute) == (9, 0)


@pytest.mark.unit
@pytest.mark.parametrize("value", [None, "", "   ", "not-a-date", "2026-13-45"])
def test_unusable_date_falls_back_to_the_anchor(value: object) -> None:
    """The field is free text in transit; a stray value must not fail a run
    that would have worked on the default network's assumption."""
    moment = _moment(pt_anchor_unix_minutes("sunday", DEFAULT_SECONDS_OF_DAY, value))
    assert moment.date() == DEFAULT_NETWORK_ANCHORS["sunday"]


@pytest.mark.unit
def test_accepts_date_and_datetime_objects() -> None:
    both = {
        pt_anchor_unix_minutes("weekday", 0, date(2026, 3, 4)),
        pt_anchor_unix_minutes("weekday", 0, datetime(2026, 3, 4, 18, 30)),
    }
    assert len(both) == 1
    assert _moment(both.pop()).date() == date(2026, 3, 4)
