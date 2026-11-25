import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Git, execute } from "./git.ts";
import type { Run } from "./state.ts";

function githubRepo(remote: string) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    remote,
  )?.[1];
}

export function verificationText(s: Run): string {
  const verdict = s.verificationVerdict;
  if (verdict) {
    if (!s.revision || verdict.revision !== s.revision) {
      throw new Error("Verification verdict does not match final revision");
    }
    return `Final revision ${s.revision}. Verification: ${verdict.status}. ${verdict.reason} Repair cycles: ${s.repairs}/5.`;
  }
  return `Final revision ${s.revision}. Independent tests, quality/security/Ponytail reviews, documentation audit and completion triage passed. Repair cycles: ${s.repairs}/5.`;
}

export class GitHubDelivery {
  git: Git;
  artifacts: string;

  constructor(git: Git, artifacts: string) {
    this.git = git;
    this.artifacts = artifacts;
  }

  private async gh(args: string[]) {
    const r = await execute("gh", args, this.git.repo);
    if (r.code !== 0) {
      throw new Error(`GitHub CLI failed (${args.slice(0, 2).join(" ")}): ${r.stderr}`);
    }
    return r.stdout.trim();
  }

  private async rules(repo: string, branch: string) {
    const rules = JSON.parse(
      await this.gh(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]),
    );
    if (!Array.isArray(rules) || rules.length) {
      throw new Error("Feature branch matches protection rules; refusing to push");
    }
  }

  async preflight(): Promise<NonNullable<Run["target"]>> {
    const startingBranch = this.git.git(["symbolic-ref", "--short", "HEAD"]);
    const startingHead = this.git.head();
    await this.gh(["auth", "status", "--hostname", "github.com"]);
    const remote = this.git.git(["remote", "get-url", "origin"]);
    const repo = githubRepo(remote);
    if (!repo) {
      throw new Error("v0.1 requires a github.com origin (HTTPS or git@github.com SSH)");
    }
    const info = JSON.parse(
      await this.gh([
        "repo",
        "view",
        repo,
        "--json",
        "nameWithOwner,defaultBranchRef,isArchived,viewerPermission",
      ]),
    );
    if (
      info.nameWithOwner.toLowerCase() !== repo.toLowerCase() ||
      info.isArchived ||
      !["WRITE", "MAINTAIN", "ADMIN"].includes(info.viewerPermission) ||
      !info.defaultBranchRef?.name
    ) {
      throw new Error("Repository is not writable or has no default branch");
    }
    const base = info.defaultBranchRef.name;
    const remoteHead = JSON.parse(
      await this.gh(["api", `repos/${repo}/branches/${encodeURIComponent(base)}`]),
    ).commit?.sha;
    if (typeof remoteHead !== "string" || !/^[0-9a-f]{40}$/i.test(remoteHead)) {
      throw new Error("GitHub default branch has no valid revision");
    }
    await this.rules(repo, "factory/preflight");
    if (
      this.git.head() !== startingHead ||
      this.git.git(["symbolic-ref", "--short", "HEAD"]) !== startingBranch
    ) {
      throw new Error("Starting branch or HEAD changed during GitHub preflight");
    }
    return { repo, base, remote, baseRevision: remoteHead };
  }

  async deliver(s: Run, _report: string, boundary: () => void): Promise<NonNullable<Run["pr"]>> {
    return this.publish(s, boundary, false, false);
  }

  async reconcile(
    s: Run,
    boundary: () => void,
    completed: boolean,
  ): Promise<NonNullable<Run["pr"]>> {
    return this.publish(s, boundary, true, completed);
  }

  private async publish(
    s: Run,
    boundary: () => void,
    reconcile: boolean,
    completed: boolean,
  ): Promise<NonNullable<Run["pr"]>> {
    const revision = s.revision;
    const target = s.target;
    const worktree = s.worktree;
    const plan = s.plans.at(-1);
    if (!revision || !target || !worktree || !plan) {
      throw new Error("Missing GitHub delivery state");
    }
    const verification = verificationText(s);
    this.git.unchanged(s, revision);
    if (
      this.git.git(["remote", "get-url", "origin"], worktree) !== target.remote ||
      githubRepo(target.remote)?.toLowerCase() !== target.repo.toLowerCase()
    ) {
      throw new Error("GitHub delivery target does not match origin");
    }
    if (!this.git.clean(worktree)) {
      throw new Error("Delivery worktree changed after final commit");
    }
    if (!/^factory\/[0-9a-f-]{36}$/.test(s.branch) || s.branch === target.base) {
      throw new Error("Refusing non-factory or protected target branch");
    }
    if (reconcile) {
      await this.gh(["auth", "status", "--hostname", "github.com"]);
      const info = JSON.parse(
        await this.gh([
          "repo",
          "view",
          target.repo,
          "--json",
          "nameWithOwner,defaultBranchRef,isArchived,viewerPermission",
        ]),
      );
      if (
        typeof info.nameWithOwner !== "string" ||
        info.nameWithOwner.toLowerCase() !== target.repo.toLowerCase() ||
        info.isArchived ||
        !info.defaultBranchRef?.name ||
        !["WRITE", "MAINTAIN", "ADMIN"].includes(info.viewerPermission)
      ) {
        throw new Error("Repository is not writable or target changed");
      }
      const base = JSON.parse(
        await this.gh(["api", `repos/${target.repo}/branches/${encodeURIComponent(target.base)}`]),
      );
      if (base.commit?.sha !== (target.baseRevision ?? s.baseRevision)) {
        throw new Error("Remote base moved since preflight");
      }
    }
    await this.rules(target.repo, s.branch);
    const existing = JSON.parse(
      await this.gh([
        "pr",
        "list",
        "--repo",
        target.repo,
        "--head",
        s.branch,
        "--state",
        "all",
        "--json",
        reconcile ? "url,state,isDraft,headRefOid,headRefName,baseRefName,headRepository" : "url",
      ]),
    );
    if (!Array.isArray(existing) || (!reconcile && existing.length) || existing.length > 1) {
      throw new Error("PR already exists; reconcile uncertain delivery manually");
    }
    let remote: Awaited<ReturnType<typeof execute>>;
    try {
      remote = await execute(
        "git",
        ["ls-remote", "--heads", target.remote, `refs/heads/${s.branch}`],
        worktree,
      );
    } catch {
      throw new Error(
        "Cannot inspect remote branch: git ls-remote could not start or was interrupted/timed out; details redacted",
      );
    }
    if (remote.code !== 0) {
      const detail = /authentication failed|permission denied|could not read username/i.test(
        remote.stderr,
      )
        ? "authentication or permission failure"
        : /could not resolve host|unable to access|connection (?:timed out|refused)|could not read from remote/i.test(
              remote.stderr,
            )
          ? "transport or remote access failure"
          : "details redacted";
      throw new Error(
        `Cannot inspect remote branch: git ls-remote exit ${remote.code}; stderr: ${detail}. Git authentication can differ from gh authentication`,
      );
    }
    const ref = remote.stdout.trim();
    if (ref && (!reconcile || ref !== `${revision}\trefs/heads/${s.branch}`)) {
      throw new Error("Remote factory branch already exists; reconcile rather than overwrite");
    }
    if (reconcile && existing.length) {
      const pr = existing[0];
      if (
        !ref ||
        pr.state !== "OPEN" ||
        typeof pr.isDraft !== "boolean" ||
        pr.headRefOid !== revision ||
        pr.headRefName !== s.branch ||
        pr.baseRefName !== target.base ||
        pr.headRepository?.nameWithOwner?.toLowerCase() !== target.repo.toLowerCase() ||
        typeof pr.url !== "string" ||
        !pr.url.startsWith(`https://github.com/${target.repo}/pull/`)
      ) {
        throw new Error("Existing PR does not match open delivery target and final revision");
      }
      boundary();
      return { url: pr.url, head: pr.headRefOid, draft: pr.isDraft };
    }
    if (completed || s.pr) {
      throw new Error("Saved delivery receipt no longer has a matching remote PR");
    }
    if (!ref) {
      boundary();
      const push = await execute(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "push",
          `--force-with-lease=refs/heads/${s.branch}:`,
          "--",
          target.remote,
          `${revision}:refs/heads/${s.branch}`,
        ],
        worktree,
      );
      if (push.code !== 0) {
        throw new Error("Push failed or uncertain: " + push.stderr);
      }
    }
    this.git.unchanged(s, revision);
    const body = join(this.artifacts, "pr-body.md");
    // Execution logs can contain credentials; never publish raw agent/command output.
    writeFileSync(
      body,
      `## Request\n${s.request}\n\n## Verification\n${verification}\n\nExecution report remains in local factory artifacts. Human review required; this is a draft.\n`,
      { mode: 0o600 },
    );
    boundary();
    const url = await this.gh([
      "pr",
      "create",
      "--repo",
      target.repo,
      "--base",
      target.base,
      "--head",
      s.branch,
      "--draft",
      "--title",
      this.git.git(["log", "-1", "--format=%s", revision], worktree),
      "--body-file",
      body,
    ]);
    const pr = JSON.parse(
      await this.gh([
        "pr",
        "view",
        url,
        "--repo",
        target.repo,
        "--json",
        "url,isDraft,headRefOid,headRefName,baseRefName",
      ]),
    );
    if (
      !pr.isDraft ||
      pr.headRefOid !== s.revision ||
      pr.headRefName !== s.branch ||
      pr.baseRefName !== target.base ||
      !pr.url.startsWith(`https://github.com/${target.repo}/pull/`)
    ) {
      throw new Error("Draft PR evidence does not match final revision");
    }
    return { url: pr.url, head: pr.headRefOid, draft: pr.isDraft };
  }
}
