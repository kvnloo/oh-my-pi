"""Fast local intents for Handsfree Stage Manager (no agent round-trip)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

StageAction = Literal["next", "prev", "focus"]


@dataclass(frozen=True, slots=True)
class StageIntent:
    action: StageAction
    target: str | None = None


_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s+\-./]")

# next / prev carousel
_NEXT = re.compile(
    r"\b("
    r"(?:switch|go|move|rotate|skip)\s+(?:to\s+)?(?:the\s+)?next(?:\s+(?:window|app|stage|one))?"
    r"|next\s+(?:window|app|stage|one)"
    r"|(?:window|app)\s+(?:to\s+the\s+)?right"
    r"|carousel\s+next"
    r"|switch\s+(?:the\s+)?windows?"
    r"|change\s+(?:the\s+)?windows?"
    r")\b",
    re.I,
)
_PREV = re.compile(
    r"\b("
    r"(?:switch|go|move|rotate|skip)\s+(?:to\s+)?(?:the\s+)?(?:prev(?:ious)?|last|back)(?:\s+(?:window|app|stage|one))?"
    r"|(?:prev(?:ious)?|last)\s+(?:window|app|stage|one)"
    r"|(?:window|app)\s+(?:to\s+the\s+)?left"
    r"|carousel\s+prev(?:ious)?"
    r"|go\s+back"
    r")\b",
    re.I,
)

# focus / switch to named app
_FOCUS = re.compile(
    r"\b(?:switch(?:\s+over)?\s+to|focus|show|open|bring\s+up|activate|select)\s+"
    r"(?:the\s+)?(?P<name>.+?)(?:\s+window)?\s*$",
    re.I,
)
_BLOCK = re.compile(
    r"\b(what|why|how|when|who|explain|tell me|help me|code|write|fix|debug|implement)\b",
    re.I,
)


def normalize_utterance(text: str) -> str:
    cleaned = _PUNCT.sub(" ", text or "")
    return _WS.sub(" ", cleaned).strip().lower()


def match_stage_intent(text: str) -> StageIntent | None:
    """Return a local stage intent when the utterance is unambiguous."""
    t = normalize_utterance(text)
    if not t or len(t) > 120:
        return None
    if _BLOCK.search(t):
        return None
    if _NEXT.search(t):
        return StageIntent("next")
    if _PREV.search(t):
        return StageIntent("prev")
    m = _FOCUS.search(t)
    if m:
        name = m.group("name").strip(" .")
        # avoid matching "next window" via focus path
        if name in {"next", "previous", "prev", "last", "back"}:
            return StageIntent("next" if name == "next" else "prev")
        if 1 <= len(name) <= 48:
            return StageIntent("focus", name)
    return None


def score_window_match(query: str, *, app_class: str, title: str) -> int:
    """Higher is better. 0 = no match."""
    q = normalize_utterance(query)
    if not q:
        return 0
    app = normalize_utterance(app_class)
    title_n = normalize_utterance(title)
    score = 0
    if q == app or q == title_n:
        score += 100
    if app and (q in app or app in q):
        score += 40
    if title_n and q in title_n:
        score += 30
    # token overlap
    q_tokens = set(q.split())
    hay = set((app + " " + title_n).split())
    overlap = len(q_tokens & hay)
    score += overlap * 8
    return score
