from __future__ import annotations

import sys
import threading
import unittest

from omp_rpc import RpcClient, RpcCommandError, RpcTimeoutError, host_tool, host_uri

from .test_client import STARTUP_REGISTRATION_SERVER

# Keep the existing real subprocess ready/negotiation/tool-callback fixture.
# Add atomic URI registration and observable reads for lifecycle composition.
COMPOSITION_SERVER = STARTUP_REGISTRATION_SERVER.replace(
    "pending_registration = None\n",
    "pending_registration = None\nregistered_uris = []\npending_uri_registration = None\n",
    1,
).replace(
    '    elif command["type"] == "host_tool_result":',
    """    elif command["type"] == "set_host_uri_schemes":
        import re
        schemes = command["schemes"]
        if any(not re.fullmatch(r"[a-z][a-z0-9+.-]*", item["scheme"]) for item in schemes):
            respond(command, error="Host URI scheme contains invalid characters")
            if registered_uris:
                print(json.dumps({"type": "host_uri_request", "id": "after-rejection", "operation": "read", "url": registered_uris[0] + "://row"}), flush=True)
            continue
        registered_uris = [item["scheme"] for item in schemes]
        if not registered_uris:
            respond(command, data={"schemes": []})
            continue
        pending_uri_registration = command
        print(json.dumps({"type": "host_uri_request", "id": "before-uri-ack", "operation": "read", "url": registered_uris[0] + "://row"}), flush=True)
    elif command["type"] == "host_uri_result":
        print(json.dumps({"type": "composition_uri_result", "result": command}), flush=True)
        if pending_uri_registration is not None:
            if registered_uris != ["uncertain"]:
                respond(pending_uri_registration, data={"schemes": registered_uris})
            pending_uri_registration = None
    elif command["type"] == "trigger_registered_read":
        scheme = command["url"].split(":", 1)[0]
        if scheme not in registered_uris:
            respond(command, error="server scheme not registered")
            continue
        print(json.dumps({"type": "host_uri_request", "id": "triggered-read", "operation": "read", "url": command["url"]}), flush=True)
        respond(command, data={})
    elif command["type"] == "host_tool_result":""",
    1,
)


