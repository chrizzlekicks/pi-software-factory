import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const entry = resolve("docker/entrypoint.sh");
const cleanEnv = { PATH: process.env.PATH!, HOME: "/nonexistent" };
const run = (args: string[], env = {}) =>
  spawnSync("sh", [entry, ...args], { env: { ...cleanEnv, ...env }, encoding: "utf8" });

test("entrypoint rejects unknown modes, live without authorization, and GitHub tokens outside live", () => {
  assert.equal(run(["other"]).status, 2);
  assert.match(run(["live"]).stderr, /FACTORY_LIVE_ENABLE/);
  assert.match(run(["test"], { GH_TOKEN: "secret" }).stderr, /only allowed in live/);
  assert.match(run(["smoke"], { GITHUB_TOKEN: "secret" }).stderr, /only allowed in live/);
  assert.match(
    run(["live"], {
      FACTORY_LIVE_ENABLE: "1",
      GH_TOKEN: "secret",
      FACTORY_REPO_URL: "https://github.com/a/b;bad",
    }).stderr,
    /Invalid/,
  );
});

test("smoke refuses missing selective resources", () => {
  assert.match(run(["smoke"]).stderr, /Missing \/run\/factory-agents/);
});

test("default mode invokes npm test and does not require credentials", () => {
  const dockerfile = readFileSync("docker/Dockerfile", "utf8");
  assert.match(dockerfile, /CMD \["test"\]/);
  assert.match(readFileSync(entry, "utf8"), /exec npm test/);
});

test("image includes Docker test fixtures and uses legacy-compatible COPY", () => {
  const ignore = readFileSync(".dockerignore", "utf8");
  const dockerfile = readFileSync("docker/Dockerfile", "utf8");
  for (const file of [
    ".dockerignore",
    "docker/",
    "docker/Dockerfile",
    "docker/entrypoint.sh",
    "docker/live-smoke.mjs",
    "docker/probe-events.mjs",
  ]) {
    assert.ok(ignore.split("\n").includes(`!${file}`), `build context must include ${file}`);
  }
  assert.match(
    dockerfile,
    /^COPY --chown=node:node docker\/Dockerfile docker\/entrypoint\.sh docker\/live-smoke\.mjs docker\/probe-events\.mjs \.\/docker\/$/m,
  );
  assert.match(dockerfile, /^COPY --chown=node:node \.dockerignore \.\/\.dockerignore$/m);
  assert.doesNotMatch(dockerfile, /^COPY\s+--chmod(?:=|\s)/m);
  assert.match(dockerfile, /^RUN chmod 755 \/usr\/local\/bin\/factory-entrypoint$/m);
  assert.ok(
    dockerfile.indexOf("RUN chmod 755 /usr/local/bin/factory-entrypoint") <
      dockerfile.indexOf("USER node"),
  );
});

test("image excludes credentials and keeps clone in the volume path", () => {
  const ignore = readFileSync(".dockerignore", "utf8");
  const dockerfile = readFileSync("docker/Dockerfile", "utf8");
  const script = readFileSync(entry, "utf8");
  assert.match(ignore, /^\*\*$/m);
  assert.doesNotMatch(dockerfile, /COPY.*(?:auth\.json|\.pi\/agent)/);
  assert.match(dockerfile, /chown node:node \/workspace/);
  assert.match(script, /git clone -- "\$FACTORY_REPO_URL" \/workspace\/repo/);
  assert.match(script, /chmod 600 "\$HOME\/\.pi\/agent\/auth\.json"/);
});
