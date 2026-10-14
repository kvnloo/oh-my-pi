from __future__ import annotations

import queue
import subprocess
import sys
import textwrap
import threading
import unittest

from omp_rpc import RpcClient, RpcCommandError, RpcError, RpcTimeoutError, host_tool

# Source contract: rpc-mode validates descriptions before mutating the bridge;
# session-tools rejects duplicate names before replacing the active registry.
# This peer exercises the Python SDK over actual pipes, not the Bun server.
TOOL_SERVER = textwrap.dedent(
    """
    import json
    import sys

    registered = []
    mode = None
    sequence = 0
    pending_acks = {}
    delayed_rejection = None
    held_rejections = []

    def emit(frame):
        print(json.dumps(frame), flush=True)

    def respond(command, data=None, error=None, identified=True):
        frame = {"type": "response", "command": command["type"], "success": error is None}
        if identified:
            frame["id"] = command["id"]
        if error is None:
            frame["data"] = data or {}
        else:
            frame["error"] = error
        emit(frame)

    def call(name, ack=None):
        global sequence
        sequence += 1
        call_id = "host-" + str(sequence)
        if ack is not None:
            pending_acks[call_id] = ack
        emit({"type": "host_tool_call", "id": call_id, "toolName": name,
              "toolCallId": "tool-" + str(sequence), "arguments": {"value": "wire"}})

    emit({"type": "ready"})
    for line in sys.stdin:
        command = json.loads(line)
        kind = command["type"]
        if kind == "configure":
            mode = command["mode"]
            respond(command)
        elif kind == "set_host_tools":
            current_mode, mode = mode, None
            tools = command["tools"]
            names = [tool["name"] for tool in tools]
            error = None
            if any(not tool["description"].strip() for tool in tools):
                error = "Host tool must provide a non-empty description"
            elif len(names) != len(set(names)):
                error = "RPC host tool names must be unique"
            if current_mode == "late_rejection":
                delayed_rejection = command
                emit({"type": "registration_waiting", "name": names[0]})
                continue
            if current_mode == "hold_rejection":
                held_rejections.append(command)
                emit({"type": "registration_waiting", "name": names[0]})
                continue
            if error is not None:
                respond(command, error=error, identified=current_mode != "idless")
                if registered:
                    call(registered[0])
                continue
            registered = names
            if delayed_rejection is not None:
                respond(delayed_rejection, error="late rejection")
                delayed_rejection = None
            if current_mode == "disconnect":
                break
            if current_mode == "no_ack":
                continue
            if current_mode == "early":
                call(registered[0], ack=command)
                continue
            if current_mode == "malformed_success":
                respond(command, data={"unexpected": True})
                continue
            respond(command, data={"toolNames": names})
        elif kind == "release_rejections":
            pending = list(reversed(held_rejections)) if command.get("reverse") else held_rejections
            for rejected in pending:
                respond(rejected, error="held rejection")
            held_rejections = []
            respond(command)
        elif kind == "call_registered":
            name = command.get("name", registered[0] if registered else "")
            if name not in registered:
                respond(command, error="server tool not registered")
            else:
                call(name)
                respond(command)
        elif kind == "host_tool_result":
            emit({"type": "tool_echo", "frame": command})
            ack = pending_acks.pop(command["id"], None)
            if ack is not None:
                respond(ack, data={"toolNames": [tool["name"] for tool in ack["tools"]]})
        elif kind == "host_tool_update":
            pass
        else:
            respond(command, error="unsupported test command")
    """
)


def tool(
    name="accepted", result="accepted", *, description="A host-owned tool", execute=None
):
    return host_tool(
        name=name,
        description=description,
        parameters={"type": "object"},
        execute=execute or (lambda _args, _context: result),
    )


