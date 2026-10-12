from __future__ import annotations

import sys
import textwrap
import threading
import time
import unittest

from omp_rpc import RpcClient, RpcCommandError, RpcError, RpcTimeoutError, host_uri
from omp_rpc.host_uris import normalize_read_result

URI_SERVER = textwrap.dedent(
    """
    import json
    import re
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    pending_uri_id = 1
    registered = []
    pending_registration = None
    timed_out_registration = None

    def respond(request_id, command, data=None, success=True, error=None):
        frame = {"id": request_id, "type": "response", "command": command, "success": success}
        if success:
            if data is not None:
                frame["data"] = data
        else:
            frame["error"] = error or "error"
        print(json.dumps(frame), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        command = json.loads(raw_line)
        command_type = command.get("type")
        request_id = command.get("id")

        if command_type == "set_host_uri_schemes":
            schemes = command.get("schemes", [])
            if schemes and schemes[0]["scheme"] == "1late":
                timed_out_registration = command
                continue
            if any(not re.fullmatch(r"[a-z][a-z0-9+.-]*", entry["scheme"]) for entry in schemes):
                error_id = None if schemes[0]["scheme"] == "1idless" else request_id
                respond(error_id, command_type, success=False, error="invalid scheme")
                if registered:
                    print(json.dumps({"type": "host_uri_request", "id": "after-rejection", "operation": "read", "url": registered[0] + "://row"}), flush=True)
                continue
            registered = [entry["scheme"] for entry in schemes]
            if registered == ["early"]:
                pending_registration = command
                print(json.dumps({"type": "host_uri_request", "id": "early-read", "operation": "read", "url": "early://row"}), flush=True)
                continue
            if registered == ["uncertain"]:
                continue
            if timed_out_registration is not None:
                respond(timed_out_registration["id"], command_type, success=False, error="late failure")
                timed_out_registration = None
            respond(
                request_id,
                "set_host_uri_schemes",
                {"schemes": [entry.get("scheme", "") for entry in schemes]},
            )
        elif command_type == "trigger_registered_read":
            if command["url"].split(":", 1)[0] not in registered:
                respond(request_id, command_type, success=False, error="server scheme not registered")
                continue
            print(json.dumps({"type": "host_uri_request", "id": f"uri-req-{pending_uri_id}", "operation": "read", "url": command["url"]}), flush=True)
            pending_uri_id += 1
            respond(request_id, command_type, {})
        elif command_type == "trigger_read":
            print(
                json.dumps(
                    {
                        "type": "host_uri_request",
                        "id": f"uri-req-{pending_uri_id}",
                        "operation": "read",
                        "url": command["url"],
                    }
                ),
                flush=True,
            )
            pending_uri_id += 1
            respond(request_id, "trigger_read", {})
        elif command_type == "trigger_write":
            print(
                json.dumps(
                    {
                        "type": "host_uri_request",
                        "id": f"uri-req-{pending_uri_id}",
                        "operation": "write",
                        "url": command["url"],
                        "content": command["content"],
                    }
                ),
                flush=True,
            )
            pending_uri_id += 1
            respond(request_id, "trigger_write", {})
        elif command_type == "host_uri_result":
            # Re-emit the host_uri_result frame as an unknown notification
            # so the test can capture it through on_unknown_notification.
            print(
                json.dumps(
                    {
                        "type": "uri_echo",
                        "frame": command,
                    }
                ),
                flush=True,
            )
            if pending_registration is not None:
                respond(pending_registration["id"], "set_host_uri_schemes", {"schemes": registered})
                pending_registration = None
        else:
            respond(request_id, command_type, success=False, error=f"unsupported: {command_type}")
    """
)


