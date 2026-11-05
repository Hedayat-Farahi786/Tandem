import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type ServerContext } from '../app.js';
import { auditOwner } from '../audit.js';
import { codeCommitRoleTemplate } from '@tandem/adapters';

const REGION = z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, 'Choose an AWS region.');
const plain = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Request \S+ failed with message:\s*/, '').split('\n')[0]!;

/**
 * Connections for repositories, made in the app: AWS for CodeCommit (IAM Identity Center sign-in in
 * the browser, an access key, or a profile on this computer), and pickers that list the
 * repositories each connection can reach. GitHub repositories use the GitHub account connected for
 * Copilot. No route returns a secret.
 */
export function registerConnectionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { tandem } = ctx;
  const { store } = tandem;
  const awsState = async () => ({ ...(await tandem.aws.state()), region: (await tandem.settings()).aws.region || 'eu-central-1' });

  app.get('/api/aws', async () => awsState());

  app.post('/api/aws/sso', async (req) => {
    const { startUrl, region } = z.object({ startUrl: z.string().trim().min(3, 'Paste your AWS access portal URL.').max(300), region: REGION }).parse(req.body);
    try {
      return await tandem.aws.ssoBegin(startUrl, region);
    } catch (err) {
      throw new HttpError(400, plain(err));
    }
  });
  app.post('/api/aws/sso/:flow/poll', async (req) => {
    const { flow } = z.object({ flow: z.string().uuid() }).parse(req.params);
    try {
      return await tandem.aws.ssoPoll(flow);
    } catch (err) {
      return { status: 'error', message: plain(err) };
    }
  });
  app.post('/api/aws/sso/:flow/choose', async (req) => {
    const { flow } = z.object({ flow: z.string().uuid() }).parse(req.params);
    const { accountId, role } = z.object({ accountId: z.string().regex(/^\d{12}$/), role: z.string().min(1).max(64) }).parse(req.body);
    try {
      const s = await tandem.aws.ssoChoose(flow, accountId, role);
      await auditOwner(store, { action: 'aws.connected', summary: `Connected AWS with IAM Identity Center (${s.label}).`, detail: { kind: 'sso' } });
      return { ...s, region: (await tandem.settings()).aws.region || 'eu-central-1' };
    } catch (err) {
      throw new HttpError(400, plain(err));
    }
  });
  app.delete('/api/aws/sso/:flow', async (req) => {
    const { flow } = z.object({ flow: z.string().uuid() }).parse(req.params);
    tandem.aws.ssoCancel(flow);
    return { ok: true };
  });

  app.post('/api/aws/keys', async (req) => {
    const { accessKeyId, secretAccessKey } = z.object({ accessKeyId: z.string().trim().min(16).max(128), secretAccessKey: z.string().trim().min(16).max(256) }).parse(req.body);
    try {
      const s = await tandem.aws.useKeys(accessKeyId, secretAccessKey, (await tandem.settings()).aws.region || 'eu-central-1');
      await auditOwner(store, { action: 'aws.connected', summary: `Connected AWS with an access key (${s.label}).`, detail: { kind: 'keys' } });
      return awsState();
    } catch (err) {
      throw new HttpError(400, plain(err));
    }
  });

  app.post('/api/aws/profile', async (req) => {
    const { profile } = z.object({ profile: z.string().trim().min(1).max(128) }).parse(req.body);
    try {
      await tandem.aws.useProfile(profile, (await tandem.settings()).aws.region || 'eu-central-1');
      await auditOwner(store, { action: 'aws.connected', summary: `Connected AWS with the profile ${profile}.`, detail: { kind: 'profile', profile } });
      return awsState();
    } catch (err) {
      throw new HttpError(400, plain(err));
    }
  });

  app.delete('/api/aws', async () => {
    await tandem.aws.disconnect();
    await auditOwner(store, { action: 'aws.disconnected', summary: 'Disconnected AWS.', detail: {} });
    return awsState();
  });

  /* ------------------------------------------------------------ a role in the customer's account */

  /**
   * The web app: what an owner needs to create a role for Tandem in their AWS account. The role
   * trusts Tandem's identity with this workspace's external ID, and may use CodeCommit only.
   */
  app.get('/api/aws/role', async () => {
    const setup = await tandem.aws.roleSetup();
    if (!setup.available) return setup;
    const region = (await tandem.settings()).aws.region || 'eu-central-1';
    const params = `TandemPrincipal=${setup.principal} ExternalId=${setup.externalId}`;
    const quick = ctx.hosted?.awsTemplateUrl;
    return {
      ...setup,
      region,
      template: '/api/aws/role/template',
      command: `aws cloudformation deploy --region ${region} --stack-name tandem-codecommit --template-file tandem-codecommit-role.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ${params}`,
      output: `aws cloudformation describe-stacks --region ${region} --stack-name tandem-codecommit --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
      ...(quick
        ? { quickCreateUrl: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?templateURL=${encodeURIComponent(quick)}&stackName=tandem-codecommit&param_TandemPrincipal=${encodeURIComponent(setup.principal)}&param_ExternalId=${encodeURIComponent(setup.externalId)}` }
        : {}),
    };
  });

  /** The role's CloudFormation template; with ?repositories=a,b only those repositories. */
  app.get('/api/aws/role/template', async (req, reply) => {
    const { repositories } = z.object({ repositories: z.string().max(2000).optional() }).parse(req.query);
    const names = repositories ? repositories.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    return reply
      .header('Content-Disposition', 'attachment; filename="tandem-codecommit-role.yaml"')
      .type('text/plain; charset=utf-8')
      .send(codeCommitRoleTemplate(names ? { repositories: names } : {}));
  });

  app.post('/api/aws/role', async (req) => {
    const { roleArn } = z.object({ roleArn: z.string().trim().min(20).max(600) }).parse(req.body);
    try {
      const s = await tandem.aws.useRole(roleArn, (await tandem.settings()).aws.region || 'eu-central-1');
      await auditOwner(store, { action: 'aws.connected', summary: `Connected AWS with a role (${s.label}).`, detail: { kind: 'role', roleArn } });
      return awsState();
    } catch (err) {
      throw new HttpError(400, plain(err));
    }
  });

  /** CodeCommit repositories in a region that the AWS connection can see. */
  app.get('/api/aws/repos', async (req) => {
    const { region } = z.object({ region: REGION }).parse(req.query);
    const added = new Set((await store.repos.list()).map((r) => r.url));
    try {
      const list = await tandem.codecommit.listRepositories(region);
      return list.map((r) => ({ ...r, added: added.has(r.url) }));
    } catch (err) {
      const msg = plain(err);
      throw new HttpError(400, /AccessDenied|not authorized/i.test(msg) ? `This AWS role can't list CodeCommit repositories in ${region}. Pick another region or role, or paste a clone URL.` : /expired|sign in/i.test(msg) ? 'Your AWS sign-in has expired. Connect AWS again.' : msg);
    }
  });

  /** GitHub repositories the connected GitHub account (the Copilot sign-in) can work in. */
  app.get('/api/github/repos', async (req) => {
    const { host } = z.object({ host: z.string().trim().max(200).default('github.com') }).parse(req.query);
    const added = new Set((await store.repos.list()).map((r) => r.url.replace(/\.git$/, '')));
    try {
      const list = await tandem.github.listRepositories(host);
      const installUrl = ctx.hosted?.githubInstallUrl;
      if (!list) return { connected: false, repos: [], ...(installUrl ? { installUrl } : {}) };
      return { connected: true, repos: list.map((r) => ({ ...r, added: added.has(r.url.replace(/\.git$/, '')) })), ...(installUrl ? { installUrl } : {}) };
    } catch (err) {
      throw new HttpError(400, plain(err));
    }
  });
}
