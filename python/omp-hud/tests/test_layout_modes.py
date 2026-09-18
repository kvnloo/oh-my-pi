"""Layout-mode geometry and intent coverage for Handsfree demo parity."""

from __future__ import annotations

import unittest

from omp_hud.hyprland import (
    CAROUSEL_BOTTOM_SAFE,
    CarouselMonitor,
    compute_quadrant_slots,
    compute_stage_layout,
    hud_bottom_reserve,
)
from omp_hud.stage_intent import match_stage_intent


class QuadrantGeometryTests(unittest.TestCase):
    def test_bottom_row_stays_above_hud_reserve(self) -> None:
        mon = CarouselMonitor(
            id=0,
            x=3000,
            y=420,
            width=1920,
            height=1080,
            reserved=(0, 27, 0, 0),
        )
        slots = compute_quadrant_slots(mon, gap=10, bottom_reserve=CAROUSEL_BOTTOM_SAFE)
        self.assertEqual(4, len(slots))
        bottom_y = max(y + h for _x, y, _w, h in slots)
        hud_ceiling = mon.y + mon.height - CAROUSEL_BOTTOM_SAFE
        self.assertLessEqual(bottom_y, hud_ceiling + 2)

    def test_stage_layout_respects_bottom_safe(self) -> None:
        mon = CarouselMonitor(
            id=0, x=0, y=0, width=1920, height=1080, reserved=(0, 27, 0, 0)
        )
        layout = compute_stage_layout(mon, bottom_safe=CAROUSEL_BOTTOM_SAFE)
        bottom = layout.center.y + layout.center.height
        self.assertLessEqual(bottom, mon.y + mon.height - 10)

    def test_quadrant_bottom_below_hud_top(self) -> None:
        mon = CarouselMonitor(
            id=0, x=3000, y=420, width=1920, height=1080, reserved=(0, 27, 0, 0)
        )
        reserve = 98  # (1500 - 1414) + 12 on DP-1
        slots = compute_quadrant_slots(mon, gap=10, bottom_reserve=reserve)
        max_bottom = max(y + h for _x, y, _w, h in slots)
        self.assertLessEqual(max_bottom, 1414 - 8)


class HudReserveTests(unittest.TestCase):
    def test_hud_reserve_uses_live_hud_y(self) -> None:
        mon = CarouselMonitor(
            id=0, x=3000, y=420, width=1920, height=1080, reserved=(0, 27, 0, 0)
        )

        def runner(command, **kwargs):
            import subprocess
            if command[-1] == "clients":
                payload = (
                    '[{"address":"0xhud","mapped":true,"class":"__main__.py",'
                    '"title":"OMP Handsfree Mode","monitor":0,"at":[3616,1414],'
                    '"size":[688,70],"pid":99999}]'
                )
                return subprocess.CompletedProcess(command, 0, payload, "")
            return subprocess.CompletedProcess(command, 0, "[]", "")

        reserve = hud_bottom_reserve(mon, runner, margin=12)
        self.assertGreaterEqual(reserve, 80)
        self.assertLessEqual(reserve, 120)


class LayoutIntentTests(unittest.TestCase):
    def test_stage_restore_phrases(self) -> None:
        for utterance in (
            "back to single window",
            "stage view",
            "carousel mode",
        ):
            intent = match_stage_intent(utterance)
            assert intent is not None
            self.assertEqual("stage_restore", intent.action)


if __name__ == "__main__":
    unittest.main()
