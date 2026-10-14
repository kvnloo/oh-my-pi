"""Independent review: a pre-ACK host handler performs a registration."""
import json
import threading
import time
from tests.test_host_tool_registration import HostToolRegistrationTests, tool

case = HostToolRegistrationTests()
client, frames = case.make_client(custom_tools=(tool(),), request_timeout=0.25)
nested_done = threading.Event()
nested_errors = []

def execute(_args, _context):
    try:
        result = client.set_custom_tools((tool("new", "nested accepted"),))
        print("Nested registration result:", result, flush=True)
        return "outer handler completed"
    except Exception as exc:
        nested_errors.append(repr(exc))
        raise
    finally:
        nested_done.set()

with client:
    client.request_raw("configure", mode="early")
    started = time.monotonic()
    failure = None
    try:
        print("Outer registration result:", client.set_custom_tools((tool("new", execute=execute),)), flush=True)
    except Exception as exc:
        failure = exc
        print("Outer registration failed:", repr(exc), flush=True)
    print("Outer elapsed seconds:", round(time.monotonic() - started, 3), flush=True)
    assert nested_done.wait(1), "nested registration remained blocked"
    print("First callback:", json.dumps(frames.get(timeout=1)), flush=True)
    client.request_raw("call_registered")
    print("Next callback:", json.dumps(frames.get(timeout=1)), flush=True)
    assert not nested_errors, nested_errors
    assert failure is None, failure
print("PASS")
