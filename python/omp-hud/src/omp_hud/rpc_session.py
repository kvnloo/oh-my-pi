from __future__ import annotations

import os
import threading
from collections.abc import Callable, Mapping
from pathlib import Path

from omp_rpc import (
    AgentEndEvent,
    ExtensionUiRequest,
    MessageUpdateEvent,
    RpcClient,
    RpcTimeoutError,
    UnknownNotification,
    VoiceLevelEvent,
    VoiceState,
    VoiceStateEvent,
    VoiceTerminalEvent,
    VoiceTranscriptEvent,
)

# bun-from-source cold start on this host often exceeds the RpcClient default
# of 30s (version alone can take ~55s). Handsfree must wait long enough for
# the ready frame or the bar shows an immediate connection error.
_DEFAULT_STARTUP_TIMEOUT_S = 180.0
_DEFAULT_REQUEST_TIMEOUT_S = 120.0

# Injected into the Handsfree coding-agent session so delegated live turns
# prefer Stage Manager and skip ceremony (approvals already yolo'd).
# Single line: multi-line argv can confuse some launch paths.
_HANDSFREE_SYSTEM_PROMPT = (
    "Handsfree Mode (Hyprland Stage Manager + voice remote): "
    "Desktop/window/stage actions are primary. Prefer stageManager.* over "
    "computer.run screenshots for switch/focus/next/prev. "
    'For "next/previous window" or "switch/focus X": call stageManager immediately. '
    "No plans, no multi-step investigation, no confirmation questions. "
    "Execute tool calls in one turn when intent is clear. Keep answers short. "
    "Never ask the user to approve tool use; this session is already auto-approved."
)



def _startup_timeout_seconds() -> float:
    raw = os.environ.get("OMP_HUD_RPC_STARTUP_TIMEOUT", "").strip()
    if not raw:
        return _DEFAULT_STARTUP_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(
            "OMP_HUD_RPC_STARTUP_TIMEOUT must be a positive number of seconds"
        ) from error
    if value <= 0:
        raise ValueError(
            "OMP_HUD_RPC_STARTUP_TIMEOUT must be a positive number of seconds"
        )
    return value


def _live_request_timeout_seconds() -> float:
    raw = os.environ.get("OMP_HUD_RPC_REQUEST_TIMEOUT", "").strip()
    if not raw:
        return _DEFAULT_REQUEST_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(
            "OMP_HUD_RPC_REQUEST_TIMEOUT must be a positive number of seconds"
        ) from error
    if value <= 0:
        raise ValueError(
            "OMP_HUD_RPC_REQUEST_TIMEOUT must be a positive number of seconds"
        )
    return value


def _handsfree_session_dir() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    path = Path(base) / "omp-handsfree" / "sessions"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _handsfree_launch_cwd() -> Path:
    """Empty project root so rpc-ui does not scan the monorepo (multi-minute hang)."""
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    path = Path(base) / "omp-handsfree" / "cwd"
    path.mkdir(parents=True, exist_ok=True)
    return path



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
        on_voice_state: Callable[[VoiceStateEvent], None],
        on_voice_transcript: Callable[[VoiceTranscriptEvent], None],
        on_voice_level: Callable[[VoiceLevelEvent], None],
        on_voice_terminal: Callable[[VoiceTerminalEvent], None],
    ) -> None:
        self._on_text = on_text
        self._on_status = on_status
        self._on_error = on_error
        self._on_closed = on_closed
        self._on_busy = on_busy
        # Dedicated session dir: never resume the interactive workspace
        # transcript (that path can stall rpc-ui ready for minutes).
        session_dir = _handsfree_session_dir()
        launch_cwd = _handsfree_launch_cwd()
        # computer tool actions are exec-tier → write mode still prompts.
        # Handsfree is a voice remote: yolo + auto UI confirms.
        # Launch cwd must stay light: monorepo cwd made ready hang 2–3+ min.
        self._client = RpcClient(
            executable=executable,
            cwd=launch_cwd,
            session_dir=session_dir,
            append_system_prompt=_HANDSFREE_SYSTEM_PROMPT,
            tools=("computer",),
            no_skills=True,
            no_rules=True,
            extra_args=("--approval-mode", "yolo"),
            startup_timeout=_startup_timeout_seconds(),
            # live_start does WebRTC + Codex signaling; 30s is too short cold.
            request_timeout=_live_request_timeout_seconds(),
        )
        self._client.on_ready(lambda _event: self._on_status("Ready"))
        self._client.on_agent_start(lambda _event: self._on_busy(True))
        self._client.on_agent_end(self._handle_agent_end)
        self._client.on_message_update(self._handle_message_update)
        self._client.on_ui_request(on_ui_request)
        self._client.on_voice_state(on_voice_state)
        self._client.on_voice_transcript(on_voice_transcript)
        self._client.on_voice_level(on_voice_level)
        self._client.on_voice_terminal(on_voice_terminal)
        self._client.on_protocol_error(lambda error: self._on_error(str(error)))
        self._client.on_extension_error(lambda error: self._on_error(str(error)))
        self._client.on_unknown_notification(self._handle_unknown_notification)
        self._client.on_close(self._handle_close)
        self._closed = threading.Event()

    def start(self) -> None:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        timeout = _startup_timeout_seconds()
        self._on_status(f"Starting OMP… (up to {int(timeout)}s)")
        try:
            self._client.start()
            if not self._closed.is_set():
                self._on_status("Enabling ComputerTool…")
                agent_invoked = self._client.prompt("/computer on")
                if not agent_invoked:
                    self._on_status("Ready")
        except RpcTimeoutError as error:
            stderr = ""
            try:
                stderr = (self._client.stderr or "").strip()
            except Exception:
                pass
            detail = str(error)
            if stderr:
                detail = f"{detail}\n{stderr[-1500:]}"
            raise RpcTimeoutError(
                "OMP did not become ready in time. Cold `bun` launches of the "
                "coding-agent source tree often need 60–120s; set "
                "OMP_HUD_RPC_STARTUP_TIMEOUT higher if needed. "
                f"Detail: {detail}"
            ) from error
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

    def start_dictation(self) -> VoiceState:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.start_dictation()

    def stop_dictation(self) -> VoiceState:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.stop_dictation()

    def cancel_dictation(self) -> VoiceState:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.cancel_dictation()

    def start_live(self) -> VoiceState:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.start_live()

    def stop_live(self) -> VoiceState:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.stop_live()

    def toggle_live_mute(self) -> VoiceState:
        if self._closed.is_set():
            raise RuntimeError("OMP session is closed")
        return self._client.toggle_live_mute()

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
                normalized = text.lstrip()
                if normalized.startswith(
                    ("Computer use enabled", "Computer use is already enabled")
                ):
                    self._on_status("ComputerTool ready")
                else:
                    self._on_text(text)
        elif event_type == "prompt_result" and event.payload.get("agentInvoked") is False:
            self._on_status("Ready")

    def _handle_message_update(self, event: MessageUpdateEvent) -> None:
        delta = extract_text_delta(event.assistant_message_event)
        if delta is not None:
            self._on_text(delta)
