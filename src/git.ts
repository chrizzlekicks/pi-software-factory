import { isUtf8 } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  realpathSync,
  lstatSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
  constants,
  mkdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

import type { Command, Plan, Run } from "./state.ts";

export function validCommitSubject(subject: unknown): subject is string {
  return (
    typeof subject === "string" &&
    subject.length <= 72 &&
    // oxlint-disable-next-line no-control-regex -- Commit subjects must not contain terminal controls.
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(subject) &&
    /^(docs|fix|feat|refactor|test|chore|build|ci|perf|revert|style)(\([a-zA-Z0-9._/-]+\))?!?: [^\s\r\n](?:[^\r\n]*[^\s\r\n])?$/.test(
      subject,
    )
  );
}

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
    if (
      s.location !== "worktree" ||
      s.repo !== this.repo ||
      !/^[0-9a-f-]{36}$/.test(s.id) ||
      s.branch !== `factory/${s.id}` ||
      this.head() !== s.baseRevision
    ) {
      throw new Error("Invalid factory worktree base");
    }
    const parent = join(this.stateDir(), "worktrees");
    const worktree = join(parent, s.id);
    if (existsSync(worktree) || this.git(["branch", "--list", s.branch])) {
      throw new Error("Factory worktree or branch already exists");
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.git(["worktree", "add", "-b", s.branch, worktree, s.baseRevision]);
    return realpathSync(worktree);
  }

  assertOwned(s: Run): asserts s is Run & { worktree: string } {
    if (s.location !== "worktree") {
      throw new Error(
        "Legacy execution location: inspect the original worktree and recover manually; automatic continuation is unsupported",
      );
    }
    if (
      !s.worktree ||
      !/^[0-9a-f-]{36}$/.test(s.id) ||
      realpathSync(s.worktree) !== join(realpathSync(join(this.stateDir(), "worktrees")), s.id) ||
      s.repo !== this.repo ||
      s.branch !== "factory/" + s.id ||
      realpathSync(resolve(s.worktree, this.git(["rev-parse", "--git-common-dir"], s.worktree))) !==
        realpathSync(resolve(this.repo, this.git(["rev-parse", "--git-common-dir"])))
    ) {
      throw new Error("Invalid factory worktree location");
    }
    if (this.git(["symbolic-ref", "--short", "HEAD"], s.worktree) !== s.branch) {
      throw new Error("Checkout branch changed; inspect before continuing");
    }
  }

  snapshot(s: Run) {
    this.assertOwned(s);
    const hash = createHash("sha256");
    for (const args of [
      ["diff", "--raw", "-z", "--no-renames", "--ignore-submodules=none", s.baseRevision],
      [
        "diff",
        "--cached",
        "--raw",
        "-z",
        "--no-renames",
        "--ignore-submodules=none",
        s.baseRevision,
      ],
    ]) {
      const raw = this.git(args, s.worktree);
      if (/(?:^|\0):(?:160000 [0-7]{6}|[0-7]{6} 160000) /.test(raw)) {
        throw new Error("Changed submodules cannot be reviewed safely");
      }
    }
    hash.update(this.head(s.worktree));
    for (const args of [
      ["diff", "--binary", "HEAD"],
      ["diff", "--cached", "--binary", "HEAD"],
    ]) {
      hash.update(
        execFileSync("git", args, { cwd: s.worktree, maxBuffer: 8_000_000, timeout: 30_000 }),
      );
    }
    const paths = this.git(["ls-files", "--others", "--exclude-standard", "-z"], s.worktree)
      .split("\0")
      .filter(Boolean);
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

  reviewText(s: Run) {
    this.assertOwned(s);
    for (const args of [
      ["diff", "--no-ext-diff", "--numstat", "-z", s.baseRevision],
      ["diff", "--cached", "--no-ext-diff", "--numstat", "-z", s.baseRevision],
    ]) {
      if (/(?:^|\0)-\t-\t/.test(this.git(args, s.worktree))) {
        throw new Error("Binary changes require unsupported review coverage");
      }
    }
    const diff = (args: string[]) => {
      const bytes = execFileSync(
        "git",
        [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          ...args,
          s.baseRevision,
        ],
        { cwd: s.worktree, timeout: 30_000, maxBuffer: 8_000_000 },
      );
      if (!isUtf8(bytes)) {
        throw new Error("Non-UTF-8 changes require unsupported review coverage");
      }
      return bytes.toString("utf8");
    };
    let text = `# Change manifest\n${JSON.stringify(this.changed(s))}\n\n# Working tree diff\n${diff([])}\n\n# Index diff\n${diff(["--cached"])}\n`;
    const paths = this.git(["ls-files", "--others", "--exclude-standard", "-z"], s.worktree)
      .split("\0")
      .filter(Boolean);
    for (const path of paths) {
      const full = join(s.worktree, path);
      const stat = lstatSync(full);
      let content: string;
      if (stat.isSymbolicLink()) {
        content = `symlink -> ${readlinkSync(full)}`;
      } else {
        if (!stat.isFile() || stat.size > 8_000_000) {
          throw new Error(`Unsupported review coverage: ${path}`);
        }
        const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          bytes = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
        if (bytes.includes(0) || !isUtf8(bytes)) {
          throw new Error(`Binary changes require unsupported review coverage: ${path}`);
        }
        content = bytes.toString("utf8");
      }
      text += `\n# New file ${JSON.stringify(path)}\n${content}\n`;
      if (Buffer.byteLength(text) > 16_000_000) {
        throw new Error("Review material exceeds supported coverage");
      }
    }
    if (text.split("\n").some((line) => Buffer.byteLength(line) > 50 * 1024)) {
      throw new Error("Review material contains an overlong line; unsupported review coverage");
    }
    return text;
  }

  scope(s: Run, plan: Plan) {
    this.assertOwned(s);
    const extra = this.changed(s).filter(
      (p) => !plan.files.some((f) => (f.endsWith("/") ? p.startsWith(f) : p === f)),
    );
    if (extra.length) {
      throw new Error(`Scope change requires a validated plan revision: ${extra.join(", ")}`);
    }
  }

  finalize(s: Run, snapshot: string, subject: string) {
    if (!validCommitSubject(subject)) {
      throw new Error("Invalid final commit subject");
    }
    this.unchanged(s, s.baseRevision);
    if (this.snapshot(s) !== snapshot) {
      throw new Error("Candidate changed before finalization");
    }
    this.assertOwned(s);
    const index = join(this.stateDir(), `index-${randomUUID()}`);
    let expected: string;
    try {
      const temporaryGit = (args: string[]) =>
        execFileSync("git", args, {
          cwd: s.worktree,
          env: { ...process.env, GIT_INDEX_FILE: index },
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 8_000_000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      temporaryGit(["read-tree", this.git(["write-tree"], s.worktree)]);
      temporaryGit(["add", "--all"]);
      expected = temporaryGit(["write-tree"]);
    } finally {
      if (existsSync(index)) {
        unlinkSync(index);
      }
    }
    if (this.snapshot(s) !== snapshot) {
      throw new Error("Candidate changed during finalization");
    }
    this.git(["add", "--all"], s.worktree);
    const tree = this.git(["write-tree"], s.worktree);
    if (tree !== expected) {
      throw new Error("Staged tree differs from accepted candidate");
    }
    if (tree === this.git(["rev-parse", `${s.baseRevision}^{tree}`], s.worktree)) {
      return undefined;
    }
    this.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", subject], s.worktree);
    if (this.git(["rev-parse", "HEAD^{tree}"], s.worktree) !== tree || !this.clean(s.worktree)) {
      throw new Error("Final commit does not match accepted candidate tree");
    }
    return this.head(s.worktree);
  }

  unchanged(s: Run, revision: string) {
    this.assertOwned(s);
    if (this.head(s.worktree) !== revision) {
      throw new Error("Git revision changed; evidence invalid");
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
      throw new Error("Invalid allowed file path: " + file);
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
