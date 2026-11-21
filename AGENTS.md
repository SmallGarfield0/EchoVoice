# EchoVoice Development Rules

This file applies to the entire repository. More specific `AGENTS.md` files may
add constraints for their directory, but must not weaken these rules.

## Product Direction

- Keep EchoVoice lightweight, self-hostable, and suitable for long-running use.
- Preserve the black, neutral gray, and light-blue visual system.
- Desktop behavior must work in Tauri; browser behavior must remain supported
  unless a capability is explicitly desktop-only.
- User-facing strings must use the i18n system. Add both `en-US` and `zh-CN`
  entries when introducing interface text.

## Interface Components

- Use project-owned controls instead of unstyled browser or operating-system
  controls. Reuse an existing EchoVoice component before creating a new one.
- Do not use native `alert`, `confirm`, or `prompt`. Use EchoVoice dialogs.
- Do not expose native number-input spinner buttons. Numeric values must use
  `NumericInput.svelte` or a later shared EchoVoice numeric component.
- Do not introduce a native-looking `select` menu. Use the shared custom menu,
  listbox, or popover pattern with keyboard and accessibility support.
- Do not rely on the browser's `title` tooltip for product UI. Use an EchoVoice
  tooltip component or the established styled tooltip pattern.
- Use Material Symbols already bundled by the desktop app for interface icons.
  Do not substitute text labels where a familiar icon is sufficient.
- Popovers must be anchored to their trigger, remain inside the viewport, and
  stay interactive while the pointer crosses any visual gap. Click-open menus
  must close on outside click and Escape.
- Hover-only actions must not cause layout shifts. Touch and keyboard users must
  still have an accessible way to perform the action.

## Scrolling And Layout

- Every scrollable region must inherit the global EchoVoice scrollbar theme in
  `apps/desktop/src/styles/app.css`. Never ship an unstyled browser scrollbar.
- Do not add local scrollbar colors unless the component has a functional reason
  for a specialized scrollbar. Reuse the global scrollbar CSS variables.
- Avoid accidental two-axis scrolling. Prefer `overflow-x: hidden` with a
  deliberate vertical scroll region when horizontal scrolling is not required.
- Dialogs, menus, tooltips, and popovers must not increase the application page
  size or create a global scrollbar.
- Keep stable panel dimensions and `min-width: 0` / `min-height: 0` constraints
  where grid or flex children can otherwise force overflow.

## State And Architecture

- Keep server-authoritative state separate from local preferences and cached
  media. Persist local preferences under a namespaced `ev.*` storage key.
- A configurable limit must be enforced in the UI, persistence loader, and the
  native/backend boundary. Lowering a limit must clamp existing stored values.
- Prefer shared helpers and typed APIs over duplicated event-specific logic.
- Remove superseded code and obsolete styles when replacing an implementation.
- Do not add a fallback that silently changes requested media quality or user
  permissions. Surface the actual constraint to the user.

## Commit Messages

- Write every commit message in Chinese: the subject line and the body, including
  commits authored by agents or automation. Rewrite tool-generated defaults
  (merge, revert, squash, `--amend`) into Chinese before committing.
- Keep the subject a short Chinese sentence, roughly 50 characters or fewer, with
  no trailing period. A Chinese type prefix is allowed, for example `修复:`、
  `新增:`、`文档:`、`重构:`. File names, identifiers, and English technical terms
  such as `WebRTC` or `Tauri` stay as-is.
- Use the body to explain why the change was made and what it affects, one bullet
  per point, and note the tests or builds that were run.
- Keep one logical change per commit; do not mix renames or formatting with
  behavior changes.

## Quality Gate

- Run the narrowest relevant tests while iterating, then run the affected package
  build before reporting completion.
- Frontend interaction changes require the workspace browser test or another
  browser automation test covering the changed workflow.
- Rust media changes require `cargo fmt --all -- --check` and relevant Rust tests.
- Go server changes require `go test ./...` from `services/ev-server`.
- Verify both desktop and Web paths when changing shared voice, screen-sharing,
  device-selection, or realtime state behavior.