class HostToolRegistrationTests(unittest.TestCase):
    def make_client(self, *, client_type=RpcClient, **kwargs):
        client = client_type(
            command=[sys.executable, "-u", "-c", TOOL_SERVER],
            startup_timeout=2.0,
            request_timeout=kwargs.pop("request_timeout", 2.0),
            **kwargs,
        )
        frames = queue.Queue()
        client.on_unknown_notification(
            lambda event: (
                frames.put(event.payload["frame"])
                if event.payload.get("type") == "tool_echo"
                else None
            )
        )
        return client, frames

    def assert_result(self, frames, expected):
        frame = frames.get(timeout=2.0)
        self.assertIsNot(frame.get("isError"), True, frame)
        self.assertEqual(
            frame["result"]["content"], [{"type": "text", "text": expected}]
        )

    def test_initial_configuration_and_successful_replacement_are_callable(self):
        client, frames = self.make_client(custom_tools=(tool(),))
        with client:
            client.request_raw("call_registered")
            self.assert_result(frames, "accepted")
            self.assertEqual(
                client.set_custom_tools((tool("new", "replacement"),)), ("new",)
            )
            client.request_raw("call_registered")
            self.assert_result(frames, "replacement")
            with self.assertRaisesRegex(RpcCommandError, "server tool not registered"):
                client.request_raw("call_registered", name="accepted")

    def test_rejected_replacement_restores_before_waiting_setter_resumes(self):
        echoed = threading.Event()

        class DelayedRejectionClient(RpcClient):
            def _request_data(self, *args, **kwargs):
                try:
                    return super()._request_data(*args, **kwargs)
                except RpcCommandError:
                    if not echoed.wait(2.0):
                        raise AssertionError(
                            "callback did not finish while setter was suspended"
                        )
                    raise

        client, frames = self.make_client(
            client_type=DelayedRejectionClient, custom_tools=(tool(),)
        )
        client.on_unknown_notification(
            lambda event: (
                echoed.set() if event.payload.get("type") == "tool_echo" else None
            )
        )
        with client:
            with self.assertRaisesRegex(RpcCommandError, "non-empty description"):
                client.set_custom_tools((tool("rejected", "wrong", description=""),))
            self.assert_result(frames, "accepted")
            client.request_raw("call_registered")
            self.assert_result(frames, "accepted")

    def test_rejected_same_name_keeps_accepted_callable(self):
        client, frames = self.make_client(custom_tools=(tool(),))
        with client:
            with self.assertRaisesRegex(RpcCommandError, "must be unique"):
                client.set_custom_tools(
                    (tool(result="wrong"), tool(result="also wrong"))
                )
            self.assert_result(frames, "accepted")

    def test_rejection_from_empty_set_restores_empty_startup_configuration(self):
        client, _frames = self.make_client()
        with client, self.assertRaisesRegex(RpcCommandError, "non-empty description"):
            client.set_custom_tools((tool("rejected", description=""),))
        # Restart must not retry the rejected configuration. No startup cleanup
        # assertion here: that separate defect belongs to downstream #152.
        try:
            client.start()
            with self.assertRaisesRegex(RpcCommandError, "server tool not registered"):
                client.request_raw("call_registered", name="rejected")
        finally:
            client.stop()

    def test_callback_before_success_acknowledgement_uses_proposed_handler(self):
        client, frames = self.make_client(custom_tools=(tool(),))
        with client:
            client.request_raw("configure", mode="early")
            self.assertEqual(
                client.set_custom_tools((tool("new", "before ack"),)), ("new",)
            )
            self.assert_result(frames, "before ack")

    def test_timeout_preserves_potentially_applied_handlers(self):
        client, frames = self.make_client(custom_tools=(tool(),), request_timeout=0.1)
        with client:
            client.request_raw("configure", mode="no_ack")
            with self.assertRaises(RpcTimeoutError):
                client.set_custom_tools((tool("new", "applied without ack"),))
            client.request_raw("call_registered")
            self.assert_result(frames, "applied without ack")

    def test_disconnect_does_not_restore_rejected_assumption_on_restart(self):
        client, frames = self.make_client(custom_tools=(tool(),))
        with client:
            client.request_raw("configure", mode="disconnect")
            with self.assertRaises(RpcError):
                client.set_custom_tools((tool("new", "uncertain on disconnect"),))
        with client:
            client.request_raw("call_registered")
            self.assert_result(frames, "uncertain on disconnect")

    def test_malformed_success_is_not_an_explicit_registration_rejection(self):
        client, frames = self.make_client(custom_tools=(tool(),))
        with client:
            client.request_raw("configure", mode="malformed_success")
            with self.assertRaises(ValueError):
                client.set_custom_tools((tool("new", "accepted but malformed reply"),))
            client.request_raw("call_registered")
            self.assert_result(frames, "accepted but malformed reply")

    def test_idless_definite_rejection_restores_previous_handler(self):
        client, frames = self.make_client(custom_tools=(tool(),))
        with client:
            client.request_raw("configure", mode="idless")
            with self.assertRaisesRegex(RpcCommandError, "non-empty description"):
                client.set_custom_tools((tool("rejected", description=""),))
            self.assert_result(frames, "accepted")

    def test_late_identified_failure_cannot_restore_another_registration(self):
        client, frames = self.make_client(custom_tools=(tool(),), request_timeout=0.1)
        with client:
            client.request_raw("configure", mode="late_rejection")
            with self.assertRaises(RpcTimeoutError):
                client.set_custom_tools((tool("uncertain"),))
            # Existing ID fallback miscorrelates this error (origin #12555).
            # This leaf must not additionally restore an unrelated handler set.
            with self.assertRaisesRegex(RpcCommandError, "late rejection"):
                client.set_custom_tools((tool("new", "new accepted"),))
            client.request_raw("call_registered")
            self.assert_result(frames, "new accepted")

    def test_concurrent_rejection_cannot_overwrite_accepted_registration(self):
        first_callback = threading.Event()
        release_callback = threading.Event()
        contender_ready = threading.Event()
        errors = []
        results = []

        def execute(_args, _context):
            first_callback.set()
            if not release_callback.wait(2.0):
                raise AssertionError("callback was not released")
            return "first accepted"

        client, frames = self.make_client()
        with client:
            client.request_raw("configure", mode="early")

            def register_first():
                try:
                    results.append(
                        client.set_custom_tools((tool("first", execute=execute),))
                    )
                except (RpcError, AssertionError) as error:
                    errors.append(error)

            def reject_second():
                try:
                    client.set_custom_tools((tool("rejected", description=""),))
                except RpcCommandError:
                    pass
                except (RpcError, AssertionError) as error:
                    errors.append(error)
                else:
                    errors.append(AssertionError("invalid registration succeeded"))
                finally:
                    contender_ready.set()

            first = threading.Thread(target=register_first)
            second = threading.Thread(target=reject_second)
            first.start()
            try:
                self.assertTrue(first_callback.wait(2.0))
                second.start()
                self.assertTrue(contender_ready.wait(2.0))
            finally:
                release_callback.set()
                first.join(4.0)
                if second.ident is not None:
                    second.join(4.0)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(results, [("first",)])
            self.assert_result(frames, "first accepted")
            self.assert_result(frames, "first accepted")
            client.request_raw("call_registered")
            self.assert_result(frames, "first accepted")

    def test_interrupted_registration_cannot_undo_a_newer_success(self):
        # A real signal is delivered only to a disposable child test process.
        for reuse_tuple in (False, True):
            with self.subTest(reuse_tuple=reuse_tuple):
                result = subprocess.run(
                    [sys.executable, "-B", "-c", INTERRUPT_PROBE, str(reuse_tuple)],
                    capture_output=True,
                    text=True,
                    timeout=5.0,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("callback=new accepted", result.stdout)

    def test_handler_can_replace_tools_before_outer_acknowledgement(self):
        client, frames = self.make_client(custom_tools=(tool(),), request_timeout=0.3)
        nested_results = []

        def execute(_args, _context):
            nested_results.append(
                client.set_custom_tools((tool("new", "nested accepted"),))
            )
            return "outer callback completed"

        with client:
            client.request_raw("configure", mode="early")
            self.assertEqual(
                client.set_custom_tools((tool("outer", execute=execute),)), ("outer",)
            )
            self.assertEqual(nested_results, [("new",)])
            self.assert_result(frames, "outer callback completed")
            client.request_raw("call_registered")
            self.assert_result(frames, "nested accepted")

    def test_overlapping_rejections_skip_rejected_predecessors_in_either_order(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                waiting = {name: threading.Event() for name in ("first", "second")}
                errors = []
                rejected = []
                client, frames = self.make_client(custom_tools=(tool(),))
                client.on_unknown_notification(
                    lambda event, waiting=waiting: (
                        waiting[event.payload["name"]].set()
                        if event.payload.get("type") == "registration_waiting"
                        else None
                    )
                )

                def replace(name, client=client, rejected=rejected, errors=errors):
                    try:
                        client.set_custom_tools((tool(name, description=""),))
                    except RpcCommandError as error:
                        rejected.append(str(error))
                    except (RpcError, AssertionError) as error:
                        errors.append(error)

                with client:
                    threads = []
                    try:
                        for name, received in waiting.items():
                            client.request_raw("configure", mode="hold_rejection")
                            thread = threading.Thread(target=replace, args=(name,))
                            threads.append(thread)
                            thread.start()
                            self.assertTrue(received.wait(2.0))
                        client.request_raw("release_rejections", reverse=reverse)
                    finally:
                        for thread in threads:
                            thread.join(3.0)
                    self.assertFalse(any(thread.is_alive() for thread in threads))
                    self.assertEqual(errors, [])
                    self.assertEqual(rejected, ["set_host_tools: held rejection"] * 2)
                    client.request_raw("call_registered")
                    self.assert_result(frames, "accepted")

    def test_handler_publication_matches_wire_send_order(self):
        first_paused = threading.Event()
        release_first = threading.Event()
        second_finished = threading.Event()
        errors = []

        class PausedWriteClient(RpcClient):
            def _write_json(self, process, payload, **kwargs):
                if (
                    payload.get("type") == "set_host_tools"
                    and payload["tools"][0]["name"] == "first"
                ):
                    first_paused.set()
                    if not release_first.wait(2.0):
                        raise AssertionError("first write not released")
                return super()._write_json(process, payload, **kwargs)

        client, frames = self.make_client(client_type=PausedWriteClient)

        def replace(name):
            try:
                client.set_custom_tools((tool(name, name),))
            except (RpcError, AssertionError) as error:
                errors.append(error)
            finally:
                if name == "second":
                    second_finished.set()

        with client:
            first = threading.Thread(target=replace, args=("first",))
            second = threading.Thread(target=replace, args=("second",))
            first.start()
            try:
                self.assertTrue(first_paused.wait(2.0))
                second.start()
                self.assertTrue(second_finished.wait(2.0))
            finally:
                release_first.set()
                first.join(3.0)
                if second.ident is not None:
                    second.join(3.0)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            client.request_raw("call_registered")
            self.assert_result(frames, "first")


INTERRUPT_PROBE = r"""
import os
import signal
import sys
import threading
from tests.test_host_tool_registration import HostToolRegistrationTests, tool

case = HostToolRegistrationTests()
client, frames = case.make_client(custom_tools=(tool(),))
request_received = threading.Event()
client.on_unknown_notification(
    lambda event: request_received.set()
    if event.payload.get("type") == "registration_waiting" else None
)
new_tools = (tool("new", "new accepted"),)
interrupted_tools = new_tools if sys.argv[1] == "True" else (tool("interrupted"),)
with client:
    client.request_raw("configure", mode="late_rejection")
    def interrupt_waiter():
        if request_received.wait(2.0):
            os.kill(os.getpid(), signal.SIGINT)
    interrupter = threading.Thread(target=interrupt_waiter)
    interrupter.start()
    try:
        client.set_custom_tools(interrupted_tools)
    except KeyboardInterrupt:
        pass
    else:
        raise AssertionError("registration was not interrupted")
    finally:
        interrupter.join(3.0)
    assert not interrupter.is_alive()
    assert client.set_custom_tools(new_tools) == ("new",)
    client.request_raw("call_registered")
    case.assert_result(frames, "new accepted")
    print("callback=new accepted")
"""


if __name__ == "__main__":
    unittest.main()
