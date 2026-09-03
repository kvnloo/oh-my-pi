from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from pathlib import Path

from omp_rpc import AgentEndEvent, ExtensionUiRequest, MessageUpdateEvent, RpcClient, UnknownNotification

def extract_text_delta(event: Mapping[str, object]) -> str | None:
    if event.get("type") != "text_delta":
        return None
    delta = event.get("delta")
    return delta if isinstance(delta, str) else None



class HudRpcSession:
    def __init__(
        self,
        *,
        executable: str,
        cwd: Path,
        on_text: Callable[[str], None],
        on_status: Callable[[str], None],
        on_error: Callable[[str], None],
        on_closed: Callable[[str], None],
        on_busy: Callable[[bool], None],
        on_ui_request: Callable[[ExtensionUiRequest], None],
    ) -> None:
        self._on_text = on_text
        self._on_status = on_status
        self._on_error = on_error
        self._on_closed = on_closed
        self._on_busy = on_busy
        self._client = RpcClient(executable=executable, cwd=cwd)
        self._client.on_ready(lambda _event: self._on_status("Ready"))
        self._client.on_agent_start(lambda _event: self._on_busy(True))
        self._client.on_agent_end(self._handle_agent_end)
        self._client.on_message_update(self._handle_message_update)
        self._client.on_ui_request(on_ui_request)
        self._client.on_protocol_error(lambda error: self._on_error(str(error)))
        self._client.on_extension_error(lambda error: self._on_error(str(error)))
        self._client.on_unknown_notification(self._handle_unknown_notification)
        self._client.on_close(self._handle_close)
        self._closed = threading.Event()

    def start(self) -> None:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        self._on_status("Starting OMP…")
        try:
            self._client.start()
        finally:
            if self._closed.is_set():
                self._client.stop()

    def submit(self, text: str) -> bool:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.prompt(text)

    def abort(self) -> None:
        if self._closed.is_set():
            return
        self._client.abort()

    def respond_confirmation(self, request_id: str, confirmed: bool) -> None:
        self._client.send_ui_confirmation(request_id, confirmed)

    def respond_value(self, request_id: str, value: str) -> None:
        self._client.send_ui_value(request_id, value)

    def cancel_request(self, request_id: str) -> None:
        self._client.cancel_ui_request(request_id)

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        self._client.stop()

    def _handle_agent_end(self, event: AgentEndEvent) -> None:
        if event.is_terminal is not False:
            self._on_busy(False)

    def _handle_close(self, error: BaseException) -> None:
        if not self._closed.is_set():
            self._on_closed(str(error))

    def _handle_unknown_notification(self, event: UnknownNotification) -> None:
        event_type = event.payload.get("type")
        if event_type == "command_output":
            text = event.payload.get("text")
            if isinstance(text, str):
                self._on_text(text)
        elif event_type == "prompt_result" and event.payload.get("agentInvoked") is False:
            self._on_status("Ready")

    def _handle_message_update(self, event: MessageUpdateEvent) -> None:
        delta = extract_text_delta(event.assistant_message_event)
        if delta is not None:
            self._on_text(delta)
