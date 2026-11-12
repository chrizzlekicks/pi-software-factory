import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Git, execute } from './git.ts';
import type { Run } from './state.ts';

export class GitHubDelivery {
  git: Git; artifacts: string;
  constructor(git: Git, artifacts: string) { this.git = git; this.artifacts = artifacts; }
  private async gh(args: string[]) {
    const r = await execute('gh', args, this.git.repo);
    if (r.code !== 0) throw new Error(`GitHub CLI failed (${args.slice(0, 2).join(' ')}): ${r.stderr}`);
    return r.stdout.trim();
  }
  private async rules(repo: string, branch: string) {
    const rules = JSON.parse(await this.gh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]));
    if (!Array.isArray(rules) || rules.length) throw new Error('Feature branch matches protection rules; refusing to push');
  }
  async preflight(): Promise<Run['target']> {
    await this.gh(['auth', 'status', '--hostname', 'github.com']);
    const remote = this.git.git(['remote', 'get-url', 'origin']);
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
    if (!match) throw new Error('v0.1 requires a github.com origin (HTTPS or git@github.com SSH)');
    const repo = match[1];
    const info = JSON.parse(await this.gh(['repo','view', repo, '--json','nameWithOwner,defaultBranchRef,isArchived,viewerPermission']));
    if (info.nameWithOwner.toLowerCase() !== repo.toLowerCase() || info.isArchived || !['WRITE','MAINTAIN','ADMIN'].includes(info.viewerPermission) || !info.defaultBranchRef?.name) throw new Error('Repository is not writable or has no default branch');
    const base = info.defaultBranchRef.name;
    const remoteHead = JSON.parse(await this.gh(['api', `repos/${repo}/branches/${encodeURIComponent(base)}`])).commit?.sha;
    if (remoteHead !== this.git.head()) throw new Error('Start at the GitHub default-branch revision; local HEAD differs');
    await this.rules(repo, 'factory/preflight');
    return { repo, base, remote };
  }
  async deliver(s: Run, _report: string, boundary: () => void): Promise<NonNullable<Run['pr']>> {
    this.git.unchanged(s, s.revision!);
    if (!/^factory\/[0-9a-f-]{36}$/.test(s.branch) || s.branch === s.target.base) throw new Error('Refusing non-factory or protected target branch');
    await this.rules(s.target.repo, s.branch);
    const existing = JSON.parse(await this.gh(['pr', 'list', '--repo', s.target.repo, '--head', s.branch, '--state', 'all', '--json', 'url']));
    if (!Array.isArray(existing) || existing.length) throw new Error('PR already exists; reconcile uncertain delivery manually');
    const remote = await execute('git', ['ls-remote', '--heads', s.target.remote, `refs/heads/${s.branch}`], s.worktree!);
    if (remote.code !== 0) throw new Error('Cannot inspect remote branch');
    if (remote.stdout.trim()) throw new Error('Remote factory branch already exists; reconcile rather than overwrite');
    boundary();
    const push = await execute('git', ['-c', 'core.hooksPath=/dev/null', 'push', `--force-with-lease=refs/heads/${s.branch}:`, '--', s.target.remote, `${s.revision}:refs/heads/${s.branch}`], s.worktree!);
    if (push.code !== 0) throw new Error('Push failed or uncertain: ' + push.stderr);
    this.git.unchanged(s, s.revision!);
    const body = join(this.artifacts, 'pr-body.md');
    // Execution logs can contain credentials; never publish raw agent/command output.
    writeFileSync(body, `## Request\n${s.request}\n\n## Verification\nApproved plan revision ${s.approvedRevision}; final revision ${s.revision}. Independent tests, quality/security/Ponytail reviews and documentation audit completed. Repair cycles: ${s.repairs}/2.\n\nExecution report remains in local factory artifacts. Human review required; this is a draft.\n`, { mode: 0o600 });
    boundary();
    const url = await this.gh(['pr','create','--repo',s.target.repo,'--base',s.target.base,'--head',s.branch,'--draft','--title',s.plans.at(-1)!.summary.slice(0, 200),'--body-file',body]);
    const pr = JSON.parse(await this.gh(['pr','view',url,'--repo',s.target.repo,'--json','url,isDraft,headRefOid,headRefName,baseRefName']));
    if (!pr.isDraft || pr.headRefOid !== s.revision || pr.headRefName !== s.branch || pr.baseRefName !== s.target.base || !pr.url.startsWith(`https://github.com/${s.target.repo}/pull/`)) throw new Error('Draft PR evidence does not match final revision');
    return { url: pr.url, head: pr.headRefOid, draft: pr.isDraft };
  }
}
