from __future__ import annotations

import argparse
import signal
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import Gdk, GLib, Gtk, GtkLayerShell, Pango
from omp_rpc import ExtensionUiRequest

from .hyprland import ContextMonitor, HyprlandContext
from .rpc_session import HudRpcSession


_CSS = b"""
#omp-hud {
  background: rgba(20, 22, 28, 0.96);
  border: 1px solid rgba(125, 140, 180, 0.45);
  border-radius: 14px;
  color: #edf2ff;
}
#omp-hud entry, #omp-hud textview, #omp-hud textview text {
  background: rgba(5, 7, 12, 0.72);
  color: #edf2ff;
}
#omp-hud .context { color: #a8b6d9; }
#omp-hud .status.ready { color: #8dd7b8; }
#omp-hud .status.working { color: #e9c46a; }
#omp-hud .status.error { color: #ff8f8f; font-weight: bold; }
"""


class HudWindow(Gtk.Window):
    def __init__(
        self,
        *,
        executable: str,
        cwd: Path,
        refresh_ms: int,
        initial_prompt: str | None = None,
        abort_after_ms: int | None = None,
    ) -> None:
        super().__init__(title="OMP HUD")
        self.set_name("omp-hud")
        self.set_decorated(False)
        self.set_default_size(760, 250)
        self.set_resizable(True)

        GtkLayerShell.init_for_window(self)
        GtkLayerShell.set_namespace(self, "omp-hud")
        GtkLayerShell.set_layer(self, GtkLayerShell.Layer.TOP)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.BOTTOM, True)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.LEFT, True)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.RIGHT, True)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.BOTTOM, 18)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.LEFT, 28)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.RIGHT, 28)
        GtkLayerShell.set_exclusive_zone(self, 0)
        GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.ON_DEMAND)

        self._closing = False
        self._busy = False
        self._ready = False
        self._prompt_pending = False
        self._error_active = False
        self._abort_pending = False
        self._active_dialog: Gtk.Dialog | None = None
        self._active_request_id: str | None = None
        self._active_request_withdrawn = False
        self._active_timeout_source: int | None = None
        self._pending_ui_requests: deque[
            tuple[ExtensionUiRequest, float | None]
        ] = deque()
        self._extension_statuses: dict[str, str] = {}
        self._widgets: dict[str, tuple[str, tuple[str, ...]]] = {}
        self._initial_prompt = initial_prompt
        self._abort_after_ms = abort_after_ms
        self._build_ui()
        self._install_css()

        self._session = HudRpcSession(
            executable=executable,
            cwd=cwd,
            on_text=lambda text: GLib.idle_add(self._append_text, text),
            on_status=lambda text: GLib.idle_add(self._set_status, text),
            on_error=lambda text: GLib.idle_add(self._set_error, text),
            on_closed=lambda text: GLib.idle_add(self._session_closed, text),
            on_busy=lambda busy: GLib.idle_add(self._set_busy, busy),
            on_ui_request=lambda request: GLib.idle_add(self._handle_ui_request, request),
        )
        self._monitor = ContextMonitor(
            lambda context: GLib.idle_add(self._set_context, context),
            lambda error: GLib.idle_add(self._set_context_error, error),
            interval=refresh_ms / 1000,
        )
        self.connect("destroy", self._on_destroy)
        self._monitor.start()
        self._run_async(self._session.start, on_error=self._set_error)

    def _build_ui(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.set_border_width(14)
        self.add(root)

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self._context_label = Gtk.Label(label="Hyprland context loading…", xalign=0)
        self._context_label.get_style_context().add_class("context")
        self._context_label.set_ellipsize(Pango.EllipsizeMode.END)
        self._context_label.set_single_line_mode(True)
        self._status_label = Gtk.Label(label="Starting…", xalign=1)
        self._status_label.get_style_context().add_class("status")
        self._base_status_text = "Starting…"
        self._base_status_kind = "working"
        header.pack_start(self._context_label, True, True, 0)
        header.pack_end(self._status_label, False, False, 0)
        root.pack_start(header, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        self._scroll = scroll
        scroll.set_min_content_height(120)
        self._transcript = Gtk.TextView()
        self._transcript.set_editable(False)
        self._transcript.set_cursor_visible(False)
        self._transcript.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self._transcript.set_left_margin(10)
        self._transcript.set_right_margin(10)
        self._transcript.set_top_margin(8)
        self._transcript.set_bottom_margin(8)
        scroll.add(self._transcript)
        root.pack_start(scroll, True, True, 0)
        self._above_widget = self._build_widget_label()
        root.pack_start(self._above_widget, False, False, 0)

        composer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self._entry = Gtk.Entry()
        self._entry.set_placeholder_text("Ask OMP…")
        self._entry.set_sensitive(False)
        self._entry.connect("activate", self._on_submit)
        self._entry.connect("changed", self._on_entry_changed)
        self._send = Gtk.Button(label="Send")
        self._send.set_sensitive(False)
        self._send.connect("clicked", self._on_submit)
        self._abort = Gtk.Button(label="Abort")
        self._abort.set_sensitive(False)
        self._abort.connect("clicked", self._on_abort)
        composer.pack_start(self._entry, True, True, 0)
        composer.pack_start(self._send, False, False, 0)
        composer.pack_start(self._abort, False, False, 0)
        root.pack_start(composer, False, False, 0)
        self._below_widget = self._build_widget_label()
        root.pack_start(self._below_widget, False, False, 0)

    @staticmethod
    def _build_widget_label() -> Gtk.Label:
        label = Gtk.Label(xalign=0)
        label.set_line_wrap(True)
        label.set_selectable(True)
        label.set_no_show_all(True)
        label.hide()
        return label

    def _install_css(self) -> None:
        provider = Gtk.CssProvider()
        provider.load_from_data(_CSS)
        screen = Gdk.Screen.get_default()
        if screen is not None:
            Gtk.StyleContext.add_provider_for_screen(
                screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            )

    def _on_submit(self, _widget: Gtk.Widget) -> None:
        message = self._entry.get_text().strip()
        if not message or self._busy or self._prompt_pending:
            return
        self._error_active = False
        self._prompt_pending = True
        self._set_status("Sending…", "working")
        self._update_controls()

        def submit() -> None:
            agent_invoked = self._session.submit(message)
            GLib.idle_add(self._submission_accepted, message, agent_invoked)

        self._run_async(submit, on_error=self._submission_failed)

    def _submission_accepted(self, message: str, agent_invoked: bool) -> bool:
        if self._entry.get_text().strip() == message:
            self._entry.set_text("")
        self._append_text(f"\nYou: {message}\nOMP: ")
        if agent_invoked:
            self._set_status("Starting…", "working")
        else:
            self._prompt_pending = False
            self._set_status("Ready")
        if self._abort_after_ms is not None:
            abort_after_ms = self._abort_after_ms
            self._abort_after_ms = None
            GLib.timeout_add(abort_after_ms, self._abort_once)
        return False

    def _submission_failed(self, error: str) -> bool:
        self._set_error(error)
        self._update_controls()
        return False

    def _on_abort(self, _widget: Gtk.Widget) -> None:
        if not self._busy or self._abort_pending:
            return
        self._abort_pending = True
        self._set_status("Stopping…", "working")
        self._update_controls()
        self._run_async(self._session.abort, on_error=self._abort_failed)

    def _abort_failed(self, error: str) -> bool:
        self._abort_pending = False
        self._set_error(error)
        self._update_controls()
        return False

    def _abort_once(self) -> bool:
        if self._busy:
            self._on_abort(self._abort)
        return False


    def _set_busy(self, busy: bool) -> bool:
        self._busy = busy
        if busy:
            self._prompt_pending = False
            self._error_active = False
            self._set_status("Working…", "working")
        elif self._abort_pending:
            self._abort_pending = False
            self._append_text("[stopped by user]\n")
            self._set_status("Ready · stopped")
        elif not self._error_active:
            self._set_status("Ready")
        self._update_controls()
        if not busy:
            self._entry.grab_focus()
        return False

    def _on_entry_changed(self, _entry: Gtk.Entry) -> None:
        self._update_controls()

    def _update_controls(self) -> None:
        can_compose = self._ready and not self._busy and not self._prompt_pending
        self._entry.set_sensitive(can_compose)
        self._send.set_sensitive(can_compose and bool(self._entry.get_text().strip()))
        self._abort.set_sensitive(self._busy and not self._abort_pending)

    def _append_text(self, text: str) -> bool:
        adjustment = self._scroll.get_vadjustment()
        follows_tail = (
            adjustment.get_upper() - adjustment.get_value() - adjustment.get_page_size() <= 2
        )
        buffer = self._transcript.get_buffer()
        buffer.insert(buffer.get_end_iter(), text)
        if follows_tail:
            mark = buffer.create_mark(None, buffer.get_end_iter(), False)
            self._transcript.scroll_mark_onscreen(mark)
            buffer.delete_mark(mark)
        return False

    def _set_status(self, text: str, kind: str = "ready") -> bool:
        self._base_status_text = text
        self._base_status_kind = kind
        if kind != "error":
            self._error_active = False
        self._render_status()
        if text == "Ready":
            self._prompt_pending = False
            self._ready = True
            self._update_controls()
            self._entry.grab_focus()
            if self._initial_prompt is not None:
                initial_prompt = self._initial_prompt
                self._initial_prompt = None
                self._entry.set_text(initial_prompt)
                self._on_submit(self._entry)
        return False

    def _set_error(self, text: str) -> bool:
        self._prompt_pending = False
        self._error_active = True
        message = text.removeprefix("Error: ").strip()
        self._append_text(f"\nError: {message}\n")
        self._set_status(f"Error: {message}", "error")
        return False

    def _session_closed(self, error: str) -> bool:
        self._ready = False
        self._busy = False
        self._prompt_pending = False
        self._abort_pending = False
        self._set_error(f"OMP exited: {error}")
        self._update_controls()
        return False

    def _set_context(self, context: HyprlandContext) -> bool:
        if context.title.startswith("OMP HUD") or context.app_class == "omp-hud":
            return False
        detail = f" — {context.title}" if context.title else ""
        self._context_label.set_text(context.label + detail)
        self._context_label.set_tooltip_text(context.title or context.app_class)
        return False

    def _set_context_error(self, error: str) -> bool:
        self._context_label.set_text("Hyprland unavailable")
        self._context_label.set_tooltip_text(error)
        return False

    def _handle_ui_request(self, request: ExtensionUiRequest) -> bool:
        if request.method == "cancel":
            if request.target_id == self._active_request_id:
                self._active_request_withdrawn = True
                if self._active_dialog is not None:
                    self._active_dialog.response(Gtk.ResponseType.CANCEL)
            elif request.target_id is not None:
                self._pending_ui_requests = deque(
                    (pending, deadline)
                    for pending, deadline in self._pending_ui_requests
                    if pending.id != request.target_id
                )
            return False
        if request.method == "notify":
            self._append_text(f"\nNotice: {request.message or request.title or 'Notification'}\n")
            return False
        if request.method == "setStatus":
            key = request.status_key or "extension"
            if request.status_text:
                self._extension_statuses[key] = request.status_text
            else:
                self._extension_statuses.pop(key, None)
            self._render_status()
            return False
        if request.method == "setWidget":
            key = request.widget_key or "extension"
            if request.widget_lines:
                placement = request.widget_placement or "aboveEditor"
                self._widgets[key] = (placement, request.widget_lines)
            else:
                self._widgets.pop(key, None)
            self._render_widgets()
            return False
        if request.method == "setTitle":
            self.set_title(f"OMP HUD — {request.title}" if request.title else "OMP HUD")
            return False
        if request.method == "set_editor_text":
            self._entry.set_text(request.text or "")
            return False
        if request.method == "open_url":
            url = request.launch_url or request.url
            details = "\n".join(part for part in (request.instructions, url) if part)
            if details:
                self._append_text(f"\nOpen link:\n{details}\n")
            self._set_status("Link available")
            return False
        if not request.is_interactive():
            return False
        if self._active_dialog is not None:
            deadline = (
                time.monotonic() + request.timeout / 1000
                if request.timeout is not None and request.timeout > 0
                else None
            )
            self._pending_ui_requests.append((request, deadline))
            return False

        title = request.title or "OMP approval"
        if request.method == "confirm":
            dialog = Gtk.MessageDialog(
                transient_for=self,
                modal=True,
                message_type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.YES_NO,
                text=title,
            )
            if request.message:
                dialog.format_secondary_text(request.message)
            response, withdrawn = self._run_request_dialog(request, dialog)
            if not withdrawn:
                self._session.respond_confirmation(request.id, response == Gtk.ResponseType.YES)
            dialog.destroy()
            return False

        dialog = Gtk.Dialog(title=title, transient_for=self, modal=True)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Submit", Gtk.ResponseType.OK)
        content = dialog.get_content_area()
        if request.message:
            message = Gtk.Label(label=request.message, xalign=0)
            message.set_line_wrap(True)
            content.pack_start(message, False, False, 8)

        detail_label: Gtk.Label | None = None
        if request.method == "select":
            combo = Gtk.ComboBoxText()
            for option in request.options or ():
                combo.append_text(option)
            if request.options:
                combo.set_active(0)
            field: Gtk.Widget = combo
            detail_label = Gtk.Label(xalign=0)
            detail_label.set_line_wrap(True)
            content.pack_start(detail_label, False, False, 8)

            def update_detail(selected: Gtk.ComboBoxText) -> None:
                index = selected.get_active()
                details = request.option_details or ()
                detail = details[index].get("description") if 0 <= index < len(details) else None
                detail_label.set_text(str(detail or ""))

            combo.connect("changed", update_detail)
            update_detail(combo)
        elif request.method == "editor":
            editor = Gtk.TextView()
            editor.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
            editor.get_buffer().set_text(request.prefill or "")
            editor.set_size_request(520, 220)
            field = editor
        else:
            entry = Gtk.Entry()
            entry.set_placeholder_text(request.placeholder or "")
            entry.set_text(request.prefill or "")
            field = entry

        content.pack_start(field, True, True, 8)
        dialog.show_all()
        response, withdrawn = self._run_request_dialog(request, dialog)
        if not withdrawn:
            if response != Gtk.ResponseType.OK:
                self._session.cancel_request(request.id)
            elif isinstance(field, Gtk.ComboBoxText):
                value = field.get_active_text()
                if value is None:
                    self._session.cancel_request(request.id)
                else:
                    self._session.respond_value(request.id, value)
            elif isinstance(field, Gtk.TextView):
                buffer = field.get_buffer()
                self._session.respond_value(
                    request.id,
                    buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True),
                )
            else:
                self._session.respond_value(request.id, field.get_text())
        dialog.destroy()
        return False

    def _run_request_dialog(
        self, request: ExtensionUiRequest, dialog: Gtk.Dialog
    ) -> tuple[int, bool]:
        self._active_dialog = dialog
        self._active_request_id = request.id
        self._active_request_withdrawn = False
        if request.timeout is not None and request.timeout > 0:
            self._active_timeout_source = GLib.timeout_add(
                request.timeout, self._expire_active_dialog
            )
        response = dialog.run()
        timeout_source = self._active_timeout_source
        self._active_timeout_source = None
        if timeout_source is not None:
            GLib.source_remove(timeout_source)
        withdrawn = self._active_request_withdrawn
        self._active_dialog = None
        self._active_request_id = None
        self._active_request_withdrawn = False
        GLib.idle_add(self._show_next_ui_request)
        return response, withdrawn

    def _expire_active_dialog(self) -> bool:
        self._active_timeout_source = None
        if self._active_dialog is not None:
            self._active_dialog.response(Gtk.ResponseType.CANCEL)
        return False

    def _show_next_ui_request(self) -> bool:
        while self._active_dialog is None and self._pending_ui_requests:
            request, deadline = self._pending_ui_requests.popleft()
            if deadline is not None:
                remaining_ms = int((deadline - time.monotonic()) * 1000)
                if remaining_ms <= 0:
                    continue
                request = replace(request, timeout=max(1, remaining_ms))
            self._handle_ui_request(request)
            break
        return False

    def _render_status(self) -> None:
        style = self._status_label.get_style_context()
        for status_kind in ("ready", "working", "error"):
            style.remove_class(status_kind)
        style.add_class(self._base_status_kind)
        parts = [self._base_status_text, *self._extension_statuses.values()]
        self._status_label.set_text(" · ".join(part for part in parts if part))

    def _render_widgets(self) -> None:
        placements = {
            "aboveEditor": self._above_widget,
            "belowEditor": self._below_widget,
        }
        for placement, label in placements.items():
            rendered = [
                f"{key}: {' '.join(lines)}"
                for key, (widget_placement, lines) in self._widgets.items()
                if widget_placement == placement
            ]
            label.set_text("\n".join(rendered))
            label.set_visible(bool(rendered))

    def _run_async(
        self, operation: Callable[[], None], *, on_error: Callable[[str], object]
    ) -> None:
        def run() -> None:
            try:
                operation()
            except Exception as error:
                GLib.idle_add(on_error, str(error))

        threading.Thread(target=run, name="omp-hud-operation", daemon=True).start()

    def _on_destroy(self, _window: Gtk.Window) -> None:
        if self._closing:
            return
        self._closing = True
        self._monitor.stop()
        self._session.close()
        Gtk.main_quit()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hyprland-native HUD for OMP")
    parser.add_argument("--omp", default="omp", help="OMP executable")
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="OMP working directory")
    parser.add_argument(
        "--refresh-ms", type=int, default=750, help="Hyprland context refresh interval"
    )
    parser.add_argument("--initial-prompt", help="Submit one prompt after OMP is ready")
    parser.add_argument(
        "--abort-after-ms",
        type=int,
        help="Abort an initial prompt after this many milliseconds",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.refresh_ms < 100:
        raise SystemExit("--refresh-ms must be at least 100")
    if args.abort_after_ms is not None and args.abort_after_ms < 1:
        raise SystemExit("--abort-after-ms must be positive")
    if args.abort_after_ms is not None and args.initial_prompt is None:
        raise SystemExit("--abort-after-ms requires --initial-prompt")
    window = HudWindow(
        executable=args.omp,
        cwd=args.cwd,
        refresh_ms=args.refresh_ms,
        initial_prompt=args.initial_prompt,
        abort_after_ms=args.abort_after_ms,
    )

    def close_on_signal() -> bool:
        window.destroy()
        return GLib.SOURCE_REMOVE

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, close_on_signal)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, close_on_signal)
    window.show_all()
    Gtk.main()
