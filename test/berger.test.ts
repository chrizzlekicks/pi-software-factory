import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bergerDisplay } from "../src/berger.ts";

test("Berger display maps phases, deduplicates, and ignores missing executable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-berger-"));
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const output = join(dir, "events");
  const bin = join(dir, "berger");
  writeFileSync(bin, `#!/bin/sh\ncat >> '${output}'\nprintf '\\n' >> '${output}'\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = dir + ":" + previous;
  const display = bergerDisplay();
  const state: any = { phase: "awaiting_approval", paused: false, cancelled: false };
  display(state);
  display(state);
  for (let i = 0; i < 100 && !existsSync(output); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const events = readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.deepEqual(events, [{ harness: "pi", hook_event_name: "ui_prompt_start" }]);
  process.env.PATH = dir;
  rmSync(bin);
  display({ ...state, phase: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 50));
});
