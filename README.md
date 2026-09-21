# pi-safe-resume

A Pi extension that warns before an expensive cold continuation and offers a one-click restart with the previous conversation attached.

## Why this exists

Prompt caches expire. When you return to a large Pi session after a long break, the next request re-sends the whole conversation as fresh input. On a 500,000-token session that is a few dollars for a single request, and `/compact` pays the same cost because summarising reads the history too.

This extension pauses before that request, tells you what it could cost, and offers a fresh session that carries a bounded handoff plus a tool for retrieving older detail on demand.

## Install

```bash
pi install git:github.com/noetion/pi-safe-resume
```

To try it without installing:

```bash
pi -e git:github.com/noetion/pi-safe-resume
```

No service, account, or API key beyond what Pi already uses.

## What you see

When a submitted message could trigger a cold reload, Pi pauses before any provider call:

```
This request could trigger an expensive cold reload.

Previous context: ~500,000 tokens
Estimated cold input cost: ~$1.88 (API-equivalent estimate), excluding output

Provider routing and cache availability are not fully observable beforehand.

> Start a new session with previous context
  Continue this session
  Cancel
```

For `/compact`, the same three choices appear with a different explanation:

```
Compacting this session also requires processing its history.
Start a new session instead, or continue with compaction.
```

The three choices behave like this.

- **Start a new session with previous context.** Pi creates a replacement session, seeds it with a bounded handoff, and submits the message you just typed. Your original session stays on disk and Pi records it as the parent of the new one.
- **Continue this session.** The original action proceeds unchanged. The extension does not ask again during the same interaction.
- **Cancel or Escape.** Nothing is sent, and your message goes back into the editor.

## What the new session carries

The handoff is built locally and makes zero model calls. It is capped at about 4,000 tokens and includes, in priority order:

| Item | Source |
|---|---|
| Existing compaction summary | Reused from the transcript, never regenerated |
| Original task | The first user message |
| Most recent assistant response | Its existing text |
| Recent user messages | Up to six, newest first |
| Previous-session reference | A link the retrieval tool reads |

Every excerpt that was shortened and every message left out is listed under `## Not included`. The handoff opens by saying it is a bounded excerpt rather than a complete record, and it closes with the instruction to retrieve detail through `previous_context` and to check current files before trusting historical code.

Your message is forwarded unchanged, including any attached images, with skill and template expansion preserved.

## Retrieving older context

The new session gets one tool.

```
previous_context
    action: "search", query: "..."      matching excerpts with entry ids
    action: "read",   entryId: "..."    a bounded portion of one entry
```

Searches read only the recorded branch of the source session, so a sibling branch cannot leak in. Each response is capped at about 2,000 tokens, and the tool spends against a cumulative automatic allowance of about 20,000 tokens before it asks you whether to expand it. Output is labelled as historical transcript data rather than instructions.

## Settings

The warning threshold defaults to $1. Change it in any of three ways.

```bash
export PI_SAFE_RESUME_WARN_USD=2.5      # environment
pi --safe-resume-warn-usd 2.5           # CLI flag
/safe-resume 2.5                        # current session only
```

Run `/safe-resume` with no argument to print the threshold, the active model, the retention tier and its length, the context size, the age of the cache reference, the linked previous session, and the retrieval allowance spent.

## When the warning appears

The extension warns only when every one of these holds.

- The model publishes prompt-cache pricing.
- Pi can estimate the context size.
- A request that read or wrote the cache was observed, either live or from the transcript.
- The time since that request started exceeds the cache lifetime Pi has for the model.
- The estimated cold input cost reaches the threshold.

The lifetime comes from the model's own metadata and the configured retention tier. `PI_CACHE_RETENTION` selects `short` or `long`, and `short` is the default, matching Pi's own resolution. Setting it to `none` turns caching off, so the extension stays quiet.

Retention runs from the start of the request that touched the cache, not from the end of its response, so a long generation does not appear to extend the entry's life. The extension records the request start from `before_provider_request` and promotes it to the cache reference only once a response reports a cache read or write. Under `long` retention a cache write costs twice the base input rate, and the estimate applies that rate.

Pi refreshes an idle cache entry itself for a while after a run settles. Those refreshes do not pass through `before_provider_request`, so the extension reads the `cache_warm` usage entry Pi records and treats the later of the two as the reference.

## Limits

- The wording is "could trigger" on purpose. Provider routing and cache availability are not observable before the request.
- Prices are API-equivalent estimates. Under subscription authentication they are not extra cash charges and they are not exact quota consumption.
- The estimate covers input only. Output tokens are excluded.
- Only a manual `/compact` is intercepted. Threshold and overflow compaction proceed untouched, because that is how Pi recovers a session.
- When a model publishes no cache lifetime, the warning says so and shows no expiry time. When it also publishes no cache pricing, the warning appears only if the context fills at least half the window, and it shows no dollar figure.
- The extension cannot see a per-request cache retention override applied by another extension or by direct SDK use. It reads `PI_CACHE_RETENTION` and otherwise assumes `short`.
- For a `/compact` restart the replacement session holds the handoff in memory. Pi creates a session file only after the first assistant message, so the file appears once you send your first message in the new session.
- A session this process never observed takes its cache reference from a transcript timestamp. That timestamp marks a response, which is later than the request start, so the measured idle time is too small and the warning can arrive late rather than early. Pi's cache warmer covers part of that gap, and the rest is not.
- Pi tears the old session down before it runs the replacement setup. If the switch then fails, the old context is already gone and the message cannot be put back in the editor. The extension records it in the previous session as a `safe-resume:pending` entry before the switch starts, and reports the failure.
- Cancel restores the message text. Pi exposes no way to restore attached images, and the notice says so.
- This is a resume-time warning. It is not a spending cap for Pi or for any other extension.

## Development

```bash
npm install
npm run typecheck
npm test
```

Node 20 or later. The tests use Node's built-in runner with TypeScript type stripping, so there is no test framework to install.

`npm test` runs 112 tests.

- `npm run test:unit` runs 69 tests over the cost and timing estimate, the guard state machine, handoff extraction, and transcript retrieval.
- `npm run test:integration` runs 43 tests that drive the real extension factory against Pi's real `SessionManager` on real session files, and load the entry point through Pi's own extension loader.

`test/pi-loader.test.ts` calls `discoverAndLoadExtensions`, so Pi compiles `src/index.ts` with its own loader and runs the factory against its own registration plumbing. It checks that every event handler, the tool, both commands, and the flag register without a loader error.

The integration tests replace one thing, which is Pi's runtime binding of events to handlers. `test/pi-stub.ts` replays the arguments Pi dispatches for `input`, `session_before_compact`, `before_provider_request`, `message_end`, `agent_settled`, and `session_start`. The rule that `pi.sendUserMessage("/cmd", { expandPromptTemplates: true })` runs an extension command without sending a prompt is read from Pi's published source in `dist/core/agent-session.js` rather than executed here.

Nothing runs the Pi CLI or its terminal UI, because the choice dialog needs an interactive or RPC client to answer it.

## Layout

```
src/
  index.ts     events, dialog, command and tool registration
  risk.ts      timing and cold-cost estimate
  guard.ts     the four-phase guard state machine
  handoff.ts   local extraction and the session link
  history.ts   bounded transcript search and read
  types.ts     shared data shapes
test/
  helpers.ts         fixtures with a fixed clock and stub models
  pi-stub.ts         recording stand-in for the Pi extension API
  pi-loader.test.ts  loads the entry point through Pi's own loader
  risk.test.ts
  guard.test.ts
  handoff.test.ts
  history.test.ts
  integration.test.ts
```

## License

MIT
