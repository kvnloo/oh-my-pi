import sys
import textwrap
import unittest
from omp_rpc import RpcClient, RpcCommandError, host_tool

STARTUP_REGISTRATION_SERVER = textwrap.dedent(
    """
    import json
    import os
    import sys

    ready = {"type": "ready"}
    if os.environ.get("STARTUP_PROTOCOL_V2") == "1":
        ready.update({
            "protocolVersion": 1,
            "supportedProtocolVersions": [1, 2],
            "maxFrameBytes": 1024 * 1024,
            "maxReassembledFrameBytes": 64 * 1024 * 1024,
        })
    print(json.dumps(ready), flush=True)
    pending_registration = None

    def respond(command, *, data=None, error=None):
        frame = {
            "type": "response", "id": command["id"],
            "command": command["type"], "success": error is None,
        }
        if error is not None:
            frame["error"] = error
        elif data is not None:
            frame["data"] = data
        print(json.dumps(frame), flush=True)

    for line in sys.stdin:
        command = json.loads(line)
        if command["type"] == "negotiate_protocol":
            respond(command, data={"protocolVersion": 2})
        elif command["type"] == "set_host_tools":
            names = [tool["name"] for tool in command["tools"]]
            if len(set(names)) != len(names):
                # Definite rejection; deliberately stay alive and read stdin.
                respond(command, error="RPC host tool names must be unique")
            else:
                pending_registration = command
                print(json.dumps({
                    "type": "host_tool_call", "id": "startup-tool-call",
                    "toolName": names[0], "toolCallId": "startup-execution", "arguments": {"message": "during startup"},
                }), flush=True)
        elif command["type"] == "host_tool_result":
            print(json.dumps({"type": "startup_tool_result", "result": command}), flush=True)
            names = [tool["name"] for tool in pending_registration["tools"]]
            respond(pending_registration, data={"toolNames": names})
            pending_registration = None
        else:
            respond(command, data={})
    """
)


class StartupRegistrationTests(unittest.TestCase):
    def _make_client(self, tools, *, protocol_v2=False):
        client = RpcClient(
            command=[sys.executable, "-u", "-c", STARTUP_REGISTRATION_SERVER],
            custom_tools=tools,
            startup_timeout=2.0,
            request_timeout=2.0,
            env={"STARTUP_PROTOCOL_V2": "1" if protocol_v2 else "0"},
        )
        resources = []

        def capture_ready(notification):
            if notification.type == "ready":
                resources.append(
                    (client._process, client._stdout_thread, client._stderr_thread)
                )

        client.on_notification(capture_ready)
        self.addCleanup(client.stop)
        return client, resources

    def _tool(self, execute=lambda args, ctx: "host:" + args["message"]):
        return host_tool(
            name="startup_echo",
            description="Startup callback fixture",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
            },
            execute=execute,
        )

    def _assert_failed_entry_reaps(self, protocol_v2):
        tool = self._tool()
        client, resources = self._make_client((tool, tool), protocol_v2=protocol_v2)
        entered = False
        try:
            with self.assertRaises(RpcCommandError) as caught, client:
                entered = True
            self.assertFalse(entered)
            self.assertEqual(caught.exception.command, "set_host_tools")
            self.assertEqual(
                caught.exception.error, "RPC host tool names must be unique"
            )
            self.assertEqual(len(resources), 1)
            child, stdout_reader, stderr_reader = resources[0]
            self.assertEqual(
                (
                    child.poll() is not None,
                    not stdout_reader.is_alive(),
                    not stderr_reader.is_alive(),
                ),
                (True, True, True),
                "failed context entry must reap worker and stop both readers",
            )
            self.assertEqual(client.survivor_pids, ())
        finally:
            # Reap only this test's disposable child, including on RED.
            client.stop()

    def test_failed_context_entry_reaps_child_and_readers_v1(self):
        self._assert_failed_entry_reaps(protocol_v2=False)

    def test_failed_context_entry_reaps_child_and_readers_v2(self):
        self._assert_failed_entry_reaps(protocol_v2=True)

    def test_retry_after_failed_entry_starts_fresh_worker(self):
        tool = self._tool()
        client, resources = self._make_client((tool, tool))
        try:
            with self.assertRaises(RpcCommandError):
                client.__enter__()
            self.assertEqual(client.set_custom_tools((tool,)), (tool.name,))
            with client:
                self.assertEqual(client.request_raw("ping"), {})
                self.assertEqual(len(resources), 2)
                self.assertIsNot(resources[0][0], resources[1][0])
                self.assertIsNone(resources[1][0].poll())
            for child, stdout_reader, stderr_reader in resources:
                self.assertIsNotNone(child.poll())
                self.assertFalse(stdout_reader.is_alive())
                self.assertFalse(stderr_reader.is_alive())
        finally:
            client.stop()

    def test_successful_startup_serves_callback_before_registration_ack(self):
        seen = []

        def execute(args, _ctx):
            seen.append(args["message"])
            return "host:" + args["message"]

        client, resources = self._make_client((self._tool(execute),))
        results = []
        client.on_unknown_notification(
            lambda notification: results.append(notification.payload)
        )
        with client:
            self.assertEqual(seen, ["during startup"])
            self.assertEqual(
                results[0]["result"]["result"]["content"],
                [{"type": "text", "text": "host:during startup"}],
            )
            self.assertIsNone(resources[0][0].poll())
        child, stdout_reader, stderr_reader = resources[0]
        self.assertIsNotNone(child.poll())
        self.assertFalse(stdout_reader.is_alive())
        self.assertFalse(stderr_reader.is_alive())


if __name__ == "__main__":
    unittest.main()
