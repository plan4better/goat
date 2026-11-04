"""Limits of the tool runners that other services read too (the assistant's
workflow check). The module imports nothing, so reading it is cheap."""

#: Start points one catchment run takes, per routing mode family.
CATCHMENT_MAX_STARTING_POINTS = 1000
CATCHMENT_MAX_STARTING_POINTS_PT = 100

#: Origin and destination pairs one travel cost matrix run takes.
TRAVEL_COST_MATRIX_MAX_PAIRS = 10_000
