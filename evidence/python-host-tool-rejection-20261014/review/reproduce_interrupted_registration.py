"""Independent review: actual SIGINT during an unacknowledged registration wait."""
import json
import os
import signal
import sys
import threading
from tests.test_host_tool_registration import HostToolRegistrationTests, tool

case = HostToolRegistrationTests()
client, frames = case.make_client(custom_tools=(tool(),), request_timeout=2.0)
with client:
    client.request_raw("configure", mode="late_rejection")
    def interrupt_when_pending():
        # Main thread starts its wait immediately after queuing the request.
        # Waiting for pending state prevents interrupting setup or next setter.
        import time
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            with client._state_lock:
                pending = any(p.command == "set_host_tools" for p in client._pending.values())
            if pending:
                os.kill(os.getpid(), signal.SIGINT)
                return
            time.sleep(0.001)
        raise AssertionError("registration was never pending")
    interrupter = threading.Thread(target=interrupt_when_pending)
    interrupter.start()
    try:
        client.set_custom_tools((tool("interrupted"),))
    except KeyboardInterrupt:
        print("Interrupted first registration", flush=True)
    else:
        raise AssertionError("first registration was not interrupted")
    interrupter.join(1)
    with client._state_lock:
        print("Pending after interrupt:", list(client._pending), flush=True)
    result = client.set_custom_tools((tool("new", "new accepted"),))
    print("New registration result:", result, flush=True)
    print("Local tool names:", [t.name for t in client._custom_tools], flush=True)
    client.request_raw("call_registered")
    frame = frames.get(timeout=2)
    print("Callback result:", json.dumps(frame), flush=True)
    assert result == ("new",), result
    assert frame.get("isError") is not True, frame
    assert frame["result"]["content"] == [{"type": "text", "text": "new accepted"}], frame
print("PASS")
