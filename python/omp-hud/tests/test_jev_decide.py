import unittest
from unittest.mock import patch

from omp_hud.jev_decide import WindowCandidate, jev_window_action, local_focus, overlap_score


class JevDecideTests(unittest.TestCase):
    def test_overlap_save(self) -> None:
        self.assertGreater(overlap_score("click Save", "Save"), 0.9)

    def test_local_focus_unique(self) -> None:
        windows = [
            WindowCandidate("0x1", "kitty", "Terminal"),
            WindowCandidate("0x2", "firefox", "Docs"),
        ]
        decision = local_focus("focus firefox docs", windows)
        assert decision is not None
        self.assertEqual(decision.action, "focus")
        self.assertEqual(decision.address, "0x2")
        self.assertEqual(decision.backend, "overlap")

    def test_local_focus_ambiguous(self) -> None:
        windows = [
            WindowCandidate("0x1", "foo", "code"),
            WindowCandidate("0x2", "bar", "code"),
        ]
        self.assertIsNone(local_focus("code", windows))


    def test_jev_none_without_key(self) -> None:
        with patch("omp_hud.jev_decide._api_key", return_value=""):
            self.assertIsNone(
                jev_window_action("next window", [WindowCandidate("0x1", "kitty", "t")])
            )



if __name__ == "__main__":
    unittest.main()
