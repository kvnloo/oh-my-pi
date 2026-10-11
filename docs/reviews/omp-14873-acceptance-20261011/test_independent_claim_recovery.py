"""Independent exact-head acceptance probes for PR #14873.

These remain in the detached acceptance archive, not the owner's branch.
"""

from __future__ import annotations

import asyncio
import sqlite3
from threading import Event

import pytest

from robomp import tasks
from robomp.config import Settings
from robomp.db import Database
from tests.test_queue_dispatch import _make_pool


@pytest.mark.asyncio
async def test_queued_event_survives_two_claim_errors(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert db.record_event(
        delivery_id="accepted-before-lock",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened", "issue": {"number": 1}},
    )
    attempts = 0
    real_claim = db.claim_next_event
    dispatched = asyncio.Event()

    def fail_twice():
        nonlocal attempts
        attempts += 1
        if attempts <= 2:
            raise sqlite3.OperationalError("database is locked")
        return real_claim()

    async def record_triage(**kwargs):
        dispatched.set()

    monkeypatch.setattr(db, "claim_next_event", fail_twice)
    monkeypatch.setattr(tasks, "triage_issue", record_triage)
    pool = _make_pool(settings, db)
    try:
        await pool.start()
        await asyncio.wait_for(dispatched.wait(), timeout=4)
        async with asyncio.timeout(1):
            while db.get_event("accepted-before-lock").state != "done":
                await asyncio.sleep(0.01)
        assert attempts >= 3
        assert db.get_event("accepted-before-lock").attempts == 1
        assert pool.is_ready()
    finally:
        await pool.stop()


@pytest.mark.asyncio
async def test_shutdown_interrupts_claim_error_backoff(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    claim_failed = Event()
    attempts = 0

    def always_fail():
        nonlocal attempts
        attempts += 1
        claim_failed.set()
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(db, "claim_next_event", always_fail)
    pool = _make_pool(settings, db)
    await pool.start()
    try:
        assert await asyncio.to_thread(claim_failed.wait, 1)
        await asyncio.wait_for(pool.stop(), timeout=0.75)
        count_after_stop = attempts
        await asyncio.sleep(0.05)
        assert attempts == count_after_stop
        assert not pool.is_ready()
    finally:
        await pool.stop()
