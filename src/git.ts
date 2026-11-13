import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  realpathSync,
  lstatSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

import type { Command, Plan, Run } from "./state.ts";

export function execute(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Cancelled"));
    }
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    let stdout = "",
      stderr = "",
      stopped = false;
    const stop = () => {
      stopped = true;
      try {
        const pid = child.pid;
        if (pid !== undefined) {
          process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
        }
      } catch {}
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b) => {
      stdout += b;
      if (stdout.length + stderr.length > 4_000_000) {
        stop();
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b;
      if (stdout.length + stderr.length > 4_000_000) {
        stop();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (stopped) {
        reject(new Error("Command interrupted, timed out, or exceeded 4 MB output"));
      } else {
        done({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

export class Git {
  repo: string;

  constructor(repo: string) {
    this.repo = realpathSync(this.gitAt(repo, ["rev-parse", "--show-toplevel"]));
  }

  gitAt(cwd: string, args: string[]) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  git(args: string[], cwd = this.repo) {
    return this.gitAt(cwd, args);
  }

  stateDir() {
    return join(resolve(this.repo, this.git(["rev-parse", "--git-common-dir"])), "pi-factory");
  }

  head(cwd = this.repo) {
    return this.git(["rev-parse", "HEAD"], cwd);
  }

  clean(cwd = this.repo) {
    return this.git(["status", "--porcelain", "--untracked-files=all"], cwd) === "";
  }

  create(s: Run) {
    if (!this.clean() || this.head() !== s.baseRevision) {
      throw new Error("Repository changed since planning");
    }
    this.git(["switch", "-c", s.branch, s.baseRevision]);
    return this.repo;
  }

  assertOwned(s: Run): asserts s is Run & { worktree: string } {
    if (s.location !== "checkout") {
      throw new Error(
        "Legacy execution location: inspect the original worktree and recover manually; automatic continuation is unsupported",
      );
    }
    if (
      !s.worktree ||
      s.worktree !== s.repo ||
      s.repo !== this.repo ||
      !s.branch.startsWith("factory/")
    ) {
      throw new Error("Invalid factory checkout location");
    }
    if (this.git(["symbolic-ref", "--short", "HEAD"], s.worktree) !== s.branch) {
      throw new Error("Checkout branch changed; inspect before continuing");
    }
  }

  snapshot(s: Run) {
    this.assertOwned(s);
    const hash = createHash("sha256");
    hash.update(this.head(s.worktree));
    for (const args of [
      ["diff", "--binary", "HEAD"],
      ["diff", "--cached", "--binary", "HEAD"],
    ]) {
      hash.update(
        execFileSync("git", args, { cwd: s.worktree, maxBuffer: 8_000_000, timeout: 30_000 }),
      );
    }
    const paths = this.git(["ls-files", "--others", "-z"], s.worktree).split("\0").filter(Boolean);
    paths.sort();
    if (paths.length > 200_000) {
      throw new Error("Snapshot file limit exceeded; inspected recovery required");
    }
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (const path of paths) {
      const full = join(s.worktree, path);
      const stat = lstatSync(full);
      hash.update(path + "\0" + stat.mode + "\0");
      if (stat.isSymbolicLink()) {
        hash.update(readlinkSync(full));
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("Snapshot contains special file; inspected recovery required: " + path);
      }
      if (bytes + stat.size > 1_000_000_000) {
        throw new Error("Snapshot byte limit exceeded; inspected recovery required");
      }
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        let n: number;
        while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          bytes += n;
          if (bytes > 1_000_000_000) {
            throw new Error("Snapshot byte limit exceeded; inspected recovery required");
          }
          hash.update(buffer.subarray(0, n));
        }
      } finally {
        closeSync(fd);
      }
    }
    return hash.digest("hex");
  }

  changed(s: Run): string[] {
    const tracked = this.git(
      ["diff", "--no-renames", "--name-only", "-z", s.baseRevision],
      s.worktree,
    );
    const staged = this.git(
      ["diff", "--cached", "--no-renames", "--name-only", "-z", s.baseRevision],
      s.worktree,
    );
    const untracked = this.git(["ls-files", "--others", "--exclude-standard", "-z"], s.worktree);
    return [
      ...new Set(
        [...tracked.split("\0"), ...staged.split("\0"), ...untracked.split("\0")].filter(Boolean),
      ),
    ];
  }

  scope(s: Run, plan: Plan) {
    this.assertOwned(s);
    const extra = this.changed(s).filter(
      (p) => !plan.files.some((f) => (f.endsWith("/") ? p.startsWith(f) : p === f)),
    );
    if (extra.length) {
      throw new Error(`Scope change requires renewed approval: ${extra.join(", ")}`);
    }
  }

  checkpoint(s: Run, plan: Plan) {
    this.scope(s, plan);
    if (!this.clean(s.worktree)) {
      this.git(["add", "--all"], s.worktree);
      this.git(
        [
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          `factory: ${plan.summary.slice(0, 120)}`,
        ],
        s.worktree,
      );
    }
    return this.head(s.worktree);
  }

  unchanged(s: Run, revision: string) {
    this.assertOwned(s);
    if (this.head(s.worktree) !== revision || !this.clean(s.worktree)) {
      throw new Error("Verification/review changed the revision or working tree; evidence invalid");
    }
  }
}

function strings(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= 64 &&
    v.every((x) => typeof x === "string" && x.trim() && x.length <= 4000)
  );
}

export function validatePlan(value: unknown): Plan {
  const p = value as Plan;
  if (
    !p ||
    typeof p.summary !== "string" ||
    !p.summary.trim() ||
    p.summary.length > 4000 ||
    !strings(p.tasks) ||
    !p.tasks.length ||
    !strings(p.files) ||
    !p.files.length ||
    !strings(p.risks) ||
    !strings(p.dependencies) ||
    !Array.isArray(p.verification) ||
    !p.verification.length ||
    p.verification.length > 16
  ) {
    throw new Error(
      "Invalid plan: summary, tasks, files, risks, dependencies and verification required",
    );
  }
  for (const file of p.files) {
    const clean = file.replace(/\/$/, "");
    if (
      !clean ||
      isAbsolute(file) ||
      clean.split("/").some((x) => !x || x === ".." || x === "." || x.toLowerCase() === ".git") ||
      file.includes("\\") ||
      file.includes("\0") ||
      file.startsWith("-")
    ) {
      throw new Error("Invalid approved file path: " + file);
    }
  }
  p.verification.forEach(validateCommand);
  return p;
}

export function validateCommand(v: unknown): asserts v is Command {
  const c = v as Command;
  if (
    !c ||
    typeof c.command !== "string" ||
    !c.command.trim() ||
    c.command.startsWith("-") ||
    c.command.includes("\0") ||
    !Array.isArray(c.args) ||
    c.args.length > 128 ||
    c.args.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 16000) ||
    typeof c.purpose !== "string" ||
    !c.purpose.trim()
  ) {
    throw new Error("Invalid verification command");
  }
}

export function safeRelative(root: string, path: string) {
  const r = relative(root, path);
  return r && !r.startsWith("..") && !isAbsolute(r);
}
