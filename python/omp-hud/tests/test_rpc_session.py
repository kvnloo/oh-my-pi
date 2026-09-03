from __future__ import annotations

import threading
import unittest

from omp_rpc import AgentEndEvent, UnknownNotification, VoiceState

from omp_hud.rpc_session import HudRpcSession, extract_text_delta


class RpcStreamTests(unittest.TestCase):
    def test_returns_only_assistant_text_deltas(self) -> None:
        self.assertEqual("hello", extract_text_delta({"type": "text_delta", "delta": "hello"}))
        self.assertIsNone(
            extract_text_delta({"type": "thinking_delta", "delta": "hidden reasoning"})
        )
        self.assertIsNone(extract_text_delta({"type": "text_delta", "delta": 42}))
        self.assertIsNone(extract_text_delta({"type": "text_end", "content": "hello"}))


class RpcLifecycleTests(unittest.TestCase):
    def test_nonterminal_agent_end_keeps_session_busy(self) -> None:
        busy_changes: list[bool] = []
        session = HudRpcSession.__new__(HudRpcSession)
        session._on_busy = busy_changes.append

        session._handle_agent_end(AgentEndEvent(messages=(), is_terminal=False))
        session._handle_agent_end(AgentEndEvent(messages=(), is_terminal=True))

        self.assertEqual([False], busy_changes)

    def test_local_command_output_is_forwarded(self) -> None:
        output: list[str] = []
        statuses: list[str] = []
        session = HudRpcSession.__new__(HudRpcSession)
        session._on_text = output.append
        session._on_status = statuses.append

        session._handle_unknown_notification(
            UnknownNotification({"type": "command_output", "text": "local result\n"})
        )
        session._handle_unknown_notification(
            UnknownNotification({"type": "prompt_result", "agentInvoked": False})
        )

        self.assertEqual(["local result\n"], output)
        self.assertEqual(["Ready"], statuses)

    def test_computer_enable_details_are_compacted_to_status(self) -> None:
        output: list[str] = []
        statuses: list[str] = []
        session = HudRpcSession.__new__(HudRpcSession)
        session._on_text = output.append
        session._on_status = statuses.append

        session._handle_unknown_notification(
            UnknownNotification(
                {
                    "type": "command_output",
                    "text": (
                        "Computer use enabled for this session. Computer use: enabled · "
                        "tool: active · exposure: function"
                    ),
                }
            )
        )

        self.assertEqual([], output)
        self.assertEqual(["ComputerTool ready"], statuses)

    def test_local_computer_enable_marks_session_ready(self) -> None:
        statuses: list[str] = []
        prompts: list[str] = []

        class FakeClient:
            def start(self) -> None:
                return None

            def prompt(self, text: str) -> bool:
                prompts.append(text)
                return False

            def stop(self) -> None:
                return None

        session = HudRpcSession.__new__(HudRpcSession)
        session._closed = threading.Event()
        session._client = FakeClient()
        session._on_status = statuses.append

        session.start()

        self.assertEqual(["/computer on"], prompts)
        self.assertEqual(["Starting OMP…", "Enabling ComputerTool…", "Ready"], statuses)

    def test_dictation_commands_remain_owned_by_rpc_client(self) -> None:
        calls: list[str] = []
        expected = VoiceState(mode="dictation", phase="listening")

        class FakeClient:
            def start_dictation(self) -> VoiceState:
                calls.append("start")
                return expected

            def stop_dictation(self) -> VoiceState:
                calls.append("stop")
                return expected

            def cancel_dictation(self) -> VoiceState:
                calls.append("cancel")
                return expected

        session = HudRpcSession.__new__(HudRpcSession)
        session._closed = threading.Event()
        session._client = FakeClient()

        self.assertIs(expected, session.start_dictation())
        self.assertIs(expected, session.stop_dictation())
        self.assertIs(expected, session.cancel_dictation())
        self.assertEqual(["start", "stop", "cancel"], calls)

    def test_close_winning_start_race_stops_late_process(self) -> None:
        entered_start = threading.Event()
        allow_spawn = threading.Event()

        class FakeClient:
            def __init__(self) -> None:
                self.spawned = False

            def start(self) -> None:
                entered_start.set()
                allow_spawn.wait(1.0)
                self.spawned = True

            def stop(self) -> None:
                self.spawned = False

        client = FakeClient()
        session = HudRpcSession.__new__(HudRpcSession)
        session._closed = threading.Event()
        session._client = client
        session._on_status = lambda _status: None

        thread = threading.Thread(target=session.start)
        thread.start()
        self.assertTrue(entered_start.wait(1.0))
        session.close()
        allow_spawn.set()
        thread.join(1.0)

        self.assertFalse(thread.is_alive())
        self.assertFalse(client.spawned)


if __name__ == "__main__":
    unittest.main()
