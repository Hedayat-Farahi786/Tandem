/**
 * Spike c: CodeCommit pull requests through the AWS SDK with the user's AWS profile,
 * and the console-link fallback when the profile can't create PRs.
 *
 *   TANDEM_SPIKE_REPO_URL=codecommit::<region>://<name>  (or ssh://git-codecommit.<region>.amazonaws.com/v1/repos/<name>) \
 *   TANDEM_SPIKE_AWS_PROFILE=<profile> pnpm spike:c
 *
 * Without a profile (or without permission) only the fallback is exercised. The PR created here
 * is closed and its branch deleted at the end.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CodeCommitClient,
  CreatePullRequestCommand,
  GetPullRequestCommand,
  GetRepositoryCommand,
  ListPullRequestsCommand,
  UpdatePullRequestDescriptionCommand,
  UpdatePullRequestStatusCommand,
} from '@aws-sdk/client-codecommit';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { shortId, spikeEnv, workDir } from './lib/env.js';
import { assertAgentBranch, bareClone, addWorktree, commitAll, deleteRemoteBranch, git, parseCodeCommitUrl, pushBranch, removeWorktree, remoteDefaultBranch, resolveRemote } from './lib/git.js';
import { Report, check } from './lib/report.js';

const env = spikeEnv();
const report = new Report('c-codecommit-pr', 'Spike c: CodeCommit pull requests (AWS SDK and console-link fallback)');
const work = await workDir('spike-c');
const id = shortId();
const branch = `agent/spike-${id}-pr`;

/** Console link for creating a PR with branches preselected. Format confirmed manually in this spike. */
export function consoleCreatePrLink(region: string, repo: string, destination: string, source: string): string {
  const enc = (s: string) => encodeURIComponent(s);
  return `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${enc(repo)}/pull-requests/new/refs/heads/${destination.split('/').map(enc).join('/')}/.../refs/heads/${source.split('/').map(enc).join('/')}?region=${region}`;
}
export function consoleRepoPrListLink(region: string, repo: string): string {
  return `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(repo)}/pull-requests?region=${region}`;
}

function errName(err: unknown): string {
  return (err as { name?: string })?.name ?? 'Error';
}

let mirror = '';
let wt = '';
let branchPushed = false;
let prId: string | undefined;
let cc: CodeCommitClient | undefined;