class HostUriHelperTests(unittest.TestCase):
    def test_normalize_read_result_accepts_string(self) -> None:
        self.assertEqual(normalize_read_result("hello"), {"content": "hello"})

    def test_normalize_read_result_accepts_full_mapping(self) -> None:
        result = normalize_read_result(
            {
                "content": "body",
                "content_type": "application/json",
                "notes": ["fresh"],
                "immutable": True,
            }
        )
        self.assertEqual(result["content"], "body")
        self.assertEqual(result["contentType"], "application/json")
        self.assertEqual(result["notes"], ["fresh"])
        self.assertTrue(result["immutable"])

    def test_normalize_read_result_requires_content(self) -> None:
        with self.assertRaises(ValueError):
            normalize_read_result({"content_type": "text/plain"})  # type: ignore[arg-type]

    def test_normalize_read_result_rejects_invalid_content_type(self) -> None:
        with self.assertRaises(ValueError):
            normalize_read_result(
                {"content": "x", "content_type": "application/octet-stream"}
            )  # type: ignore[arg-type]

    def test_host_uri_helper_normalizes_scheme(self) -> None:
        uri = host_uri(scheme="  DB  ", read=lambda url, ctx: "x")
        self.assertEqual(uri.scheme, "db")
        self.assertFalse(uri.writable)

        with self.assertRaises(ValueError):
            host_uri(scheme="", read=lambda url, ctx: "x")

    def test_host_uri_writable_when_write_supplied(self) -> None:
        uri = host_uri(
            scheme="db", read=lambda url, ctx: "x", write=lambda url, content, ctx: None
        )
        self.assertTrue(uri.writable)


