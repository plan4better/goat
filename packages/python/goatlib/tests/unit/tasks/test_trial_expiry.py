"""Unit tests for trial classification (pure part of trial_expiry)."""

from datetime import datetime, timedelta

from goatlib.tasks.trial_expiry import classify_trial

NOW = datetime(2026, 7, 17, 12, 0, 0)


def test_past_renewal_is_expired():
    assert classify_trial(NOW - timedelta(hours=1), NOW, 3) == "expired"
    assert classify_trial(NOW - timedelta(days=30), NOW, 3) == "expired"


def test_exactly_now_is_expired():
    assert classify_trial(NOW, NOW, 3) == "expired"


def test_warning_window_is_one_day_wide():
    # (2, 3] days remaining -> expiring; a daily run hits it exactly once
    assert classify_trial(NOW + timedelta(days=3), NOW, 3) == "expiring"
    assert classify_trial(NOW + timedelta(days=2, hours=1), NOW, 3) == "expiring"
    assert classify_trial(NOW + timedelta(days=2), NOW, 3) is None
    assert classify_trial(NOW + timedelta(days=3, hours=1), NOW, 3) is None


def test_healthy_trial_left_alone():
    assert classify_trial(NOW + timedelta(days=10), NOW, 3) is None


def test_custom_warning_window():
    assert classify_trial(NOW + timedelta(days=7), NOW, 7) == "expiring"
    assert classify_trial(NOW + timedelta(days=3), NOW, 7) is None