try {
  const parsed = env.repoUrl ? parseCodeCommitUrl(env.repoUrl) : undefined;
  if (!env.repoUrl || !parsed) {
    report.skip('All steps', 'Set TANDEM_SPIKE_REPO_URL to the SSH URL of a CodeCommit sandbox repo.');
  } else {
    const region = env.awsRegion ?? parsed.region;
    const gitUrl = resolveRemote(env.repoUrl, env.awsProfile).gitUrl;
    const repoName = parsed.name;
    report.fact('region', region);
    report.fact('repo', repoName);

    const defaultBranch = await report.step('Default branch over git', async (ctx) => {
      const b = await remoteDefaultBranch(gitUrl);
      check(b, 'Repo has no default branch. Seed it first: pnpm spike:seed -- backend <url>');
      return b;
    });

    // A branch with one commit, so a PR (or the console page) has something to show.
    if (defaultBranch) {
      await report.step(`Push a branch ${branch} with one commit`, async (ctx) => {
        mirror = join(work.path, 'mirror.git');
        await bareClone(gitUrl, mirror);
        wt = join(work.path, 'wt');
        await addWorktree(mirror, wt, branch, `origin/${defaultBranch}`);
        await writeFile(join(wt, `spike-pr-${id}.md`), `PR spike ${id}\n`);
        await commitAll(wt, `test: PR spike ${id}`);
        const r = await pushBranch(wt, branch);
        check(r.code === 0, `push failed: ${r.stderr.trim()}`);
        branchPushed = true;
      });
    }

    // The profile named in a codecommit:: URL wins, then TANDEM_SPIKE_AWS_PROFILE, then the default chain.
    const profile = parsed.profile ?? env.awsProfile;
    const credentials = profile ? fromIni({ profile }) : fromNodeProviderChain();
    report.fact('aws.profile', profile ?? '(default credential chain)');

    const identityOk = await report.step('AWS credentials resolve (STS GetCallerIdentity)', async (ctx) => {
      const sts = new STSClient({ region, credentials });
      let who;
      try {
        who = await sts.send(new GetCallerIdentityCommand({}));
      } catch (err) {
        const name = errName(err);
        throw new Error(
          /InvalidClientTokenId|ExpiredToken|CredentialsProviderError|ValidationException|TokenProviderError/.test(name) || /expired|invalid|locate credentials/i.test(String(err))
            ? `AWS credentials for ${profile ?? 'the default profile'} are missing or expired (${name}). Sign in again (for example \`aws login${profile ? ` --profile ${profile}` : ''}\`) and re-run.`
            : String(err),
        );
      }
      const account = who.Account ?? '';
      // The assumed-role session name is usually the person's work identity: never record it.
      const kind = /:assumed-role\//.test(who.Arn ?? '') ? 'assumed role (SSO or login session)' : /:user\//.test(who.Arn ?? '') ? 'IAM user' : 'other';
      ctx.detail(`account ****${account.slice(-4)}, ${kind}`);
      return true;
    });

    let canCreate = false;
    if (identityOk && defaultBranch) {
      cc = new CodeCommitClient({ region, credentials });
      await report.step('GetRepository', async (ctx) => {
        const r = await cc!.send(new GetRepositoryCommand({ repositoryName: repoName }));
        ctx.detail(`default branch per API: ${r.repositoryMetadata?.defaultBranch}`);
        check(r.repositoryMetadata?.defaultBranch === defaultBranch, `API default branch ${r.repositoryMetadata?.defaultBranch} differs from SSH HEAD ${defaultBranch}`);
      });

      await report.step('Permission probe: CreatePullRequest with a non-existent source ref (creates nothing)', async (ctx) => {
        try {
          await cc!.send(
            new CreatePullRequestCommand({
              title: 'Tandem permission probe',
              targets: [{ repositoryName: repoName, sourceReference: `refs/heads/tandem-probe-${id}-does-not-exist`, destinationReference: `refs/heads/${defaultBranch}` }],
            }),
          );
          throw new Error('Probe unexpectedly created a pull request');
        } catch (err) {
          const name = errName(err);
          ctx.detail(`probe result: ${name}`);
          ctx.fact('probe.errorName', name);
          if (name === 'ReferenceDoesNotExistException') canCreate = true;
          else if (name === 'AccessDeniedException') canCreate = false;
          else throw err;
        }
        ctx.fact('canCreatePullRequest', canCreate);
      });

      await report.step('Permission: ListPullRequests / GetPullRequest (needed for status polling)', async (ctx) => {
        try {
          const r = await cc!.send(new ListPullRequestsCommand({ repositoryName: repoName, maxResults: 1 }));
          ctx.detail(`ListPullRequests ok (${r.pullRequestIds?.length ?? 0} returned)`);
          ctx.fact('canListPullRequests', true);
        } catch (err) {
          ctx.fact('canListPullRequests', false);
          ctx.detail(`ListPullRequests: ${errName(err)}`);
        }
      });
    } else {
      report.skip('AWS API steps', 'No usable AWS credentials; only the console-link fallback is checked.');
    }

    if (canCreate && cc && defaultBranch && branchPushed) {
      const token = randomUUID();
      const input = {
        title: `Tandem spike ${id}`,
        description: `Created by Tandem spike c (${id}). Safe to close.`,
        targets: [{ repositoryName: repoName, sourceReference: `refs/heads/${branch}`, destinationReference: `refs/heads/${defaultBranch}` }],
        clientRequestToken: token,
      };
      await report.step('CreatePullRequest with clientRequestToken', async (ctx) => {
        const r = await cc!.send(new CreatePullRequestCommand(input));
        prId = r.pullRequest?.pullRequestId;
        check(prId, 'no pull request id returned');
        ctx.detail(`pull request ${prId} (${r.pullRequest?.pullRequestStatus})`);
        ctx.detail(`console: https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repoName}/pull-requests/${prId}/details?region=${region}`);
      });

      await report.step('Retry with the same token returns the same PR (no duplicate after a restart)', async (ctx) => {
        const r = await cc!.send(new CreatePullRequestCommand(input));
        check(r.pullRequest?.pullRequestId === prId, `retry returned ${r.pullRequest?.pullRequestId}, expected ${prId}`);
        ctx.fact('idempotentCreate', true);
      });

      await report.step('GetPullRequest reports status and merge state', async (ctx) => {
        const r = await cc!.send(new GetPullRequestCommand({ pullRequestId: prId! }));
        const t = r.pullRequest?.pullRequestTargets?.[0];
        check(r.pullRequest?.pullRequestStatus === 'OPEN', `status ${r.pullRequest?.pullRequestStatus}`);
        ctx.detail(`status ${r.pullRequest?.pullRequestStatus}, merged ${t?.mergeMetadata?.isMerged}, source ${t?.sourceCommit?.slice(0, 10)}`);
      });

      await report.step('UpdatePullRequestDescription (used to cross-link PRs)', async (ctx) => {
        const description = `Updated by spike ${id}.\n\n| Criterion | Test | Result |\n| --- | --- | --- |\n| 1 | test/app.test.ts | pass |`;
        await cc!.send(new UpdatePullRequestDescriptionCommand({ pullRequestId: prId!, description }));
        const r = await cc!.send(new GetPullRequestCommand({ pullRequestId: prId! }));
        check(r.pullRequest?.description === description, 'description not updated');
      });

      await report.step('Description length limit', async (ctx) => {
        const ok = 'x'.repeat(10_240);
        await cc!.send(new UpdatePullRequestDescriptionCommand({ pullRequestId: prId!, description: ok }));
        ctx.detail('10,240 characters accepted');
        try {
          await cc!.send(new UpdatePullRequestDescriptionCommand({ pullRequestId: prId!, description: ok + 'x' }));
          ctx.fact('description.maxLength', '> 10240 (longer accepted)');
        } catch (err) {
          ctx.detail(`10,241 characters rejected: ${errName(err)}`);
          ctx.fact('description.maxLength', 10_240);
        }
      });

      await report.step('Close the PR (UpdatePullRequestStatus CLOSED)', async (ctx) => {
        await cc!.send(new UpdatePullRequestStatusCommand({ pullRequestId: prId!, pullRequestStatus: 'CLOSED' }));
        const r = await cc!.send(new GetPullRequestCommand({ pullRequestId: prId! }));
        check(r.pullRequest?.pullRequestStatus === 'CLOSED', `status ${r.pullRequest?.pullRequestStatus}`);
        prId = undefined;
      });
    }

    if (defaultBranch && branchPushed) {
      await report.step('Console-link fallback: link opens the prefilled "Create pull request" page', async (ctx) => {
        const link = consoleCreatePrLink(region, repoName, defaultBranch, branch);
        ctx.detail(`prefilled link: ${link}`);
        ctx.detail(`fallback link (PR list): ${consoleRepoPrListLink(region, repoName)}`);
        ctx.fact('console.prefilledLink.format', 'https://{region}.console.aws.amazon.com/codesuite/codecommit/repositories/{repo}/pull-requests/new/refs/heads/{dest}/.../refs/heads/{source}?region={region}');
        if (!process.stdin.isTTY) {
          ctx.fact('console.prefilledLink.confirmed', 'not checked (no terminal); open the link above and confirm');
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\nOpen this link while signed in to the AWS console:\n\n  ${link}\n`);
        const answer = (await rl.question(`Does it open "Create pull request" with destination ${defaultBranch} and source ${branch} selected? [y/n] `)).trim().toLowerCase();
        rl.close();
        ctx.fact('console.prefilledLink.confirmed', answer.startsWith('y'));
        check(answer.startsWith('y'), 'Prefilled console link did not work; Tandem will fall back to the PR list link with branch names to select.');
      });
    }
  }
} finally {
  if (prId && cc) {
    try {
      await cc.send(new UpdatePullRequestStatusCommand({ pullRequestId: prId, pullRequestStatus: 'CLOSED' }));
    } catch {
      // reported below
    }
  }
  if (branchPushed && mirror) {
    await report.step('Cleanup: delete spike branch, remove worktree', async () => {
      await deleteRemoteBranch({ gitDir: mirror }, assertAgentBranch(branch));
      if (wt) await removeWorktree(mirror, wt);
    });
  }
  await work.cleanup();
  await report.finish({ git: (await git(['--version'])).replace('git version ', '') });
}
