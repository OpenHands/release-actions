// Entry point for the pr-artifacts composite action (see action.yml).
//   MODE=review     publish the `pr-artifacts` status; strip `.pr` from approved PRs
//   MODE=fast-path  write skip=true|false to GITHUB_OUTPUT for a consumer's CI

import {appendFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {authEnv, createApi, fastPath, pullNumbers, reviewPull, stripPrEntry} from './pr-artifacts.mjs';

const env = process.env;
const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
const api = createApi({token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL || 'https://api.github.com'});
const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
const output = (key, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);

async function review() {
  const identity = {name: env.COMMITTER_NAME, email: env.COMMITTER_EMAIL};
  const strip = pull => {
    if (!env.PUSH_TOKEN) return {pushed: false, reason: 'no push-token was passed'};
    const remoteUrl = pull.head.repo.clone_url;
    if (!remoteUrl.startsWith(`${serverUrl}/`)) return {pushed: false, reason: `unexpected clone URL ${remoteUrl}`};
    const dir = mkdtempSync(join(tmpdir(), 'pr-artifacts-'));
    try {
      return stripPrEntry({
        dir,
        remoteUrl,
        ref: pull.head.ref,
        expectedSha: pull.head.sha,
        env: authEnv(env.PUSH_TOKEN, serverUrl),
        identity,
        message: 'chore: remove PR-only artifacts\n\nRemoves the root .pr/ review evidence before merge.',
      });
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  };

  const numbers = await pullNumbers({
    api, owner, repo, eventName: env.GITHUB_EVENT_NAME, event, pullNumber: env.PULL_NUMBER,
  });
  console.info(`Pull requests to review: ${numbers.length ? numbers.join(', ') : 'none'}`);
  let failed = 0;
  for (const number of numbers) {
    try {
      const result = await reviewPull({
        api, owner, repo, number, strip,
        requireApproval: env.REQUIRE_APPROVAL !== 'false',
        context: env.STATUS_CONTEXT,
        targetUrl: env.STATUS_TARGET_URL,
      });
      console.info(`#${number}: ${result.action}`);
    } catch (error) {
      // One bad PR must not stop the sweep over the others.
      failed++;
      console.error(`::error::#${number}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function fast() {
  const headSha = env.HEAD_SHA || event.pull_request?.head?.sha;
  if (!headSha) {
    console.info('No pull request head SHA; not skipping.');
    output('skip', 'false');
    return;
  }
  if (!env.CHECK_NAME) throw new Error('fast-path needs check-name.');
  // Any doubt (API error, odd history) means running the full suite.
  let result;
  try {
    result = await fastPath({api, owner, repo, headSha, checkName: env.CHECK_NAME});
  } catch (error) {
    result = {skip: false, reason: `could not decide (${error.message})`};
  }
  console.info(`${result.skip ? 'Skipping' : 'Running'}: ${result.reason}`);
  output('skip', String(result.skip));
}

const modes = {review, 'fast-path': fast};
if (!modes[env.MODE]) throw new Error(`Unknown MODE "${env.MODE}" (expected review or fast-path).`);
await modes[env.MODE]();
