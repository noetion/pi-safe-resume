/**
 * Loads the extension through Pi's own extension loader.
 *
 * This is the one check the rest of the suite cannot make: `loadExtensions`
 * compiles the TypeScript entry point with Pi's loader and runs the factory
 * against Pi's registration plumbing. Everything else drives the factory with a
 * stand-in for that plumbing.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const ENTRY = resolve(import.meta.dirname, "..", "src", "index.ts");

test("Pi's loader compiles the entry point and runs the factory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-safe-resume-loader-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-safe-resume-agent-"));
  const result = await discoverAndLoadExtensions([ENTRY], cwd, agentDir);

  assert.deepEqual(result.errors, [], `Pi reported loader errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.extensions.length, 1);

  const extension = result.extensions[0];
  assert.ok(extension);
  assert.equal(extension.resolvedPath, ENTRY);

  for (const event of [
    "session_start",
    "session_shutdown",
    "before_provider_request",
    "message_end",
    "agent_settled",
    "input",
    "session_before_compact",
  ]) {
    assert.equal(extension.handlers.has(event), true, `no handler registered for ${event}`);
  }

  assert.deepEqual([...extension.tools.keys()], ["previous_context"]);
  assert.deepEqual([...extension.commands.keys()].sort(), ["safe-resume", "safe-resume-restart"]);
  assert.deepEqual([...extension.flags.keys()], ["safe-resume-warn-usd"]);

  const tool = extension.tools.get("previous_context");
  assert.ok(tool);
  assert.equal(tool.definition.name, "previous_context");
  assert.deepEqual(Object.keys((tool.definition.parameters as { properties: Record<string, unknown> }).properties).sort(), [
    "action",
    "entryId",
    "limit",
    "query",
  ]);
  assert.match(tool.definition.description ?? "", /capped at about 2000 tokens per response/);
});
