"""When a public-transport journey happens.

The engine wants one number: unix minutes UTC. What a user picks is a time of
day plus *which day* — and there are two ways of saying that, because there are
two kinds of timetable.

The default network's timetable spans a long, known period, so a user picks a
kind of day ("a weekday", "a Saturday") and it resolves to a fixed anchor date
inside that span. Any weekday would do; these are simply three that are there.

An uploaded bundle's timetable spans whatever its feed declares, which is
usually a few months and almost never contains those anchors — so a bundle is
routed on a real date the user picks, bounded by the window the build recorded.
Outside the window the timetable answers every journey with "no service", which
is why the date is asked for rather than assumed.

One conversion, imported by both the tools and the analysis layer: it used to
be four copies of the same table, and a fifth was about to be added for the
date.
"""

from datetime import date as date_type
from datetime import datetime, time, timedelta, timezone
from typing import Any, Dict

#: Anchor dates for the default network — a Monday, a Saturday and a Sunday
#: inside its timetable's span. Only meaningful for that timetable: an uploaded
#: feed covering, say, March to June 2026 contains none of them.
DEFAULT_NETWORK_ANCHORS: Dict[str, date_type] = {
    "weekday": date_type(2026, 6, 16),
    "saturday": date_type(2026, 6, 20),
    "sunday": date_type(2026, 6, 21),
}

#: 07:00, when neither a window nor a time was given.
DEFAULT_SECONDS_OF_DAY = 25200


def pt_anchor_unix_minutes(
    weekday: Any = "weekday",
    seconds_of_day: int = DEFAULT_SECONDS_OF_DAY,
    on_date: Any = None,
) -> int:
    """Unix minutes (UTC) for a PT departure or arrival.

    ``on_date`` — an ISO ``YYYY-MM-DD`` string or a ``date`` — is the day the
    user picked, and wins: it is asked for precisely because the anchors do not
    apply to the timetable in question. Anything unparseable falls back to the
    anchor rather than raising, so a stray value cannot fail a run that would
    otherwise have worked with the default network's assumption.

    ``weekday`` takes the enum member or its value; the callers hold both.
    """
    day = _as_date(on_date) or DEFAULT_NETWORK_ANCHORS.get(
        str(getattr(weekday, "value", weekday)), DEFAULT_NETWORK_ANCHORS["weekday"]
    )
    moment = datetime.combine(day, time.min, tzinfo=timezone.utc) + timedelta(
        seconds=seconds_of_day
    )
    return int(moment.timestamp() // 60)


def _as_date(value: Any) -> "date_type | None":
    """A `date` from what a request carried, or None if it carried nothing
    usable — the field is a free-text date in transit."""
    if isinstance(value, date_type) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str) and value.strip():
        try:
            return date_type.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None