class RegistrationCompositionTests(unittest.TestCase):
    def _make_client(self, protocol_v2, initial_scheme):
        tool_calls = []

        def execute(args, _ctx):
            tool_calls.append(args["message"])
            return "tool:" + args["message"]

        client = RpcClient(
            command=[sys.executable, "-u", "-c", COMPOSITION_SERVER],
            custom_tools=(
                host_tool(
                    name="startup_echo",
                    description="Composition startup callback",
                    parameters={"type": "object"},
                    execute=execute,
                ),
            ),
            host_uris=(self._uri(initial_scheme),),
            startup_timeout=2.0,
            request_timeout=0.3,
            env={"STARTUP_PROTOCOL_V2": "1" if protocol_v2 else "0"},
        )
        resources = []
        uri_results = []
        uri_result_ready = threading.Event()
        client._test_composition_uri_ready = uri_result_ready
        tool_results = []

        def capture_ready(notification):
            if notification.type == "ready":
                resources.append(
                    (client._process, client._stdout_thread, client._stderr_thread)
                )

        def capture_result(notification):
            if notification.payload.get("type") == "composition_uri_result":
                uri_results.append(notification.payload["result"])
                uri_result_ready.set()
            elif notification.payload.get("type") == "startup_tool_result":
                tool_results.append(notification.payload["result"])

        client.on_notification(capture_ready)
        client.on_unknown_notification(capture_result)
        self.addCleanup(client.stop)
        return client, resources, uri_results, tool_calls, tool_results

    def _uri(self, scheme):
        return host_uri(scheme=scheme, read=lambda url, ctx: "accepted:" + scheme)

    def _assert_stopped(self, client, resource):
        child, stdout_reader, stderr_reader = resource
        self.assertEqual(
            (
                child.poll() is not None,
                not stdout_reader.is_alive(),
                not stderr_reader.is_alive(),
            ),
            (True, True, True),
        )
        self.assertIsNone(client._process)
        self.assertEqual(client.survivor_pids, ())
        self.assertEqual(client._pending, {})
        self.assertEqual(client._pending_host_tool_calls, {})
        self.assertEqual(client._pending_host_uri_requests, {})

    def _assert_uri_results(self, client, results, scheme):
        # Host handlers run asynchronously; wait for the actual echoed result.
        self.assertTrue(client._test_composition_uri_ready.wait(2.0))
        client.request_raw("ping")
        self.assertTrue(results, "the server must dispatch an accepted URI read")
        for result in results:
            self.assertNotIn("isError", result)
            self.assertEqual(result.get("content"), "accepted:" + scheme)
        results.clear()
        client._test_composition_uri_ready.clear()

    def _exercise_rejection_retry_restart(self, protocol_v2):
        client, resources, results, tool_calls, tool_results = self._make_client(
            protocol_v2, "1bad"
        )
        with self.assertRaises(RpcCommandError) as caught, client:
            self.fail("invalid initial URI registration entered its context")
        self.assertEqual(caught.exception.command, "set_host_uri_schemes")
        self.assertIn("invalid characters", caught.exception.error)
        self.assertEqual(tool_calls, ["during startup"])
        self.assertEqual(
            tool_results[0]["result"]["content"],
            [{"type": "text", "text": "tool:during startup"}],
        )
        self._assert_stopped(client, resources[0])

        # Correct while stopped, then successfully retry the same client.
        self.assertEqual(client.set_host_uris((self._uri("db"),)), ("db",))
        client.start()
        self.assertIsNot(resources[0][0], resources[1][0])
        self._assert_uri_results(client, results, "db")
        client.stop()
        self._assert_stopped(client, resources[1])

        # After restart, replacement and rejection must agree with server state.
        client.start()
        self._assert_uri_results(client, results, "db")
        self.assertEqual(client.set_host_uris((self._uri("new"),)), ("new",))
        self._assert_uri_results(client, results, "new")
        with self.assertRaises(RpcCommandError) as rejected:
            client.set_host_uris((self._uri("1bad"),))
        self.assertEqual(rejected.exception.command, "set_host_uri_schemes")
        self._assert_uri_results(client, results, "new")
        client.request_raw("trigger_registered_read", url="new://row")
        self._assert_uri_results(client, results, "new")
        client.stop()
        self._assert_stopped(client, resources[2])

        # The accepted handler survives another stop/restart, not the rejected set.
        with client:
            self._assert_uri_results(client, results, "new")
            self.assertEqual(len(tool_calls), 4)
        self._assert_stopped(client, resources[3])

    def test_rejection_retry_restart_preserves_handlers_v1(self):
        self._exercise_rejection_retry_restart(protocol_v2=False)

    def test_rejection_retry_restart_preserves_handlers_v2(self):
        self._exercise_rejection_retry_restart(protocol_v2=True)

    def _exercise_timeout_lifetimes(self, protocol_v2):
        client, resources, results, _calls, _tool_results = self._make_client(
            protocol_v2, "uncertain"
        )
        with self.assertRaises(RpcTimeoutError), client:
            self.fail("unacknowledged startup entered its context")
        # Startup failure cleans the worker even though the server accepted the set.
        self.assertEqual(results[0].get("content"), "accepted:uncertain")
        results.clear()
        self._assert_stopped(client, resources[0])

        client.set_host_uris((self._uri("db"),))
        with client:
            self._assert_uri_results(client, results, "db")
            with self.assertRaises(RpcTimeoutError):
                client.set_host_uris((self._uri("uncertain"),))
            # A runtime timeout is uncertain: keep serving accepted callbacks.
            self.assertIsNone(resources[1][0].poll())
            self.assertTrue(resources[1][1].is_alive())
            self.assertTrue(resources[1][2].is_alive())
            self._assert_uri_results(client, results, "uncertain")
            client.request_raw("trigger_registered_read", url="uncertain://row")
            self._assert_uri_results(client, results, "uncertain")
        self._assert_stopped(client, resources[1])

    def test_initial_timeout_cleanup_differs_from_runtime_uncertainty_v1(self):
        self._exercise_timeout_lifetimes(protocol_v2=False)

    def test_initial_timeout_cleanup_differs_from_runtime_uncertainty_v2(self):
        self._exercise_timeout_lifetimes(protocol_v2=True)


if __name__ == "__main__":
    unittest.main()
