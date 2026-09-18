"""Fast local intents for Handsfree Stage Manager + Hyprland layout (no agent)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

StageAction = Literal[
    "next",
    "prev",
    "focus",
    "stage_restore",
    "quadrant_split",
    "tile",
    "ungroup",
]


@dataclass(frozen=True, slots=True)
class StageIntent:
    action: StageAction
    target: str | None = None


_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s+\-./]")

# next / prev carousel or group cycle
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
    r"(?:switch|go|move|rotate|skip)\s+(?:to\s+)?(?:the\s+)?prev(?:ious)?(?:\s+(?:window|app|stage|one))?"
    r"|prev(?:ious)?\s+(?:window|app|stage|one)"
    r"|(?:window|app)\s+(?:to\s+the\s+)?left"
    r"|carousel\s+prev"
    r"|go\s+back"
    r")\b",
    re.I,
)

# focus / switch to named app
_FOCUS = re.compile(
    r"\b(?:"
    r"(?:switch|go|focus|show|open|bring)\s+(?:to\s+)?(?:the\s+)?"
    r"|(?:focus|activate)\s+"
    r")(?P<target>[\w .+\-]{2,40})\b",
    re.I,
)

# layout ops
_QUADRANT = re.compile(
    r"\b("
    r"(?:split|arrange|layout|tile|put|make|convert).{0,40}?(?:quad(?:rant)?s?|2\s*[x×]\s*2|four\s+(?:equal\s+)?(?:tiles?|panes?|windows?)|4\s+(?:equal\s+)?(?:tiles?|panes?|windows?))"
    r"|(?:quad(?:rant)?s?|2\s*[x×]\s*2)\s+(?:split|layout|grid|tile)"
    r"|four\s+corners"
    r"|tile\s+mode.{0,20}(?:split|quad|four|4)"
    r")\b",
    re.I,
)
_TILE = re.compile(
    r"\b("
    r"(?:convert|make|set|switch|put|turn).{0,24}?(?:to\s+)?tile(?:d|d\s+mode|mode)?"
    r"|tile(?:d)?\s+mode"
    r"|untilt|unfloat|settiled"
    r")\b",
    re.I,
)
_UNGROUP = re.compile(
    r"\b("
    r"un-?group|explode(?:\s+the)?\s+group|break(?:\s+the)?\s+group|leave(?:\s+the)?\s+group"
    r"|split(?:\s+the)?\s+group|ungroup(?:\s+windows?)?"
    r")\b",
    re.I,
)
_STAGE_RESTORE = re.compile(
    r"\b("
    r"(?:back\s+to\s+)?(?:single|one)\s+(?:window|app|stage)"
    r"|stage\s+(?:view|mode|manager)"
    r"|carousel\s+(?:view|mode)\b"
    r"|carousel$"
    r"|restore\s+stage"
    r"|show\s+(?:the\s+)?stage"
    r")\b",
    re.I,
)

_BLOCK = re.compile(
    r"\b(code|commit|pr\b|pull request|debug|refactor|write|implement|explain)\b",
    re.I,
)


def normalize_utterance(text: str) -> str:
    cleaned = _PUNCT.sub(" ", text or "")
    return _WS.sub(" ", cleaned).strip().lower()


def match_stage_intent(text: str) -> StageIntent | None:
    """Return a local stage/layout intent when the utterance is unambiguous."""
    norm = normalize_utterance(text)
    if not norm or _BLOCK.search(norm):
        return None

    # Layout first — more specific than bare "tile" inside other phrases.
    if _QUADRANT.search(norm):
        return StageIntent("quadrant_split")
    if _UNGROUP.search(norm):
        return StageIntent("ungroup")
    if _TILE.search(norm):
        return StageIntent("tile")

    if _STAGE_RESTORE.search(norm):
        return StageIntent("stage_restore")

    if _NEXT.search(norm):
        return StageIntent("next")
    if _PREV.search(norm):
        return StageIntent("prev")

    m = _FOCUS.search(norm)
    if m:
        target = (m.group("target") or "").strip()
        # drop trailing filler
        target = re.sub(r"\b(window|app|please|now)$", "", target).strip()
        if len(target) >= 2 and target not in {"next", "prev", "previous", "the"}:
            return StageIntent("focus", target=target)
    return None


def score_window_match(query: str, *, app_class: str, title: str) -> int:
    """Higher is better. 0 = no match."""
    q = normalize_utterance(query)
    if not q:
        return 0
    app = normalize_utterance(app_class)
    title_n = normalize_utterance(title)
    score = 0
    if q == app or q in app.split():
        score += 40
    if app and (q in app or app in q):
        score += 28
    if title_n and q in title_n:
        score += 22
    # aliases
    aliases = {
        "zen": ("zen", "browser"),
        "firefox": ("firefox", "zen", "browser"),
        "browser": ("zen", "firefox", "chrome", "chromium", "brave"),
        "telegram": ("telegram", "org.telegram"),
        "terminal": ("kitty", "foot", "alacritty", "wezterm", "ghostty"),
        "kitty": ("kitty",),
        "code": ("code", "cursor", "code-oss"),
    }
    for key, vals in aliases.items():
        if key in q or q == key:
            for v in vals:
                if v in app or v in title_n:
                    score += 35
                    break
    # token overlap
    q_tokens = set(q.split())
    hay = set((app + " " + title_n).split())
    overlap = len(q_tokens & hay)
    score += overlap * 8
    return score
