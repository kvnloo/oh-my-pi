"""Independent public-API reachability probe; exact owner client is unchanged.

Run from this directory: python3 -B critic_caller_probe.py
Uses a local Python stdio protocol fixture, not the Bun OMP application.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "source/python/omp-rpc/src"))
from omp_rpc import RpcClient
from omp_rpc.client import RpcError, RpcTimeoutError

SERVER = r'''
import json
import sys

def emit(value):
    print(json.dumps(value), flush=True)

emit({"type": "ready"})
turn = 0
for line in sys.stdin:
    command = json.loads(line)
    if command["type"] != "prompt":
        raise RuntimeError("Unexpected fixture command")
    turn += 1
    emit({"type": "agent_start"})
    if turn == 1:
        emit({"type": "agent_end", "messages": []})
    else:
        emit({"type": "message_start", "message": {
            "role": "user", "content": "x" * 100, "timestamp": 1
        }})
        # Deliberately no second-turn agent_end. Stay alive for the next command.
    emit({"type": "response", "id": command["id"],
          "command": "prompt", "success": True})
'''


class PublicCallerProbe(unittest.TestCase):
    def run_two_prompts(self, budget):
        with RpcClient(command=[sys.executable, "-u", "-c", SERVER],
                       max_event_bytes=budget) as client:
            first = client.prompt_and_wait("first", timeout=1)
            self.assertEqual([e.type for e in first.events], ["agent_start", "agent_end"])
            with self.assertRaises((RpcError, RpcTimeoutError)):
                second = client.prompt_and_wait("second", timeout=0.05)
                print("STALE PUBLIC RETURN", [e.type for e in second.events],
                      "offset", client._events.offset,
                      "index", client._current_event_index(), flush=True)

    def test_control_unlimited_history_waits_for_new_terminal(self):
        self.run_two_prompts(None)

    def test_byte_budget_never_returns_previous_terminal(self):
        self.run_two_prompts(60)


if __name__ == "__main__":
    unittest.main(verbosity=2)
