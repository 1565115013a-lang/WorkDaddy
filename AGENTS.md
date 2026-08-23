# WorkDaddy Agent Guide

## Project Overview

WorkDaddy is a local enhancement layer for the WorkBuddy desktop app. It connects to the running Electron renderer through Chrome DevTools Protocol (CDP), injects a small control panel, and runs a local HTTP daemon for account backups, account switching, themes, sessions, and related utilities.

The repository is deliberately lightweight:

- Runtime code is plain Node.js and browser JavaScript. There is no `package.json` build pipeline.
- `scripts/daemon.js` is the main local service and CDP coordinator.
- `scripts/inject.js` is the injected UI and its inline CSS.
- `scripts/theme-patches.js` contains hot-loaded CSS patches for WorkBuddy's own DOM.
- `scripts/lib.js` owns account file parsing, backup, switching, and data-directory compatibility.
- `scripts/win-launcher.js`, `scripts/watchdog.js`, and the PowerShell/cmd scripts are the Windows startup/update path.
- `WorkDaddy.app` is a packaged macOS artifact. Treat `scripts/` as the source of truth; update the app bundle only when the task explicitly asks for a packaged artifact or release output.

## Non-Negotiable Principles

1. Diagnose the reported behavior against the current code before changing it. A historical report is evidence, not proof that the current version is broken.
2. Keep changes narrow. Do not refactor unrelated code, rename public API routes, or change the account-file format without a concrete compatibility reason.
3. Preserve WorkBuddy's installation, signature, and official app bundle. WorkDaddy should operate through CDP and local files rather than modifying `app.asar`.
4. Never log, upload, or paste access tokens, cookies, account backup contents, or private keys. Sentry breadcrumbs and errors must remain redacted.
5. Account switching is intentionally smooth: replace the selected JSON backup and refresh the running renderer through CDP. Do not call `quitWorkBuddy()` or `relaunchWorkBuddy()` from the normal `/api/switch` path.
6. When changing daemon behavior, increment `DAEMON_VERSION` and `DAEMON_BUILD_ID` in `scripts/daemon.js`. Launchers use these values to replace stale daemon processes that still have old code in memory.

## UI Direction (Highest Priority)

The injected panel is a compact WorkBuddy-native tool surface, not a marketing page. Any UI change must look like it belongs beside the current WorkBuddy interface and the existing WorkDaddy panel.

### Visual language

- Preserve the current compact, information-dense layout: a bottom-right floating robot button opens a roughly `460px` panel with a capped viewport height, tabs, scrollable content, and small repeated account/session rows.
- Reuse the existing CSS variables first: `--wb-bg-*`, `--wb-border-*`, `--wb-color-text-*`, `--wb-icon-*`, `--wb-button-*`, and `--wb-accent-*`. Add a new literal color only when an existing token cannot express the state.
- Keep the established material language: translucent surfaces, restrained borders, subtle shadows, and backdrop blur where the surrounding theme already uses it. Do not introduce a separate visual system, loud gradients, neon decoration, oversized cards, or a new font family.
- Keep the existing density and scale: panel headings around 13–16px, body text around 11–13px, compact controls, and stable icon-button dimensions. Match nearby controls instead of inventing a larger component.
- Keep the existing radius hierarchy: panel and large surfaces may be about 14–18px; cards and grouped controls about 8–12px; compact icon buttons about 6–9px; status badges remain pill-shaped.

### Theme behavior

- Every new surface and text color must work in both the default/light theme and the WorkDaddy dark theme.
- The dark theme is represented by `html.cb-dark` / `html[data-theme="dark"]` and the relevant `body[data-vscode-theme-name]` values. Test both selectors when writing CSS overrides.
- Never rely on a light-only hardcoded foreground/background pair. Check contrast for normal, hover, selected, disabled, warning, error, and success states.
- Theme-specific WorkBuddy DOM fixes belong in `scripts/theme-patches.js`; WorkDaddy component styles belong in `scripts/inject.js`.
- A page reload or reinjection must restore the selected theme. Do not create a style element or observer that survives reinjection without an idempotent cleanup path.

### Layout and interaction

