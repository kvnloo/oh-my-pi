"""Frozen exact-head PR #12842 byte-history acceptance, no source edits.

Run from python/omp-rpc with PYTHONPATH=src:
    python3 /absolute/path/to/regression_frozen.py

The first three tests are controls. The final three assert the desired
second-turn boundary invariant and are expected to fail at head f483ffeb8f.
"""

import unittest

from omp_rpc import RpcClient
from omp_rpc.client import RpcError, RpcTimeoutError


OLD_TERMINAL = {"type": "agent_end", "messages": []}
SMALL = {"type": "event"}
EVICTING_SMALL = {"type": "event", "x": "1234567890"}
OVERSIZED = {"type": "message_update", "padding": "x" * 100}


def client() -> RpcClient:
    return RpcClient(max_event_bytes=60)


def prior_turn_and_boundary() -> tuple[RpcClient, int]:
    c = client()
    c._events.append(OLD_TERMINAL)
    start = c._current_event_index()
    assert start == 1
    return c, start


class ByteHistoryBoundaryTests(unittest.TestCase):
    def test_control_small_new_event_does_not_replay_old_terminal(self) -> None:
        c, start = prior_turn_and_boundary()
        c._events.append(SMALL)
        self.assertEqual(c._events.snapshot_from(start), (SMALL,))
        with self.assertRaises(RpcTimeoutError):
            c._wait_for_agent_end(start, 0, timeout=0.01)

    def test_control_front_eviction_does_not_replay_old_terminal(self) -> None:
        c, start = prior_turn_and_boundary()
        c._events.append(EVICTING_SMALL)
        self.assertEqual(c._events.offset, 1)
        self.assertEqual(c._events.snapshot_from(start), (EVICTING_SMALL,))
        with self.assertRaises(RpcTimeoutError):
            c._wait_for_agent_end(start, 0, timeout=0.01)

    def test_control_oversized_first_frame_reports_overflow(self) -> None:
        c = client()
        start = c._current_event_index()
        c._events.append(OVERSIZED)
        self.assertEqual(c._events.snapshot(), ())
        with self.assertRaises(RpcError):
            c._wait_for_agent_end(start, 0, timeout=0.01)

    def test_oversized_after_old_terminal_keeps_turn_boundary(self) -> None:
        c, start = prior_turn_and_boundary()
        c._events.append(OVERSIZED)
        self.assertEqual(c._events.snapshot_from(start), ())

    def test_second_turn_waiter_never_returns_old_terminal(self) -> None:
        c, start = prior_turn_and_boundary()
        c._events.append(OVERSIZED)
        with self.assertRaises((RpcError, RpcTimeoutError)):
            c._wait_for_agent_end(start, 0, timeout=0.01)

    def test_oversized_then_new_small_does_not_replay_old_terminal(self) -> None:
        c, start = prior_turn_and_boundary()
        c._events.append(OVERSIZED)
        c._events.append(SMALL)
        self.assertEqual(c._events.snapshot_from(start), (SMALL,))


if __name__ == "__main__":
    unittest.main(verbosity=2)
