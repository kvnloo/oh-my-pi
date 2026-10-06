# Visual replies experiment

Prototype a T3 Code-style visual reply flow in the OMP TUI without adding a new Tern Surface Protocol element.

## Goal

A prompt such as:

> Show repository size as an interactive treemap.

can use:

1. `html_preview` to render self-contained HTML in OMP's existing headless browser and inspect a screenshot, console, and page errors.
2. `html_render` to save the final document and return its screenshot in the transcript.
3. `html_render(..., open_interactive: true)` or `/visual` inside Tern to open the same HTML/JS as a live browser PiP.

The experiment deliberately reuses existing OMP primitives. It does **not** add a TSP `html`/`webview` node.

## Files

- `.omp/extensions/visual-replies.ts` — project-local extension and the two model tools.
- `packages/coding-agent/test/visual-replies-extension.test.ts` — document/CSP/size/data-URL tests.

OMP auto-discovers project extensions under `.omp/extensions`.

## Safety boundary

Both tools are `exec` approval because the page can execute JavaScript.

The experiment:

- caps authored HTML at 1 MiB;
- injects a CSP that blocks network connections, frames, objects, forms, and external assets;
- opens previews on `data:` URLs with browser `allowed_domains` set to a nonexistent host;
- leaves browser local-file access disabled;
- stores published pages under the OMP agent directory, not the repository;
- validates ids used by `/visual <id>` before resolving a saved page.

This is a dogfood boundary, not a production sandbox audit.

## Dogfood

Run OMP normally from this checkout. In Tern, ask:

> Build an interactive treemap of this repository by top-level directory. Preview it, fix any console or layout errors, then publish it and open it interactively.

Expected:

- the agent calls `html_preview` before `html_render`;
- the preview result contains an image;
- browser diagnostics are visible to the model;
- `html_render` returns a final image in the transcript;
- `open_interactive: true` opens a live Tern PiP;
- `/visual` reopens the latest visual created in the current process;
- `/visual-close` closes PiPs opened by the extension.

Outside Tern, the screenshot path still works and the interactive request reports that a Tern pane is required.

## Follow-ups only if dogfood justifies them

1. Add a native fast path for structured `chart`, `table`, and `tree` data.
2. Persist a visual-reply manifest so `/visual` can discover prior-process pages without an id.
3. Move page persistence onto the session artifact manager.
4. Theme HTML from the current OMP palette.
5. Consider a TSP `html`/`webview` element only if PiP interaction proves insufficient.

## Provenance

The experiment is intentionally modeled on T3 Code visual replies, especially
`pingdotgg/t3code#15968`, which took over `#15916` by @bmdavis419. OMP's
existing Tern browser, TSP image/chart primitives, extension API, and browser
diagnostics make this smaller experiment possible.