- Use stable dimensions for panels, rows, buttons, lists, and modal content. Hover and selected states must not change layout or cause visible jitter.
- Keep scroll ownership clear: the panel body and session list may scroll, but a modal must be centered relative to the panel/viewport rather than the scrolled account list.
- Modals use the existing centered fixed mask pattern (`.wbs-modal-mask`, `.wbs-modal`, `.wbs-modal-actions`). The mask must block pointer events from reaching WorkBuddy while open; do not allow click-through.
- Use familiar icons for icon-only actions and give unfamiliar icons a `title` tooltip. Do not replace a known symbol with a rounded text button when an icon is sufficient.
- Use radio controls for mutually exclusive modes, segmented controls for view modes, switches for binary settings, and normal buttons for explicit commands.
- Avoid hover animations that resize text, borders, or the containing row. Prefer color, opacity, or shadow transitions.
- Keep long Chinese copy inside its parent. Let descriptions wrap naturally; do not use fixed heights that clip text on narrow windows.
- Preserve keyboard and pointer behavior: visible focus, label inputs, dismissible dialogs, and no event propagation into WorkBuddy when a WorkDaddy overlay is active.

### UI implementation boundaries

- `scripts/inject.js` is executed inside WorkBuddy's renderer. Avoid assumptions about React ownership and do not mutate official component state unless the existing adapter already does so.
- Make injected DOM idempotent. On reinjection, remove or reuse prior WorkDaddy roots/styles/observers instead of stacking duplicate panels, timers, listeners, or MutationObservers.
- Prefer event delegation and narrow observers. Broad mutation scans can freeze or crash the WorkBuddy renderer during conversation changes.
- Escape user/account/session text before assigning it to `innerHTML`; use text nodes or the existing escaping helper where possible.
- Do not use private WorkBuddy RPCs or reorder operations in a session-switching path unless there is a regression test and a documented reason. These paths have historically caused renderer crashes.

## Backend and Platform Rules

- The daemon binds to loopback only. Keep local API routes on `127.0.0.1`; validate request bodies and file paths before acting.
- Account backups live under the WorkDaddy data directory. Preserve existing permissions and never delete user account data as part of a UI or runtime refactor.
- Normal account switching must be JSON replacement plus CDP reload. Fake logout is the exceptional flow that may exit/relaunch WorkBuddy to reach the login page.
- macOS uses launchd and the WorkDaddy app launcher; Windows uses the watchdog, `win-launcher.js`, `launcher.cmd`, and PowerShell scripts. Keep platform-specific process handling in the platform-specific files.
- Windows file replacement must account for locks held by running `launcher.cmd`/`cmd.exe`. Do not kill broad process names such as every `Electron` process; match the intended executable/path narrowly.
- If a launcher or daemon update changes code loaded into a long-running process, use a version/build bump so the launcher cannot reuse stale in-memory code.

## Release Version Consistency

- A release version must be identical in the package filename, macOS `Info.plist` (`CFBundleShortVersionString`/`CFBundleVersion`), and the packaged `scripts/daemon.js` `DAEMON_VERSION`. A package named `1.0.10` that runs daemon code reporting `1.0.6` is invalid.
- Build scripts must always rewrite the staged daemon version from the release `VERSION`; never rely on the version embedded in the reusable `WorkDaddy.app` shell or on a conditional test-only override.
- Before publishing or handing off a package, inspect the actual DMG/ZIP contents and record the daemon version, app metadata version, profile branding, and required update scripts. Do not infer package correctness from the filename alone.
- The updater must reject an artifact whose internal daemon version does not match the GitHub release target, and must leave a local diagnostic trail showing the selected asset, expected version, internal version, and installation attempt ID.

## Change Workflow

1. Read the surrounding code and existing tests before editing.
2. State the suspected cause and a falsifiable check when debugging a report.
3. Add or update a focused regression test at the closest reliable seam before the fix. For platform-only behavior, static assertions are acceptable when the platform is unavailable, but document the missing runtime verification.
4. Implement the smallest compatible fix. Keep user-facing copy in Chinese consistent with neighboring UI copy.
5. Run the relevant syntax checks and the complete test suite before handoff.
6. For UI changes, inspect both light and dark selectors and, when a WorkBuddy renderer is available, verify the actual injected panel after reload/reinjection. Check narrow-window wrapping and scroll position for modal/list changes.
7. Review `git diff --check`, confirm no sensitive data or generated artifacts were added, and report any platform tests that could not run.

## Verification Commands

From the repository root:

```bash
node --check scripts/daemon.js
node --check scripts/inject.js
node --check scripts/win-launcher.js
node --test test/*.test.js
git diff --check
```

PowerShell syntax and real installer/update smoke tests should be run on Windows (or in an environment with `pwsh`). Do not claim those checks passed based only on macOS static inspection.

## Commit and Delivery Notes

- Work on a dedicated branch based on the requested base branch.
- Keep logically related fixes together; avoid metadata-only churn and unrelated formatting changes.
- Do not push, merge, or modify `main` unless the user explicitly asks for it.
- When delivering a packaged app, state exactly which source files were synchronized into the artifact and whether the running daemon/WorkBuddy process was restarted.
