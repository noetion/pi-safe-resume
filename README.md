# pi-safe-resume

A Pi extension that warns before an expensive cold continuation and offers a one-click restart that carries the previous conversation forward.

## Why

Prompt caches expire. Return to a large Pi session after a break and the next request re-sends the whole conversation as fresh input. On a 500,000-token session that is a few dollars for one request, and `/compact` costs the same because summarising reads the history too.

This extension pauses before that request, shows what it could cost, and offers a fresh session seeded with a bounded handoff plus a tool for pulling older detail on demand.

## Install

```bash
pi install npm:pi-safe-resume
```

Requires Pi 0.86 or later. No service, account, or API key beyond what Pi already uses.

To install from the source repository, or to try it for a single run without installing:

```bash
pi install git:github.com/noetion/pi-safe-resume
pi -e git:github.com/noetion/pi-safe-resume
```

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

A manual `/compact` shows the same three choices, explaining that compaction also reprocesses the history.

- **Start a new session with previous context.** Pi creates a replacement session, seeds it with a bounded handoff, and submits the message you just typed. The original session stays on disk and is recorded as the parent.
- **Continue this session.** The original action proceeds unchanged. The extension does not ask again during the same interaction.
- **Cancel or Escape.** Nothing is sent, and your message returns to the editor.

## What the new session carries

The handoff is built locally with zero model calls, capped at about 4,000 tokens, and includes in priority order:

| Item | Source |
|---|---|
| Existing compaction summary | Reused from the transcript, never regenerated |
| Original task | The first user message |
| Most recent assistant response | Its existing text |
| Recent user messages | Up to six, newest first |
| Previous-session reference | A link the retrieval tool reads |

Every shortened excerpt and every omitted message is listed under `## Not included`. The handoff states up front that it is a bounded excerpt, and closes by telling the model to retrieve detail through `previous_context` and to check current files before trusting historical code. Your message is forwarded unchanged, including attached images, with skill and template expansion preserved.

## Retrieving older context

The new session gets one tool:

```
previous_context
    action: "search", query: "..."     matching excerpts with entry ids
    action: "read",   entryId: "..."   a bounded portion of one entry
```

Searches read only the recorded branch of the source session, so a sibling branch cannot leak in. Each response is capped at about 2,000 tokens, and the tool spends against a cumulative allowance of about 20,000 tokens before asking whether to expand it. Output is labelled historical transcript data, not instructions.

## Settings

The warning threshold defaults to $1. Set it three ways:

```bash
export PI_SAFE_RESUME_WARN_USD=2.5      # environment
pi --safe-resume-warn-usd 2.5           # CLI flag
/safe-resume 2.5                        # current session only
```

Run `/safe-resume` with no argument to print the threshold, the active model, the retention tier and length, the context size, the age of the cache reference, the linked previous session, and the retrieval allowance spent.

## When the warning appears

It warns only when all of these hold:

- The model publishes prompt-cache pricing.
- Pi can estimate the context size.
- A cache read or write was observed, either live, or from a `cache_warm` entry, or from a cache-relevant assistant message.
- The time since that request started exceeds the model's cache lifetime.
- The estimated cold input cost reaches the threshold.

The lifetime comes from the model's metadata and the configured retention tier. `PI_CACHE_RETENTION` selects `short` or `long`, defaulting to `short` to match Pi. Retention is measured from the start of the request that touched the cache, not the end of its response, so a long generation does not appear to extend the entry's life. A long-retention cache write is billed at twice the base input rate when the model publishes a long lifetime.

Pi refreshes an idle cache entry for a while after a run. Those refreshes bypass `before_provider_request`, so the extension reads the `cache_warm` usage entry Pi records and treats the later of the two as the reference.

## Limits

- The wording is "could trigger" by design. Provider routing and cache availability are not observable beforehand.
- Prices are API-equivalent estimates. Under subscription authentication they are neither extra cash charges nor exact quota consumption.
- The estimate covers input only. Output tokens are excluded.
- Only a manual `/compact` is intercepted. Threshold and overflow compaction proceed untouched, because that is how Pi recovers a session.
- With no published cache lifetime, the warning says so and shows no expiry. With no cache pricing either, it appears only when the context fills at least half the window, and shows no dollar figure.
- It cannot see a per-request retention override from another extension or from direct SDK use. It reads `PI_CACHE_RETENTION` and otherwise assumes `short`.
- For a `/compact` restart the replacement holds the handoff in memory. Pi writes the session file only after the first assistant message.
- A session this process never observed takes its reference from the newer of a `cache_warm` entry and a cache-relevant assistant message. Both mark a response, later than the request start, so the warning can arrive late rather than early.
- Pi tears the old session down before running the replacement setup. If the switch then fails, the old context is already gone and the message cannot return to the editor. The extension records it in the previous session as a `safe-resume:pending` entry before the switch and reports the failure.
- Cancel restores the message text. Pi exposes no way to restore attached images, and the notice says so.
- This is a resume-time warning, not a spending cap for Pi or any other extension.

## Development

```bash
npm install
npm run typecheck
npm test
```

Node 20 or later. The tests use Node's built-in runner with TypeScript type stripping, so there is no framework to install. `npm test` runs 118 tests: 73 unit over the cost and timing estimate, the guard state machine, handoff extraction, and transcript retrieval; 45 integration that drive the real extension factory against Pi's real `SessionManager` on real session files, and load the entry point through Pi's own extension loader.

The automated suite does not launch the Pi CLI or its terminal UI, because the choice dialog needs an interactive or RPC client to answer it.

## Layout

```
src/
  index.ts     events, dialog, command and tool registration
  risk.ts      timing and cold-cost estimate
  guard.ts     the four-phase guard state machine
  handoff.ts   local extraction and the session link
  history.ts   bounded transcript search and read
  types.ts     shared data shapes
test/          unit and integration suites
```

## License

MIT
