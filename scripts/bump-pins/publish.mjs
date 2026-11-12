// Step 3 of bump-pins: turn whatever the caller's command changed in the
// checkout into one commit on a rolling branch, and keep one pull request open
// for it.
//
// The branch is rebuilt (base + one commit, force-pushed) only when the files
// the command changed differ from what the branch already holds. So a rerun with
// the same pins leaves the branch alone, and commits pushed to it meanwhile (a
// fix for a test the bump broke, a merge of the base branch) survive until the
// pins or the lockfile next change.

import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parsePins} from './registry.mjs';

const BOT = {name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com'};
const AUTHOR = {GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email};

export function renderTitle(template, versions) {
  return template.replace(/\{([^{}]*)\}/g, (placeholder, name) => {
    if (!(name in versions)) throw new Error(`Title placeholder ${placeholder} is not a declared pin`);
    return versions[name];
  });
}

export function renderBody(pins, versions) {
  return [
    'Automated pin bump to the latest published releases.',
    '',
    '| Pin | Package | Version |',
    '| --- | --- | --- |',
    ...pins.map(pin => `| \`${pin.name}\` | \`${pin.registry}:${pin.pkg}\` | \`${versions[pin.name]}\` |`),
    '',
    'Opened by the [`bump-pins`](https://github.com/OpenHands/release-actions#bumping-pins-on-upstream-releases) workflow. It rebuilds this branch when the pins change, which drops commits pushed here in the meantime.',
  ].join('\n');
}

// `remoteEnv` authenticates the Git commands that talk to the remote; `api`
// is {find(), create({title, body}), update(pr, {title, body})}.
export async function publish({cwd, branch, title, body, api, remoteEnv = {}, dryRun = false, log = console.log}) {
  const run = (args, env) => execFileSync('git', args, {cwd, env: {...process.env, ...env}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const git = (...args) => run(args).trimEnd();
  const remote = (...args) => run(args, remoteEnv).trimEnd();
  const ref = `refs/heads/${branch}`;

  git('add', '--all');
  const paths = git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  const pushed = Boolean(remote('ls-remote', 'origin', ref));

  if (!paths.length) {
    // The base branch already has these pins, so a leftover branch (and the pull
    // request on it) has nothing left to add.
    log('The pins are up to date; nothing to commit.');
    if (pushed && !dryRun) {
      remote('push', '--quiet', 'origin', `:${ref}`);
      log(`Deleted the leftover ${branch} branch.`);
    }
    return {changed: false};
  }

  git('checkout', '--quiet', '-B', branch);
  run(['commit', '--quiet', '--no-verify', '--message', title], AUTHOR);
  log(git('show', '--stat', '--format=%s', 'HEAD'));

  let current = false;
  if (pushed) {
    remote('fetch', '--quiet', '--depth=1', 'origin', `+${ref}:refs/remotes/origin/${branch}`);
    try {
      git('diff', '--quiet', `origin/${branch}`, 'HEAD', '--', ...paths);
      current = true;
    } catch {
      // The branch holds other pins, or a lockfile built on an older base.
    }
  }
  if (dryRun) {
    log(`Dry run: would ${current ? 'leave' : pushed ? 'rebuild' : 'create'} ${branch} and ${current ? 'keep' : 'open or update'} its pull request.`);
    return {changed: true};
  }

  if (!current) remote('push', '--quiet', '--force', 'origin', `HEAD:${ref}`);
  let pr = await api.find();
  if (!pr) pr = await api.create({title, body});
  else if (!current || pr.title !== title) pr = await api.update(pr, {title, body});
  log(`${current ? 'Already up to date' : 'Pushed'}: ${pr.html_url}`);
  return {changed: true, url: pr.html_url};
}

export function githubApi({token, repository, branch, base, request = fetch}) {
  const call = async (method, path, payload) => {
    const response = await request(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28'},
      body: payload && JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  const head = `${repository.split('/')[0]}:${branch}`;
  return {
    find: async () => (await call('GET', `/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`))[0],
    create: fields => call('POST', '/pulls', {...fields, head: branch, base}),
    update: (pr, fields) => call('PATCH', `/pulls/${pr.number}`, fields),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, BUMP_BRANCH: branch, BUMP_BASE: base} = process.env;
  const pins = parsePins(process.env.BUMP_PINS ?? '');
  const versions = JSON.parse(process.env.BUMP_VERSIONS);
  const result = await publish({
    cwd: process.cwd(),
    branch,
    title: renderTitle(process.env.BUMP_TITLE, versions),
    body: renderBody(pins, versions),
    api: githubApi({token, repository, branch, base}),
    // In the environment, not in argv or the Git config: the checkout keeps no
    // credentials, so the caller's command never sees the token.
    remoteEnv: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
    dryRun: process.env.BUMP_DRY_RUN === 'true',
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\npull-request-url=${result.url ?? ''}\n`);
  }
}
