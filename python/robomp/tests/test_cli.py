"""CLI regression coverage for ``robomp triage`` conflict refusal.

Pins the contract that re-running ``robomp triage owner/repo#N`` while a
prior manual delivery is still active refuses cleanly on stderr with exit
code 2 — instead of escaping an uncaught ``ManualTriageConflict`` (a
``RuntimeError``, not a subclass of ``ManualTriageError``) with exit code 1.
The exception-hierarchy gap is the trap that let this bug ship, so this test
guards against re-introducing a ``ManualTriageError``-only ``except`` in the
CLI's enqueue block.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from click.testing import CliRunner

from robomp.cli import main
from robomp.config import Settings
from robomp.db import close_database, get_database, issue_key
from robomp.manual_triage import ManualTriageConflict, manual_delivery_id


def _cfg() -> Settings:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


class _RefusingGitHub:
    """``GitHubBackend`` double that fails if the CLI fetches an active event.

    The pre-GitHub active-state guard (raise site 1 of
    `enqueue_manual_triage`) must short-circuit before any network call, so a
    conflict refusal must never reach the GitHub client.
    """

    async def get_issue(self, repo: str, number: int):  # type: ignore[no-untyped-def]
        raise AssertionError(f"unexpected get_issue {repo}#{number}")

    async def get_repo(self, repo: str):  # type: ignore[no-untyped-def]
        raise AssertionError(f"unexpected get_repo {repo}")


@pytest.mark.parametrize("state", ["queued", "running"])
def test_triage_refuses_when_manual_delivery_already_active(env: dict[str, str], state: str) -> None:
    """Re-running ``robomp triage owner/repo#N`` while a prior run is still
    active must surface ``refusing: <delivery> is already <state>`` on stderr
    with exit code 2 — not an uncaught ``ManualTriageConflict`` (exit 1).
    """
    cfg = _cfg()
    repo_full = "octo/widget"
    number = 42
    delivery = manual_delivery_id(repo_full, number)  # manual-octo__widget-42
    original_payload = {"action": "opened", "issue": {"number": number, "title": "old"}}

    db = get_database(cfg.sqlite_path)
    db.record_event(
        delivery_id=delivery,
        event_type="issues",
        repo=repo_full,
        issue_key=issue_key(repo_full, number),
        payload=original_payload,
        state=state,
    )
    try:
        with patch("robomp.cli._build_github", return_value=_RefusingGitHub()):
            result = CliRunner().invoke(main, ["triage", f"{repo_full}#{number}"])
        row = db.get_event(delivery)
    finally:
        close_database()

    # The conflict surfaces as a clean refusal on stderr with exit code 2,
    # NOT as an uncaught ManualTriageConflict RuntimeError (exit 1).
    assert result.exit_code == 2, result.output
    assert not isinstance(result.exception, ManualTriageConflict)
    assert isinstance(result.exception, SystemExit)
    assert "refusing: " in result.stderr
    assert f"{delivery} is already {state}" in result.stderr
    assert result.stdout == ""
    # The active row is left intact (no payload overwrite, no state change).
    assert row is not None
    assert row.state == state
    assert row.payload == original_payload
