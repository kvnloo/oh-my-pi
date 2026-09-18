"""Handsfree hot path: local overlap then TypeSafe Jev. No chat model."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Literal

WindowAction = Literal["next", "prev", "focus", "none"]

_STOP = frozenset(
    "a an the to of for this that with on in at and or a window app please".split()
)


@dataclass(frozen=True, slots=True)
class WindowCandidate:
    address: str
    app_class: str
    title: str

    @property
    def label(self) -> str:
        app = self.app_class or "app"
        return f"{app} — {self.title}" if self.title else app


@dataclass(frozen=True, slots=True)
class JevWindowDecision:
    action: WindowAction
    address: str | None = None
    backend: str = "jev"
    confidence: float = 0.0


def tokenize(text: str) -> list[str]:
    raw = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
    return [tok for tok in raw.split() if tok and tok not in _STOP]


def overlap_score(goal: str, label: str) -> float:
    goal_tokens = set(tokenize(goal))
    label_tokens = tokenize(label)
    if not goal_tokens or not label_tokens:
        return 0.0
    hits = sum(1 for tok in label_tokens if tok in goal_tokens)
    return hits / len(label_tokens)


def local_focus(goal: str, windows: list[WindowCandidate]) -> JevWindowDecision | None:
    if not windows:
        return None
    scored = sorted(
        ((overlap_score(goal, f"{w.app_class} {w.title}"), w) for w in windows),
        key=lambda row: row[0],
        reverse=True,
    )
    top, second = scored[0], scored[1] if len(scored) > 1 else None
    if top[0] < 0.45:
        return None
    if second is not None and top[0] - second[0] < 0.15:
        return None
    return JevWindowDecision(
        action="focus",
        address=top[1].address,
        backend="overlap",
        confidence=min(0.95, top[0]),
    )


def _api_key() -> str:
    key = (os.environ.get("TYPESAFE_API_KEY") or "").strip()
    if key:
        return key
    env_path = os.path.expanduser("~/.omp/.env")
    try:
        with open(env_path, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("TYPESAFE_API_KEY="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        return ""
    return ""


def _base_url() -> str:
    return (os.environ.get("TYPESAFE_BASE_URL") or "https://api.typesafe.ai").rstrip("/")


def jev_window_action(
    utterance: str,
    windows: list[WindowCandidate],
    *,
    timeout_s: float = 0.8,
) -> JevWindowDecision | None:
    """Factorized System One: action + target. None = fail-open / escalate."""
    key = _api_key()
    if not key or not utterance.strip():
        return None
    criteria = {w.address: w.label for w in windows[:24]}
    criteria["none"] = "No specific window; or this is not a window-control request."
    questions = {
        "action": {
            "type": "choice",
            "instructions": (
                "Is this a handsfree window-control request? "
                "Pick next/prev to rotate, focus to switch to one candidate, "
                "or none to leave the utterance for the chat agent."
            ),
            "criteria": {
                "next": "Rotate to the next staged window.",
                "prev": "Rotate to the previous staged window.",
                "focus": "Switch to one of the listed windows.",
                "none": "Not window control (question, coding, or unclear).",
            },
        },
        "target": {
            "type": "choice",
            "instructions": "If action is focus, pick that window. Otherwise none.",
            "criteria": criteria,
        },
    }
    body = json.dumps(
        {
            "state": {"utterance": utterance.strip()[:2000], "window_count": len(windows)},
            "model": os.environ.get("TYPESAFE_DEFAULT_MODEL") or "jev-latest",
            "questions": questions,
        }
    ).encode()
    req = urllib.request.Request(
        f"{_base_url()}/v1/systemone",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            payload = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        return None
    action_ans = answers.get("action") or {}
    action = str(action_ans.get("choice") or "none")
    if action not in {"next", "prev", "focus", "none"}:
        return None
    if action == "none":
        return None
    probs = action_ans.get("probabilities") if isinstance(action_ans.get("probabilities"), dict) else {}
    confidence = float(probs.get(action) or 0.0)
    if confidence and confidence < 0.4:
        return None
    target = str((answers.get("target") or {}).get("choice") or "")
    address = target if target and target != "none" and target in {w.address for w in windows} else None
    if action == "focus" and not address:
        return None
    return JevWindowDecision(action=action, address=address, backend="jev", confidence=confidence or 0.5)
