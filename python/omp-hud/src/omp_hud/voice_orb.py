"""Handsfree mic CTA: circular monochrome thinking-orb (Cairo).

The DrawingArea paints the entire control chrome so GTK does not stretch a pink
pill around a tiny glyph. Brand pink is reserved for listening/active rings.
"""

from __future__ import annotations

import math
import time
from typing import Literal

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

OrbState = Literal[
    "idle",
    "listening",
    "working",
    "thinking",
    "composing",
    "speaking",
    "error",
]

# Monochrome thinking-orbs on dark disc (design-system style).
_INK = (0.96, 0.96, 0.98)
_INK_DIM = (0.72, 0.74, 0.78)
_DISC = (0.09, 0.07, 0.12)  # #17121f
_DISC_EDGE = (0.22, 0.18, 0.28)
_CYAN = (0.35, 0.92, 0.98)  # #5ad8e6 — active only
_PINK = (0.93, 0.29, 0.75)  # #ed4abf — active ring
_ERROR = (0.94, 0.34, 0.33)


class ThinkingOrb(Gtk.DrawingArea):
    """Full circular CTA: disc + monochrome cognition glyph."""

    def __init__(self, *, size: int = 34) -> None:
        super().__init__()
        self._size = max(24, int(size))
        self.set_size_request(self._size, self._size)
        self.set_hexpand(False)
        self.set_vexpand(False)
        self._state: OrbState = "idle"
        self._level = 0.0
        self._t0 = time.monotonic()
        self._tick_id: int | None = None
        self._animate = True
        self.connect("draw", self._on_draw)
        self.connect("realize", self._on_realize)
        self.connect("unrealize", self._on_unrealize)
        self.set_app_paintable(True)

    def do_get_preferred_width(self):  # noqa: N802
        return self._size, self._size

    def do_get_preferred_height(self):  # noqa: N802
        return self._size, self._size

    def do_get_preferred_height_for_width(self, _width: int):  # noqa: N802
        return self._size, self._size

    def do_get_preferred_width_for_height(self, _height: int):  # noqa: N802
        return self._size, self._size


    @property
    def state(self) -> OrbState:
        return self._state

    def set_state(self, state: OrbState) -> None:
        if state == self._state:
            return
        self._state = state
        self._sync_tick()
        self.queue_draw()

    def set_level(self, level: float) -> None:
        clamped = max(0.0, min(1.0, float(level)))
        if abs(clamped - self._level) < 0.02:
            return
        self._level = clamped
        self.queue_draw()

    def _on_realize(self, _widget: Gtk.Widget) -> None:
        settings = Gtk.Settings.get_default()
        if settings is not None:
            self._animate = bool(settings.get_property("gtk-enable-animations"))
        self._sync_tick()

    def _on_unrealize(self, _widget: Gtk.Widget) -> None:
        self._stop_tick()

    def _sync_tick(self) -> None:
        needs = self._animate and self._state not in {"idle", "error"}
        if needs and self._tick_id is None:
            self._tick_id = GLib.timeout_add(33, self._on_tick)
        elif not needs:
            self._stop_tick()

    def _stop_tick(self) -> None:
        if self._tick_id is not None:
            GLib.source_remove(self._tick_id)
            self._tick_id = None

    def _on_tick(self) -> bool:
        self.queue_draw()
        return True

    def _now(self) -> float:
        return time.monotonic() - self._t0

    @staticmethod
    def _rgba(rgb: tuple[float, float, float], alpha: float) -> tuple[float, float, float, float]:
        return (rgb[0], rgb[1], rgb[2], max(0.0, min(1.0, alpha)))

    def _on_draw(self, _widget: Gtk.Widget, cr) -> bool:  # noqa: ANN001
        alloc = self.get_allocation()
        w = float(alloc.width)
        h = float(alloc.height)
        # Always circular — ignore rectangular stretch from parent.
        side = min(w, h)
        cx = w * 0.5
        cy = h * 0.5
        outer = side * 0.48
        t = self._now()
        state = self._state

        # Drop shadow
        cr.set_source_rgba(0, 0, 0, 0.45)
        cr.arc(cx, cy + 1.2, outer * 0.98, 0, math.tau)
        cr.fill()

        # Disc fill
        cr.set_source_rgba(*self._rgba(_DISC, 1.0))
        cr.arc(cx, cy, outer, 0, math.tau)
        cr.fill()

        # Edge ring — cyan/pink when live, quiet hairline when idle
        if state == "listening":
            ring = _CYAN
            ring_a = 0.85
            lw = max(1.8, outer * 0.08)
        elif state in {"working", "thinking", "composing", "speaking"}:
            ring = _PINK
            ring_a = 0.7
            lw = max(1.6, outer * 0.07)
        elif state == "error":
            ring = _ERROR
            ring_a = 0.95
            lw = max(1.8, outer * 0.08)
        else:
            ring = _DISC_EDGE
            ring_a = 1.0
            lw = max(1.2, outer * 0.05)
        cr.set_source_rgba(*self._rgba(ring, ring_a))
        cr.set_line_width(lw)
        cr.arc(cx, cy, outer - lw * 0.5, 0, math.tau)
        cr.stroke()

        # Soft outer glow when active
        if state not in {"idle", "error"}:
            cr.set_source_rgba(*self._rgba(ring, 0.22))
            cr.set_line_width(max(2.0, outer * 0.12))
            cr.arc(cx, cy, outer + outer * 0.06, 0, math.tau)
            cr.stroke()

        radius = outer * 0.72  # glyph inside disc

        if state == "idle":
            # Quiet monochrome listening seed — readable at rest.
            cr.set_source_rgba(*self._rgba(_INK, 0.92))
            cr.arc(cx, cy, radius * 0.22, 0, math.tau)
            cr.fill()
            cr.set_source_rgba(*self._rgba(_INK_DIM, 0.7))
            cr.set_line_width(max(1.3, radius * 0.08))
            cr.arc(cx, cy, radius * 0.48, 0, math.tau)
            cr.stroke()
            cr.set_source_rgba(*self._rgba(_INK_DIM, 0.4))
            cr.set_line_width(max(1.1, radius * 0.06))
            cr.arc(cx, cy, radius * 0.72, 0, math.tau)
            cr.stroke()
            return False

        if state == "error":
            cr.set_source_rgba(*self._rgba(_ERROR, 0.95))
            cr.set_line_width(max(1.8, radius * 0.12))
            cr.move_to(cx - radius * 0.28, cy - radius * 0.28)
            cr.line_to(cx + radius * 0.28, cy + radius * 0.28)
            cr.move_to(cx + radius * 0.28, cy - radius * 0.28)
            cr.line_to(cx - radius * 0.28, cy + radius * 0.28)
            cr.stroke()
            return False

        if state == "listening":
            level = 0.25 + 0.75 * self._level
            for i in range(3):
                phase = t * (2.0 + i * 0.35) + i * 0.7
                r = radius * (0.34 + 0.2 * i + 0.16 * level * (0.5 + 0.5 * math.sin(phase)))
                cr.set_source_rgba(*self._rgba(_INK, 0.9 - i * 0.2))
                cr.set_line_width(max(1.5, radius * 0.09))
                cr.arc(cx, cy, r, 0, math.tau)
                cr.stroke()
            spokes = 12
            for i in range(spokes):
                ang = i * (math.tau / spokes) + t * 0.4
                amp = radius * (0.22 + 0.55 * level * (0.5 + 0.5 * math.sin(t * 7.0 + i * 0.9)))
                cr.set_source_rgba(*self._rgba(_INK, 0.85))
                cr.set_line_width(max(1.4, radius * 0.07))
                cr.move_to(cx + math.cos(ang) * radius * 0.12, cy + math.sin(ang) * radius * 0.12)
                cr.line_to(cx + math.cos(ang) * amp, cy + math.sin(ang) * amp)
                cr.stroke()
            cr.set_source_rgba(*self._rgba(_INK, 0.95))
            cr.arc(cx, cy, radius * 0.12, 0, math.tau)
            cr.fill()
            return False

        if state in {"working", "thinking"}:
            orbits = 3 if state == "working" else 2
            particles = 9 if state == "working" else 6
            speed = 1.7 if state == "working" else 1.0
            for o in range(orbits):
                rr = radius * (0.32 + 0.22 * o)
                cr.set_source_rgba(*self._rgba(_INK_DIM, 0.35))
                cr.set_line_width(max(1.0, radius * 0.04))
                cr.arc(cx, cy, rr, 0, math.tau)
                cr.stroke()
                for p in range(particles):
                    ang = t * speed * (1.0 + o * 0.25) + p * (math.tau / particles) + o * 0.4
                    x = cx + math.cos(ang) * rr
                    y = cy + math.sin(ang) * rr
                    pr = max(1.6, radius * (0.08 + (p % 3) * 0.025))
                    cr.set_source_rgba(*self._rgba(_INK, 0.95 - o * 0.12))
                    cr.arc(x, y, pr, 0, math.tau)
                    cr.fill()
            cr.set_source_rgba(*self._rgba(_INK, 0.9))
            cr.arc(cx, cy, radius * 0.1, 0, math.tau)
            cr.fill()
            return False

        # composing / speaking — ribbon sash
        cr.set_line_width(max(1.8, radius * 0.1))
        for i in range(3):
            phase = t * (1.3 + i * 0.2) + i * 0.85
            cr.set_source_rgba(*self._rgba(_INK, 0.85 - i * 0.18))
            cr.new_path()
            steps = 36
            for s in range(steps + 1):
                u = s / steps
                ang = u * math.tau + phase
                wobble = 0.12 * math.sin(u * math.tau * 2 + phase)
                r = radius * (0.34 + 0.18 * i + wobble)
                x = cx + math.cos(ang) * r
                y = cy + math.sin(ang) * r * (0.78 + 0.08 * i)
                if s == 0:
                    cr.move_to(x, y)
                else:
                    cr.line_to(x, y)
            cr.stroke()
        return False


def map_voice_phase_to_orb(
    *,
    phase: str,
    voice_active: bool,
    voice_pending: bool,
    busy: bool,
) -> OrbState:
    """Map HUD voice/agent lifecycle → orb state."""
    p = (phase or "").strip().lower()
    if p in {"error"}:
        return "error"
    if voice_pending and p in {"starting", "stopping"}:
        return "working"
    if not voice_active and not voice_pending:
        return "idle"
    if p in {"listening", "captured", "recording"}:
        return "listening"
    if p in {"transcribing", "thinking", "reasoning", "starting"}:
        return "thinking"
    if p in {"speaking", "playing", "tts"}:
        return "speaking"
    if p in {"composing", "responding"}:
        return "composing"
    if busy:
        return "working"
    if voice_active:
        return "listening"
    return "idle"