class RpcHostUriBridgeTests(unittest.TestCase):
    def _make_client(
        self, client_type: type[RpcClient] = RpcClient, **kwargs: object
    ) -> RpcClient:
        client = client_type(
            command=[sys.executable, "-u", "-c", URI_SERVER],
            startup_timeout=2.0,
            request_timeout=2.0,
            **kwargs,
        )
        self._attach_capture(client)
        return client

    def test_set_host_uris_registers_schemes_on_start(self) -> None:
        captured: list[tuple[str, str]] = []

        def read_db(url: str, _ctx) -> str:
            captured.append(("read", url))
            return "id=42"

        with self._make_client(
            host_uris=(host_uri(scheme="db", read=read_db, description="test rows"),),
        ) as client:
            # No public list — we exercise the on-start side effect by hitting the wire.
            payload = client._request("trigger_read", url="db://users/42")  # type: ignore[attr-defined]
            self.assertEqual(payload, {})

            frame = self._await_echo(client)
            self.assertEqual(frame["type"], "host_uri_result")
            self.assertEqual(frame["content"], "id=42")
            self.assertEqual(captured, [("read", "db://users/42")])

    def test_rejected_replacement_preserves_registered_handler(self) -> None:
        rejection_echo = threading.Event()

        class DelayedRejectionClient(RpcClient):
            def _request_data(self, *args, **kwargs):
                try:
                    return super()._request_data(*args, **kwargs)
                except RpcCommandError:
                    # Keep the setter suspended until the reader dispatches the
                    # callback immediately following the unsuccessful response.
                    if not rejection_echo.wait(1.0):
                        raise AssertionError("rejection callback did not arrive")
                    raise

        with self._make_client(client_type=DelayedRejectionClient) as client:
            client.on_unknown_notification(
                lambda notification: (
                    rejection_echo.set()
                    if notification.payload.get("type") == "uri_echo"
                    else None
                )
            )
            self.assertEqual(
                client.set_host_uris(
                    (host_uri(scheme="db", read=lambda url, ctx: "accepted"),)
                ),
                ("db",),
            )
            with self.assertRaisesRegex(RpcCommandError, "invalid scheme"):
                client.set_host_uris(
                    (host_uri(scheme="1bad", read=lambda url, ctx: "rejected"),)
                )
            self.assertEqual(self._await_echo(client).get("content"), "accepted")
            client.request_raw("trigger_registered_read", url="db://row")
            self.assertEqual(self._await_echo(client).get("content"), "accepted")

    def test_successful_replacement_removes_previous_handler(self) -> None:
        with self._make_client(
            host_uris=(host_uri(scheme="db", read=lambda url, ctx: "old"),)
        ) as client:
            self.assertEqual(
                client.set_host_uris(
                    (host_uri(scheme="new", read=lambda url, ctx: "new"),)
                ),
                ("new",),
            )
            client.request_raw("trigger_registered_read", url="new://row")
            self.assertEqual(self._await_echo(client).get("content"), "new")
            with self.assertRaisesRegex(
                RpcCommandError, "server scheme not registered"
            ):
                client.request_raw("trigger_registered_read", url="db://row")
            client.request_raw("trigger_read", url="db://row")
            self.assertIn("not registered", self._await_echo(client)["error"])

    def test_registration_handler_available_before_acknowledgement(self) -> None:
        with self._make_client() as client:
            self.assertEqual(
                client.set_host_uris(
                    (host_uri(scheme="early", read=lambda url, ctx: "before ack"),)
                ),
                ("early",),
            )
            self.assertEqual(self._await_echo(client).get("content"), "before ack")

    def test_timeout_does_not_imply_rejected_registration(self) -> None:
        client = RpcClient(
            command=[sys.executable, "-u", "-c", URI_SERVER],
            startup_timeout=2.0,
            request_timeout=0.1,
        )
        self._attach_capture(client)
        with client:
            client.set_host_uris((host_uri(scheme="db", read=lambda url, ctx: "old"),))
            with self.assertRaises(RpcTimeoutError):
                client.set_host_uris(
                    (
                        host_uri(
                            scheme="uncertain",
                            read=lambda url, ctx: "accepted without ack",
                        ),
                    )
                )
            client.request_raw("trigger_registered_read", url="uncertain://row")
            self.assertEqual(
                self._await_echo(client).get("content"), "accepted without ack"
            )

    def test_idless_rejection_preserves_registered_handler(self) -> None:
        with self._make_client(
            host_uris=(host_uri(scheme="db", read=lambda url, ctx: "accepted"),)
        ) as client:
            with self.assertRaisesRegex(RpcCommandError, "invalid scheme"):
                client.set_host_uris(
                    (host_uri(scheme="1idless", read=lambda url, ctx: "bad"),)
                )
            self.assertEqual(self._await_echo(client).get("content"), "accepted")

    def test_late_identified_failure_does_not_roll_back_newer_handlers(self) -> None:
        client = RpcClient(
            command=[sys.executable, "-u", "-c", URI_SERVER],
            startup_timeout=2.0,
            request_timeout=0.1,
        )
        self._attach_capture(client)
        with client:
            with self.assertRaises(RpcTimeoutError):
                client.set_host_uris(
                    (host_uri(scheme="1late", read=lambda url, ctx: "uncertain"),)
                )
            # Legacy command fallback misroutes the expired response (#12555).
            # This fix must not turn that existing error into lost new handlers.
            with self.assertRaisesRegex(RpcCommandError, "late failure"):
                client.set_host_uris(
                    (host_uri(scheme="new", read=lambda url, ctx: "new accepted"),)
                )
            client.request_raw("trigger_registered_read", url="new://row")
            self.assertEqual(self._await_echo(client).get("content"), "new accepted")

    def test_concurrent_rejection_does_not_undo_successful_registration(self) -> None:
        first_callback = threading.Event()
        release_callback = threading.Event()
        contender_ready = threading.Event()
        errors: list[BaseException] = []
        results: list[tuple[str, ...]] = []

        class ObservedLock:
            def __init__(self):
                self.lock = threading.Lock()

            def __enter__(self):
                if not self.lock.acquire(blocking=False):
                    contender_ready.set()
                    self.lock.acquire()

            def __exit__(self, *_args):
                self.lock.release()

        def early_read(_url, _ctx):
            first_callback.set()
            if not release_callback.wait(1.0):
                raise AssertionError("callback was not released")
            return "first accepted"

        with self._make_client() as client:
            # Observe contention without sleeps or changing registration behavior.
            client._host_uri_registration_lock = ObservedLock()

            def register_first():
                try:
                    results.append(
                        client.set_host_uris(
                            (host_uri(scheme="early", read=early_read),)
                        )
                    )
                except (RpcError, AssertionError) as error:
                    errors.append(error)

            def reject_second():
                try:
                    client.set_host_uris(
                        (host_uri(scheme="1bad", read=lambda url, ctx: "bad"),)
                    )
                except RpcCommandError:
                    pass
                except (RpcError, AssertionError) as error:
                    errors.append(error)
                else:
                    errors.append(AssertionError("invalid registration succeeded"))
                finally:
                    # Baseline may finish the second call instead of serializing.
                    # Either schedule must preserve the accepted first handler.
                    contender_ready.set()

            first = threading.Thread(target=register_first)
            second = threading.Thread(target=reject_second)
            first.start()
            try:
                self.assertTrue(first_callback.wait(1.0))
                second.start()
                self.assertTrue(contender_ready.wait(1.0))
            finally:
                release_callback.set()
                first.join(3.0)
                if second.ident is not None:
                    second.join(3.0)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(results, [("early",)])
            self.assertEqual(self._await_echo(client).get("content"), "first accepted")
            self.assertEqual(self._await_echo(client).get("content"), "first accepted")
            client.request_raw("trigger_registered_read", url="early://row")
            self.assertEqual(self._await_echo(client).get("content"), "first accepted")

    def test_read_handler_can_return_structured_result(self) -> None:
        def read_db(_url: str, _ctx):
            return {
                "content": '{"name":"Alice"}',
                "content_type": "application/json",
                "notes": ["row fresh"],
                "immutable": True,
            }

        with self._make_client(
            host_uris=(host_uri(scheme="db", read=read_db),)
        ) as client:
            client._request("trigger_read", url="db://users/42")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertEqual(frame["content"], '{"name":"Alice"}')
            self.assertEqual(frame["contentType"], "application/json")
            self.assertEqual(frame["notes"], ["row fresh"])
            self.assertTrue(frame["immutable"])

    def test_write_handler_receives_content_and_succeeds(self) -> None:
        seen: dict[str, str] = {}

        def write_db(url: str, content: str, _ctx) -> None:
            seen[url] = content

        uri = host_uri(scheme="db", read=lambda url, ctx: "ignored", write=write_db)
        with self._make_client(host_uris=(uri,)) as client:
            client._request("trigger_write", url="db://users/42", content="name=Bob")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertEqual(frame["type"], "host_uri_result")
            self.assertNotIn("isError", frame)
            self.assertEqual(seen, {"db://users/42": "name=Bob"})

    def test_write_rejected_for_read_only_scheme(self) -> None:
        with self._make_client(
            host_uris=(host_uri(scheme="db", read=lambda url, ctx: "x"),),
        ) as client:
            client._request("trigger_write", url="db://users/42", content="ignored")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertTrue(frame.get("isError"))
            self.assertIn("write handler", frame["error"])

    def test_unknown_scheme_is_rejected_with_error(self) -> None:
        with self._make_client(
            host_uris=(host_uri(scheme="db", read=lambda url, ctx: "x"),),
        ) as client:
            client._request("trigger_read", url="other://stuff")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertTrue(frame.get("isError"))
            self.assertIn("not registered", frame["error"])

    def test_handler_exception_is_surfaced_as_error(self) -> None:
        def read_db(_url: str, _ctx) -> str:
            raise RuntimeError("boom")

        with self._make_client(
            host_uris=(host_uri(scheme="db", read=read_db),)
        ) as client:
            client._request("trigger_read", url="db://users/42")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertTrue(frame.get("isError"))
            self.assertEqual(frame["error"], "boom")

    def _await_echo(self, client: RpcClient) -> dict:
        captured = getattr(client, "_test_uri_echos", None)
        if captured is None:
            self.fail("_capture was not called for this client")
        deadline = time.time() + 2.0
        while time.time() < deadline:
            if captured:
                return captured.pop(0)
            time.sleep(0.02)
        self.fail("Timed out waiting for host_uri_result echo")

    def _attach_capture(self, client: RpcClient) -> None:
        captured: list[dict] = []
        client._test_uri_echos = captured  # type: ignore[attr-defined]

        def on_notification(notification) -> None:
            payload = notification.payload
            if payload.get("type") == "uri_echo":
                frame = payload.get("frame")
                if isinstance(frame, dict):
                    captured.append(frame)

        client.on_unknown_notification(on_notification)


if __name__ == "__main__":
    unittest.main()
