# Pico

<img src="assets/Pico.png" width="96" height="96" alt="Pico app icon">

A local macOS workspace for [Oh My Pi](https://github.com/can1357/oh-my-pi). Built with Electron and TypeScript, with a separate OMP process for each active conversation. Pico communicates with OMP over JSONL stdin/stdout, without an HTTP intermediary or application server.

## Build and launch

Requirements:

- macOS 13 or newer.
- Node.js 24 or newer and npm.
- Xcode Command Line Tools, including Swift, to render the app icon.
- OMP installed with a configured model provider.

```sh
git clone https://github.com/bgar324/pico.git
cd pico
npm ci
npm run package
open "release/Pico-darwin-arm64/Pico.app"
```

Packaging targets the build machine's architecture. Intel Macs produce `release/Pico-darwin-x64/Pico.app` instead. The application is ad-hoc signed, not notarized or App Store sandboxed. An Apple developer account is not required to build it.

Copy the `.app` to Applications using Finder. Quit the previous version before launching its replacement. Never rebuild over an application bundle while it is running; replacing a running ad-hoc-signed app can invalidate macOS permission grants. If macOS blocks a build you made yourself, use System Settings > Privacy & Security to review the blocked application rather than disabling Gatekeeper globally.

Packaging refuses to replace a bundle whose main or helper processes are still running, including when Pico launched the build itself. To keep the current app running, choose a separate output directory with `PICO_PACKAGE_OUT=release/preview npm run package`, then quit the old app before opening the new build.

Deferred installers must recheck main/helper processes after signature verification, immediately before swapping bundles. A quick relaunch during verification must defer installation again. A process started before the swap can continue using the old bundle even when the installed `app.asar` hash is current; use `lsof -p <pid>` to check the executable and archive actually held open rather than relying only on the command-line path.

For development:

```sh
npm start
```

Pico searches PATH and common Homebrew, Bun, and local binary directories for OMP. Settings also accepts an explicit executable path. Test connection checks the RPC handshake, protocol negotiation, and state response. Provider accounts can be connected from Settings without opening OMP's terminal UI.

### Upgrading from Pi Desktop

Pico retains the existing `local.bg.PiDesktop` bundle identifier and `~/Library/Application Support/PiDesktop/` storage directory. Existing projects, chats, drafts, and settings stay in place without copying or migrating sessions. The internal `PI_DESKTOP_*` verification environment variables also remain unchanged.

Quit Pi Desktop before opening Pico. They share the same saved sessions and should not run together.

## Settings and provider accounts

Open Settings with Command-comma or the sidebar's settings control. The settings window uses vertical navigation and grouped preference rows, with independent scrolling for the active section. Arrow keys, Home, and End navigate the sections.

- **General** has System / Light / Dark appearance previews. Appearance saves immediately; System follows macOS. Default-project changes use Save changes.
- **Connections** lists configured accounts and providers with supported setup methods. Search also shows other providers known to the installed OMP. Connect Claude Pro/Max, ChatGPT/Codex subscriptions, or OpenRouter through their browser sign-in flows. ChatGPT also offers device sign-in. Common providers support direct API-key entry.
- **Advanced** contains the executable override, file chooser, connection test, diagnostics, and session-storage controls. Unfinished executable edits are not saved by changing the theme.

In-app account management requires OMP 18.11.2 or newer. Choosing a provider account does not launch Claude Code or Codex as a separate agent; these accounts supply models to OMP's existing runtime and tools.

For browser sign-in, choose the provider and its sign-in method, then Open sign-in page. Complete consent in your browser and, if requested, paste the authorization code or redirect URL back into Settings. Cancel sign-in or close Settings to stop the pending attempt. Sign-in uses a separate management process and never stops active conversations.

Keys travel to OMP over a private process pipe, not command-line arguments or temporary credential files. Pico does not keep keys or OAuth tokens in its preferences. OMP owns the credential database or configured broker; its local store uses filesystem permissions, not macOS Keychain encryption. Connected means credentials are configured, not that Pico has verified a token or subscription.

Manage can remove a particular saved account after confirmation. Environment variables or OMP configuration may keep a provider authenticated after a stored account is removed. API-key import is unavailable when OMP delegates storage to an auth broker; Pico reports that restriction and leaves the broker configuration unchanged.

Avoid running credential imports in another OMP process at the same time. OMP's importer merges provider records before writing them, so Pico serializes its own imports but cannot make an external import atomic.

Idle conversations reconnect to discover updated models without changing the selected chat, losing drafts, or replaying prompts. Busy conversations adopt the change after they settle, including pending RPC responses and approval dialogs. Provider methods that the installed OMP cannot complete through its headless APIs are shown as unavailable rather than presented as working sign-in flows.

## Conversations

- Open project folders and keep separate conversations within each project.
- Stream assistant responses, reasoning, and grouped tool activity. Expand Write to watch the file's source appear while the tool arguments are being generated, before execution. The preview preserves literal source text and remains available in restored history. Prose and reasoning use delta transport; full snapshots are requested only while tool arguments stream. Restored history does not replay streaming effects. Tool rows have no trailing status circles or spinner animation; their state remains accessible, and failed output stays inside the disclosure.
- Tool rows show the action's purpose and affected file paths rather than unexplained internal labels. Multi-file Edit rows stay compact: Editing N files while pending or running, Edited N files after success, and explicit failed or interrupted labels otherwise. Expand to see one path per line with shared directories removed; hover a path for its full original value. Single-file rows truncate long paths without wrapping. Edit paths come from the patch, including restored conversations; Pico does not split filenames on commas or guess which files arbitrary scripts might touch. Eval shows its supplied purpose, with Run code as the fallback.
- Text bursts use adaptive presentation buffering with 50 ms drain ticks and frame-aligned rendering. Fresh words fade in through opacity only; word continuations and punctuation do not restart the fade. Completion and source corrections show all authoritative text immediately. Reduced motion bypasses buffering and fades, and restored or reactivated history never replays them. Runtime text and rich clipboard copies remain complete, independent of presentation timing.
- Manual scrolling pauses automatic following. Streaming updates do not reclaim the reading position, even near the bottom. Use Jump to latest or submit a new message to resume following.
- Activity, tool, and Advisor disclosures brighten to normal conversation text on hover or keyboard focus, without a background fill. The original leading icon always remains visible. A separate right-pointing caret appears one natural space after the full visible row text, not at the right edge or immediately after the tool name. Expanded rows keep that caret pointing down even after the pointer leaves. Collapsing restores the hover-only caret without shifting the row. Project-rule cards use the same trailing-caret behavior for View rule instructions and do not include a separate source-code control below the card; the full instructions remain expandable and searchable.
- Project-rule cards show a single heading, such as `Project rule: ts-set-map`, followed by the expandable View rule instructions control. Separate names, source paths, and generic explanations are omitted; full instructions remain available inside the disclosure.
- LaTeX math renders locally with bundled KaTeX fonts: `$...$` and `\(...\)` inline, `$$...$$` and `\[...\]` in display mode, including table cells and list items. Code, escaped dollar signs, and currency stay literal. Incomplete streamed expressions remain readable until closed; invalid TeX does not break surrounding text. Trusted HTML and URL commands are disabled.
- The composer shows the selected model and thinking level together. Open that control to search models by name or provider, choose a discovered thinking level, or inspect current context usage. Inherit clears an explicit effort setting; it does not enable OMP's separate Auto classifier.
- Queue follow-ups, steer an active run with Command-Shift-Return, or stop it with the send/stop control. Follow-ups appear as compact rows above the composer, with a single-line preview, Steer, and a pencil to edit. Pressing Steer or using the steering shortcut puts the message in chat immediately and follows the latest message, without waiting for OMP's acknowledgement or current model turn.
- Steer bubbles show Sending before acknowledgement and Queued to interrupt after native acceptance. An accepted steer has a pencil to withdraw it into the composer with its images. Recovered text is placed before any existing draft, and existing attachments are kept. A delivered message is never restored or replayed. Queued and steered image thumbnails open the full-resolution preview.
- Paste, drop, or choose image attachments with the composer's plus button. Draft thumbnails do not show filenames. Draft, queued, and sent image thumbnails open the same full-resolution magnifier, with an icon-only × at the top right, Escape/backdrop dismissal, and keyboard focus return. The magnifier has no filename heading or Close footer. Image prompts require a vision-capable model.
- Drag local files anywhere over the chat area to show a dimmed drop overlay. Dropping adds PNG/JPEG/GIF/WebP previews and quoted local paths for other files to the existing composer draft; nothing is submitted automatically. Escape, leaving the chat, or dropping dismisses the overlay. Dropping only folders into an empty workspace still opens projects.
- Hover a sent user message or the area around its copy icon, or focus the icon with the keyboard, to copy that entire message. The enlarged pointer target uses the existing space below the bubble without moving the icon or other messages. Its outer area stays transparent; the compact hover highlight remains centered on the icon. Copy preserves the original text and every image in rich-text clipboard data; bitmap-only paste targets receive the first image. Text-only and image-only messages are supported. Queued rows use Steer and pencil controls instead.
- Code blocks show an icon-only Copy button at the top right on hover or keyboard focus. It copies only the block's literal code, preserving indentation, Unicode, and newlines without the Markdown fences. The button stays pinned while code scrolls horizontally and reads the latest content as the block streams or changes.
- Completed agent responses show their whole-response Copy button below the answer only while that response is hovered or Copy has keyboard focus. Hovering another message or empty transcript space does not reveal it. Assistant output uses shared compact spacing before subsequent prose, tools, and Advisor, without stacking trailing paragraph and turn margins. Copy keeps its own nonoverlapping row, and hover changes do not shift the conversation. User-message control clearance is unchanged. Copy controls remain visible on devices without hover.
- Hover a sent user message to reveal a pencil immediately beside Copy. The pencil opens an inline editor with Cancel and Send; Return inserts a line, Command/Ctrl-Return resends, and Escape cancels. Resending creates a native OMP branch from before that message, replacing its later replies in the active conversation while preserving the original session. Original message images are retained, and the unrelated composer draft and attachments stay untouched. Send is disabled while current or queued work is active. Failed admission keeps the edit available and attempts to restore the original session. The chosen native session file is saved explicitly so reopening or Terminal handoff resumes the edited branch.
- Inspect Tasks, Agents, Advisor notes, and read-only working-tree diffs without leaving the conversation. Tasks and Agents have no status circles. Completed rows use strikethrough text; running rows retain text shimmer, and blocked tasks retain their explanation. Status descriptions remain accessible. Agent rows remain expandable by mouse and keyboard, without trailing spinners. Both panel controls are icon-only, without visible counters, at the top right beside the conversation title. Expanded controls have no persistent background; hover feedback, tooltips, accessible labels, and expanded state remain available.
  Wide windows reserve a right-hand lane only while Tasks or Agents is expanded. Collapsing both panels, removing their data, or switching to an empty conversation restores the centered chat. Agents moves to the top when Tasks is collapsed. Compact windows use overlays without shifting the conversation sideways; interrupted transitions, hidden windows, and reduced motion snap to the correct visible state.
- Advisor headers omit the count for a single note and keep their severity icon visible in every state. Consecutive Advisor deliveries share one disclosure, including deliveries separated only by hidden engine notices. Actual conversation output starts a new group. Multiple-note groups keep their count and use the highest rendered severity. Notes remain collapsed by default and expandable by mouse or keyboard; Find reveals the matching note inside a group.
- Runtime interruption/error banners have a Dismiss notice control. Dismissal is local to that conversation for the current window session, survives passive updates and thread switches, and does not clear OMP state. A changed notice or a cleared notice that later recurs is shown again.
- Search conversations with the quick switcher and search the current transcript with Find.
- Hand a conversation back to Terminal. Pico closes its OMP process, copies a continuation command, and opens Terminal without executing the command automatically.

The sidebar is resizable and collapsible. Collapsed project folders show activity when one of their chats is running. Dark and light appearances, reduced motion, selectable transcripts, and keyboard navigation are supported. The conversation canvas is edge-to-edge, with a shared 768px reading column. Focus outlines are intentionally suppressed while keyboard focus and dialog trapping remain active.

Chat and settings layouts follow the installed Codex desktop reference where OMP has matching capabilities: compact 14px transcript text, rounded user bubbles, a neutral composer with visible model/effort selection, and grouped settings rows. Pico keeps its own neutral theme and 768px reading column. Settings retains native modal focus trapping and explicit saves for project/executable drafts. Codex-specific voice, cloud execution, hooks, billing modes, and permission selectors are not presented as working Pico controls.

Scrollbars use slim, muted thumbs on transparent tracks in both appearances. Native wheel, keyboard, and thumb-drag scrolling remain available; the transcript keeps stable gutters to avoid layout shifts.

Pico keeps up to three OMP processes, recycling only idle ones. Closing the window does not stop active conversations. Command-Q and Pico > Quit Pico show a native confirmation with Cancel selected by default. Cancel or Escape keeps the app and running work open; confirming Quit closes every app-owned process with bounded termination escalation.

Queued previews use attachments submitted through Pico in the current runtime. Image bytes load separately from status updates and each preview is reused while its entry stays mounted or cached. Removing the entry or resetting the runtime releases its queued preview data, including in inactive conversations. OMP exposes queue text rather than stable message IDs. Rewritten queue text can retain its local submission through a correlated admission reply; ambiguous native entries remain unattributed. Previews lost across a runtime restart cannot be reconstructed from matching text or history.

OMP matches Steer by text, not attachment ID. A later same-text follow-up's Steer button is disabled when either occurrence has images, until the earlier follow-up moves out of that queue. This prevents promoting a different picture than the one shown.

Steer moves an existing follow-up through OMP's native promotion command without resending it. Pico projects the chat bubble before queue serialization or RPC acknowledgement, then replaces it once with the native user or user-invoked skill delivery. Queue events preserve FIFO duplicate and image identity. Failed promotion restores the original queue row; a steer dropped before delivery keeps its text and images as a failed local message in the current runtime, without automatic replay. Successful promotion does not wait for a full-state read. Native acceptance is not model consumption: OMP's interruption mode and provider transport still control when the model receives steering, and promotion does not hard-kill running tools.

The pencil uses OMP's native `remove_queued_message` command, supported by OMP 18.11.2. It is disabled for same-text duplicates in the same queue when any has images, because the native command cannot select attachment IDs. Known attachment-limit conflicts are rejected before withdrawal. If an unexpected native payload cannot fit alongside the current draft, Pico keeps it in memory and offers Restore withdrawn message after space is freed. Keep that window open until recovery is complete.

Retracted images come from the engine's actual queued payload, which OMP may resize or convert before sending. If the native response omits oversized images, Pico uses its retained local copy when available. Any unrecoverable image omission is reported instead of silently presenting a complete draft.

### Keyboard commands

| Command | Shortcut |
| --- | --- |
| Open project | Command-O |
| New thread | Command-N |
| Close window | Command-W |
| Quit with confirmation | Command-Q |
| Quick switcher | Command-K |
| Find in conversation | Command-F |
| Settings | Command-, |
| Send | Return or Command-Return |
| Newline | Shift-Return |
| Steer | Command-Shift-Return |
| Stop | Command-. |
| Toggle sidebar | Command-Option-S |
| Working-tree changes | Command-Option-D |

## Storage and safety

```text
~/Library/Application Support/PiDesktop/
  manifest.json
  prefs.json
  Threads/<thread-uuid>/OMP/
  Electron/
  Logs/last-diagnostics.txt
```

Manifest and preference writes are atomic. OMP owns durable messages, tool records, and session history. Pico resumes native sessions without replaying prompts. Corrupt metadata is reported rather than silently overwritten. Deleting a chat targets only its app-owned session directory, never its project folder.

The renderer uses context isolation, sandboxing, no Node integration, a restrictive Content Security Policy, sanitized Markdown, and a validated IPC bridge. Navigation, new windows, and webviews are blocked. External links open through an explicit desktop action. Git status and diff operations are read-only and use literal path arguments.

OMP runs commands and edits files with your normal macOS privileges and existing OMP policies. Choosing a project folder is not a filesystem sandbox. The application is single-user local software, not a security boundary against another process running as you.

Diagnostics stay local, bounded, and sanitized. There is no telemetry. Standard provider account setup uses Settings > Connections; Terminal handoff remains available for other terminal-only OMP operations.

## Development workflow

For each feedback-driven fix, verify the affected behavior, commit the fix, and push it to the repository. Then package, sign, replace the installed app, and relaunch it so the change is visible before reporting completion. Keep unrelated changes out of that commit. Staging a bundle alone is not installation; report push or installation failures as blockers. Quit the old app before replacing its bundle. When Pico hosts the current coding session, use a detached one-shot installer that survives that session's shutdown, waits for all app/helper processes to exit, verifies the replacement, and relaunches it. Do not register a LaunchAgent or login item.

## Verification

```sh
npm run verify
npm run performance -- --check
```

`verify` runs TypeScript checking, deterministic tests, and the production build. Tests use temporary repositories and test-only JSONL subprocesses, without provider calls.

The performance command exercises the real renderer in an explicitly headless, offscreen Electron window with isolated temporary storage. It covers history loading, adaptive streaming, Find, disclosures, Tasks, sidebar motion and resizing, focus behavior, and popover interaction. `scripts/streaming-checks.ts` exercises partial burst presentation, independent reasoning, immediate completion/correction, cached activation, real fade progress, stable word and Unicode continuations, selection, and code boundaries. `scripts/code-copy-checks.ts` covers independent block controls, focused-control preservation through streamed updates and corrections, literal fenced markup, and cleanup. Add `--runtime` to measure startup against a locally installed OMP. Use `--output <path>` to save results.

`scripts/steering-checks.ts` covers immediate chat bubbles, scroll following, native replacement, queue suppression for duplicate text and images, accepted-steer withdrawal, failure recovery, late acceptance, and thread isolation. Runtime subprocess cases also cover held admission and promotion, rewritten queue text, native skill delivery, timeout and late responses, and stop/disconnect behavior.

A separate end-to-end integration run uses your installed OMP and configured provider:

```sh
npm run smoke
```

**The smoke run makes real model calls and may incur provider charges.** It uses temporary projects and storage to exercise file edits, shell tools, model selection, queueing, Stop, approvals, and session restoration.

Screenshots, captured sessions, and machine-specific results under `Evidence/` are local-only and excluded from this repository. Automated checks do not cover VoiceOver audio, native context-menu popup visuals, every provider, or every third-party extension.

## App icon and dependencies

The app icon uses the supplied white organic burst on black, stored in `assets/Pico-source.png`. `scripts/make-icon.swift` scales the artwork onto a rounded macOS tile with transparent outer padding. Packaging regenerates all macOS icon sizes and `assets/Pico.icns`; `npm run icon` regenerates the icon independently.

Interface glyphs come from MIT-licensed [Tabler Icons](https://tabler.io/icons), except the project folder pair and activity spinner restored from the Codex desktop reference. Those filled paths are kept separately in `src/renderer/assets/`; generic folder action icons remain Tabler. The activity spinner uses Codex's muted ring, three-quarter foreground arc, and 2-second stepped rotation, respecting reduced motion. Motion uses [Motion](https://motion.dev/)'s framework-neutral DOM runtime, not React. Markdown uses [Marked](https://marked.js.org/), [DOMPurify](https://github.com/cure53/DOMPurify), and [KaTeX](https://katex.org/) for math. Third-party license notices are included in `THIRD_PARTY_NOTICES.md`.

Pico is an independent client, not an official OpenAI or Codex application. The project folder and spinner glyphs originate from that application's desktop reference and are not covered by Pico's MIT license. Folder provenance is recorded in `Evidence/codex-folder-source.json`. The activity spinner traces from `UTc` through shared export `r3` to `Ijt` and its default glyph `M1` in Codex 26.1013.40934's `app-initial-90eb42395b7d.js` and `app-shared-52443cbe9ac4.js`; `--animate-spin` in `app-shared-dc7535e633d7.css` supplies its timing.

Streaming presentation adapts the installed ChatGPT desktop reference's `ydd` adaptive buffer and opacity-only word fades from version 26.1013.40934, `app-initial-90eb42395b7d.js`. Pico uses the shipped default arrival-rate interval floor of 10 seconds, not the experiment-dependent 0.01-second alternative. The explicit 150 ms fade uses the reference's base duration and easing; its adaptive `--animation-duration-streaming-text` value and live experiment assignment were not established. This is a behavioral adaptation, not a claim of exact live-client timing parity.

## Protocol references

- [OMP RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)
- [OMP CLI options](https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md)
- [OMP session persistence](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)

## License

Pico is licensed under the [MIT license](LICENSE). Third-party components retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).
