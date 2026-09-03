from __future__ import annotations

import time
import unittest
from collections import deque
from types import SimpleNamespace

from omp_rpc import ExtensionUiRequest

from omp_hud.app import HudWindow


class UiRequestStateTests(unittest.TestCase):
    def test_interactive_requests_queue_behind_active_dialog(self) -> None:
        queued: deque[tuple[ExtensionUiRequest, float | None]] = deque()
        state = SimpleNamespace(
            _active_dialog=object(),
            _active_request_id="active",
            _active_request_withdrawn=False,
            _pending_ui_requests=queued,
        )
        request = ExtensionUiRequest(
            id="next", method="confirm", title="Continue?", timeout=500
        )

        self.assertFalse(HudWindow._handle_ui_request(state, request))

        self.assertEqual(request, queued[0][0])
        self.assertIsNotNone(queued[0][1])

    def test_server_cancel_removes_queued_request(self) -> None:
        keep = ExtensionUiRequest(id="keep", method="input")
        cancel = ExtensionUiRequest(id="cancel-me", method="editor")
        state = SimpleNamespace(
            _active_dialog=None,
            _active_request_id=None,
            _active_request_withdrawn=False,
            _pending_ui_requests=deque([(keep, None), (cancel, None)]),
        )
        request = ExtensionUiRequest(id="withdraw", method="cancel", target_id="cancel-me")

        self.assertFalse(HudWindow._handle_ui_request(state, request))

        self.assertEqual([(keep, None)], list(state._pending_ui_requests))

    def test_expired_queued_request_is_never_presented(self) -> None:
        request = ExtensionUiRequest(id="expired", method="confirm", timeout=100)
        presented: list[ExtensionUiRequest] = []
        state = SimpleNamespace(
            _active_dialog=None,
            _pending_ui_requests=deque([(request, time.monotonic() - 1)]),
            _handle_ui_request=presented.append,
        )

        self.assertFalse(HudWindow._show_next_ui_request(state))

        self.assertEqual([], presented)
        self.assertEqual([], list(state._pending_ui_requests))

    def test_keyed_status_and_widget_updates_replace_and_remove(self) -> None:
        renders: list[str] = []
        state = SimpleNamespace(
            _extension_statuses={},
            _widgets={},
            _render_status=lambda: renders.append("status"),
            _render_widgets=lambda: renders.append("widgets"),
        )

        HudWindow._handle_ui_request(
            state,
            ExtensionUiRequest(
                id="status-1", method="setStatus", status_key="sync", status_text="Syncing"
            ),
        )
        HudWindow._handle_ui_request(
            state,
            ExtensionUiRequest(
                id="status-2", method="setStatus", status_key="sync", status_text=None
            ),
        )
        HudWindow._handle_ui_request(
            state,
            ExtensionUiRequest(
                id="widget-1",
                method="setWidget",
                widget_key="usage",
                widget_lines=("12%",),
                widget_placement="belowEditor",
            ),
        )
        HudWindow._handle_ui_request(
            state,
            ExtensionUiRequest(
                id="widget-2", method="setWidget", widget_key="usage", widget_lines=None
            ),
        )

        self.assertEqual({}, state._extension_statuses)
        self.assertEqual({}, state._widgets)
        self.assertEqual(["status", "status", "widgets", "widgets"], renders)


if __name__ == "__main__":
    unittest.main()
