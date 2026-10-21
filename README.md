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

For development:

```sh
npm start
```

Pico searches PATH and common Homebrew, Bun, and local binary directories for OMP. Settings also accepts an explicit executable path. Test connection checks the RPC handshake, protocol negotiation, and state response. Configure provider credentials through OMP in Terminal. Pico has no separate account system.

### Upgrading from Pi Desktop

Pico retains the existing `local.bg.PiDesktop` bundle identifier and `~/Library/Application Support/PiDesktop/` storage directory. Existing projects, chats, drafts, and settings stay in place without copying or migrating sessions. The internal `PI_DESKTOP_*` verification environment variables also remain unchanged.

Quit Pi Desktop before opening Pico. They share the same saved sessions and should not run together.

## Conversations

- Open project folders and keep separate conversations within each project.
- Stream assistant responses, reasoning, and grouped tool activity. Restored history does not replay streaming effects.
- Switch models and thinking levels using OMP's live discovery. Inherit clears an explicit effort setting; it does not enable OMP's separate Auto classifier.
- Queue follow-ups, steer an active run with Command-Shift-Return, or stop it with the send/stop control.
- Paste, drop, or choose image attachments. Image prompts require a vision-capable model.
- Inspect Tasks, Agents, Advisor notes, and read-only working-tree diffs without leaving the conversation.
- Search conversations with the quick switcher and search the current transcript with Find.
- Hand a conversation back to Terminal. Pico closes its OMP process, copies a continuation command, and opens Terminal without executing the command automatically.

The sidebar is resizable and collapsible. Collapsed project folders show activity when one of their chats is running. Dark and light appearances, reduced motion, selectable transcripts, and keyboard navigation are supported. The conversation canvas is edge-to-edge, with a shared 768px reading column. Focus outlines are intentionally suppressed while keyboard focus and dialog trapping remain active.

Pico keeps up to three OMP processes, recycling only idle ones. Closing the window does not stop active conversations. Quitting closes every app-owned process with bounded termination escalation.

### Keyboard commands

| Command | Shortcut |
| --- | --- |
| Open project | Command-O |
| New thread | Command-N |
| Close window | Command-W |
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

Diagnostics stay local, bounded, and sanitized. There is no telemetry. Provider login and authentication flows requiring terminal interaction use Terminal handoff.

## Verification

```sh
npm run verify
npm run performance -- --check
```

`verify` runs TypeScript checking, deterministic tests, and the production build. Tests use temporary repositories and test-only JSONL subprocesses, without provider calls.

The performance command exercises the real renderer in an explicitly headless, offscreen Electron window with isolated temporary storage. It covers history loading, streaming, Find, disclosures, Tasks, sidebar motion and resizing, focus behavior, and popover interaction. Add `--runtime` to measure startup against a locally installed OMP. Use `--output <path>` to save results.

A separate end-to-end integration run uses your installed OMP and configured provider:

```sh
npm run smoke
```

**The smoke run makes real model calls and may incur provider charges.** It uses temporary projects and storage to exercise file edits, shell tools, model selection, queueing, Stop, approvals, and session restoration.

Screenshots, captured sessions, and machine-specific results under `Evidence/` are local-only and excluded from this repository. Automated checks do not cover VoiceOver audio, native context-menu popup visuals, every provider, or every third-party extension.

## App icon and dependencies

The app icon is a locally rendered, square-ended pi mark in muted gray on a dark rounded tile. Its source is `scripts/make-icon.swift`. Packaging regenerates all macOS icon sizes and `assets/Pico.icns`; `npm run icon` regenerates the icon independently.

Interface glyphs come from MIT-licensed [Tabler Icons](https://tabler.io/icons). Motion uses [Motion](https://motion.dev/)'s framework-neutral DOM runtime, not React. Markdown uses [Marked](https://marked.js.org/) and [DOMPurify](https://github.com/cure53/DOMPurify). Third-party license notices are included in `THIRD_PARTY_NOTICES.md`.

Pico is an independent client, not an official OpenAI or Codex application. It does not include icon assets extracted from those applications.

## Protocol references

- [OMP RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)
- [OMP CLI options](https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md)
- [OMP session persistence](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)

## License

Pico is licensed under the [MIT license](LICENSE). Third-party components retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).
