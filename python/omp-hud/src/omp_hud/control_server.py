"""Unix socket control plane for Handsfree keybinds (next/prev/quit)."""

from __future__ import annotations

import os
import socket
import threading
from collections.abc import Callable
from pathlib import Path


def runtime_dir() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    path = Path(base) / "omp-handsfree"
    path.mkdir(parents=True, exist_ok=True)
    return path


def control_socket_path() -> Path:
    return runtime_dir() / "ctl.sock"


def pid_file_path() -> Path:
    return runtime_dir() / "hud.pid"


class ControlServer:
    def __init__(self, handle: Callable[[str], str]) -> None:
        self._handle = handle
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._sock: socket.socket | None = None
        self._path = control_socket_path()

    def start(self) -> None:
        if self._thread is not None:
            return
        if self._path.exists():
            try:
                self._path.unlink()
            except OSError:
                pass
        pid_file_path().write_text(str(os.getpid()), encoding="utf-8")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(self._path))
        sock.listen(8)
        sock.settimeout(0.5)
        self._sock = sock
        self._thread = threading.Thread(
            target=self._run, name="omp-handsfree-ctl", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        sock = self._sock
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.5)
        self._thread = None
        self._sock = None
        for path in (self._path, pid_file_path()):
            try:
                path.unlink()
            except OSError:
                pass

    def _run(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except TimeoutError:
                continue
            except OSError:
                if self._stop.is_set():
                    return
                continue
            with conn:
                try:
                    data = b""
                    while b"\n" not in data and len(data) < 256:
                        chunk = conn.recv(64)
                        if not chunk:
                            break
                        data += chunk
                    cmd = data.decode(errors="replace").strip().splitlines()[0].strip().lower()
                    reply = self._handle(cmd) if cmd else "error empty"
                    if not reply.endswith("\n"):
                        reply += "\n"
                    conn.sendall(reply.encode())
                except OSError:
                    continue
