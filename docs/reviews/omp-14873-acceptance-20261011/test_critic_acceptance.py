"""Independent acceptance boundaries for the owner's PR #14873.

Only fixture SQLite and in-process task stubs are used. This file belongs in
python/robomp/tests/ for replay; it is not an owner production modification.
"""
from __future__ import annotations

import asyncio
import sqlite3

import pytest

from robomp import tasks
from robomp.config import Settings
from robomp.db import Database
from tests.test_queue_dispatch import _make_pool


def _enqueue(db: Database, delivery: str) -> bool:
    return db.record_event(
        delivery_id=delivery,
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened", "issue": {"number": 1}},
    )


async def _until(predicate, timeout: float = 4.0) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_retry_delivers_one_real_claim_and_one_task_call(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prequeued work survives two failures without a duplicate claim or task call."""
    delivery = "critic-prequeued"
    assert _enqueue(db, delivery)
    calls = 0
    claimed: list[str] = []
    side_effects: list[int] = []
    real_claim = db.claim_next_event

    def fail_twice_then_claim():
        nonlocal calls
        calls += 1
        if calls <= 2:
            raise sqlite3.OperationalError("database is locked")
        row = real_claim()
        if row is not None:
            claimed.append(row.delivery_id)
        return row

    async def record_triage(*, payload, **_kwargs):
        side_effects.append(payload["issue"]["number"])

    monkeypatch.setattr(db, "claim_next_event", fail_twice_then_claim)
    monkeypatch.setattr(tasks, "triage_issue", record_triage)
    pool = _make_pool(settings, db)
    try:
        await pool.start()
        await _until(lambda: db.get_event(delivery).state == "done")
        assert not _enqueue(db, delivery), "The real SQLite delivery guard must reject a duplicate"
        # Revisit the queue after completion rather than stopping at the first call.
        for _ in range(3):
            before = calls
            pool.wake()
            await _until(lambda: calls > before, timeout=0.75)
        stored = db.get_event(delivery)
        assert stored.state == "done"
        assert stored.attempts == 1
        assert claimed == [delivery]
        assert side_effects == [1]
        assert pool.is_ready()
    finally:
        await pool.stop()
    assert claimed == [delivery]
    assert side_effects == [1]


@pytest.mark.parametrize("stop_mode", ["public-stop", "stop-signal"])
@pytest.mark.asyncio
async def test_shutdown_during_active_retry_preserves_queued_event(
    settings: Settings,
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    stop_mode: str,
) -> None:
    """Shutdown during backoff leaves unclaimed work queued and cannot retry later.

    The signal-only case isolates the stop-aware wait from stop()'s cancellation:
    the dispatcher must exit normally without any cancel request. The public
    case independently covers the supported shutdown entry point.
    """
    delivery = "critic-stop-backoff"
    assert _enqueue(db, delivery)
    calls = 0
    side_effects: list[int] = []

    def always_fail():
        nonlocal calls
        calls += 1
        raise sqlite3.OperationalError("database is locked")

    async def record_triage(*, payload, **_kwargs):
        side_effects.append(payload["issue"]["number"])

    monkeypatch.setattr(db, "claim_next_event", always_fail)
    monkeypatch.setattr(tasks, "triage_issue", record_triage)
    pool = _make_pool(settings, db)
    try:
        await pool.start()
        dispatcher = pool._workers[0]
        await _until(
            lambda: any(r.name == "robomp.queue" and r.getMessage() == "dispatch claim failed" for r in caplog.records),
            timeout=1.0,
        )
        # Yield after the handler logged so its stop wait is active.
        await asyncio.sleep(0.03)
        assert calls == 1
        assert not dispatcher.done()
        start = asyncio.get_running_loop().time()
        if stop_mode == "public-stop":
            await asyncio.wait_for(pool.stop(), timeout=0.5)
            assert dispatcher.done()
        else:
            pool._stop.set()
            done, _ = await asyncio.wait({dispatcher}, timeout=0.5)
            assert dispatcher in done, "The stop signal must interrupt retry backoff without task cancellation"
            assert not dispatcher.cancelled()
            assert dispatcher.exception() is None
        assert asyncio.get_running_loop().time() - start < 0.5
        # Observe beyond the one-second retry deadline to catch a stray retry.
        await asyncio.sleep(1.05)
        assert calls == 1
        stored = db.get_event(delivery)
        assert stored.state == "queued"
        assert stored.attempts == 0
        assert side_effects == []
        assert not pool.is_ready()
    finally:
        await pool.stop()
