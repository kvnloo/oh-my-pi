import unittest
from omp_hud.stage_intent import match_stage_intent, score_window_match


class StageIntentTests(unittest.TestCase):
    def test_next_prev(self) -> None:
        self.assertEqual(match_stage_intent("switch to the next window").action, "next")
        self.assertEqual(match_stage_intent("previous app").action, "prev")
        self.assertEqual(match_stage_intent("carousel next").action, "next")

    def test_focus(self) -> None:
        intent = match_stage_intent("focus firefox")
        assert intent is not None
        self.assertEqual(intent.action, "focus")
        self.assertEqual(intent.target, "firefox")

    def test_non_stage(self) -> None:
        self.assertIsNone(match_stage_intent("what time is it"))
        self.assertIsNone(match_stage_intent("explain how the carousel works"))

    def test_score(self) -> None:
        self.assertGreater(
            score_window_match("firefox", app_class="firefox", title="Docs"),
            score_window_match("firefox", app_class="kitty", title="Terminal"),
        )

    def test_quadrant_and_stage_restore(self) -> None:
        quad = match_stage_intent("split these four into quadrants")
        assert quad is not None
        self.assertEqual(quad.action, "quadrant_split")
        restore = match_stage_intent("back to single window")
        assert restore is not None
        self.assertEqual(restore.action, "stage_restore")


if __name__ == "__main__":
    unittest.main()
