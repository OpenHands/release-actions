// publish.mjs against real Git repositories: a bare `origin` plus a fresh clone
// per run, as the workflow's checkout step leaves it. Only the pull request API
// is faked. Run: `npm test`.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parsePins} from './registry.mjs';
import {publish, renderBody, renderTitle} from './publish.mjs';

// publish() runs git with the process environment: keep the developer's own
// config (signing, hooks, default branch) out of it.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
});

const BRANCH = 'bump-pins';
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trimEnd();

// The caller's command: write the pin, then rebuild the lockfile from the manifest.
function bump(dir, version) {
  writeFileSync(join(dir, 'pyproject.toml'), `sdk==${version}\n`);
  const others = readFileSync(join(dir, 'uv.lock'), 'utf8').split('\n').filter(line => line && !line.startsWith('sdk '));
  writeFileSync(join(dir, 'uv.lock'), [`sdk ${version}`, ...others, ''].join('\n'));
}

function setUp(t) {
  const root = mkdtempSync(join(tmpdir(), 'bump-pins-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  let clones = 0;
  const clone = (ref = 'main') => {
    const dir = join(root, `clone-${clones++}`);
    git(root, 'clone', '--quiet', origin, dir);
    if (git(dir, 'branch', '--remotes').includes(`origin/${ref}`)) git(dir, 'checkout', '--quiet', ref);
    return dir;
  };
  // Commits `files` on `ref` and pushes, like a merge to main or a push to the PR branch.
  const commit = (ref, message, files) => {
    const dir = clone(ref);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', message);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${ref}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const head = ref => git(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`);
  const exists = ref => {
    try {
      return Boolean(head(ref));
    } catch {
      return false;
    }
  };
  const show = (ref, path) => git(origin, 'show', `refs/heads/${ref}:${path}`);

  // The pull request API: at most one open pull request for the branch.
  const calls = [];
  const api = {
    pr: undefined,
    find: async () => api.pr,
    create: async fields => {
      calls.push(`create: ${fields.title}`);
      return (api.pr = {number: 7, html_url: 'https://example.test/pull/7', ...fields});
    },
    update: async (pr, fields) => {
      calls.push(`update: ${fields.title}`);
      return (api.pr = {...pr, ...fields});
    },
  };

  // One workflow run: fresh checkout of main, the command, then publish().
  const run = async (version, {command = bump, ...options} = {}) => {
    const cwd = clone();
    command(cwd, version);
    return publish({cwd, branch: BRANCH, title: `fix: bump SDK to ${version}`, body: 'body', api, log() {}, ...options});
  };

  commit('main', 'chore: initial import', {'pyproject.toml': 'sdk==1.62.0\n', 'uv.lock': 'sdk 1.62.0\nhttpx 0.27.0\n', 'README.md': '# demo\n'});
  return {origin, commit, head, exists, show, api, calls, run};
}

test('opens a pull request from one commit on top of the base branch', async t => {
  const {origin, head, show, calls, run} = setUp(t);
  const result = await run('1.63.0');

  assert.deepEqual(result, {changed: true, url: 'https://example.test/pull/7'});
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0']);
  assert.equal(git(origin, 'rev-parse', `${BRANCH}~1`), head('main'));
  assert.equal(git(origin, 'log', '-1', '--format=%s|%an|%ae', BRANCH), 'fix: bump SDK to 1.63.0|github-actions[bot]|41898282+github-actions[bot]@users.noreply.github.com');
  assert.equal(git(origin, 'diff', '--name-only', 'main', BRANCH), 'pyproject.toml\nuv.lock');
  assert.equal(show(BRANCH, 'uv.lock'), 'sdk 1.63.0\nhttpx 0.27.0');
});

test('commits files the command created or deleted, and compares them on a rerun', async t => {
  const {origin, head, calls, run} = setUp(t);
  const command = (dir, version, constraint = version) => {
    bump(dir, version);
    writeFileSync(join(dir, 'constraints.txt'), `sdk==${constraint}\n`);
    rmSync(join(dir, 'README.md'));
  };
  await run('1.63.0', {command});
  assert.equal(git(origin, 'diff', '--name-status', 'main', BRANCH), 'D\tREADME.md\nA\tconstraints.txt\nM\tpyproject.toml\nM\tuv.lock');

  const pushed = head(BRANCH);
  await run('1.63.0', {command});
  assert.equal(head(BRANCH), pushed);
  await run('1.63.0', {command: (dir, version) => command(dir, version, '1.63.*')});
  assert.notEqual(head(BRANCH), pushed);
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0', 'update: fix: bump SDK to 1.63.0']);
});

test('a rerun with the same pins leaves the branch and the pull request alone', async t => {
  const {head, calls, run} = setUp(t);
  await run('1.63.0');
  const pushed = head(BRANCH);

  assert.deepEqual(await run('1.63.0'), {changed: true, url: 'https://example.test/pull/7'});
  assert.equal(head(BRANCH), pushed);
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0']);
});

test('commits pushed to the branch survive while the pins are unchanged', async t => {
  const {commit, head, show, calls, run} = setUp(t);
  await run('1.63.0');
  const fix = commit(BRANCH, 'fix: adapt a test to the new SDK', {'test_sdk.py': 'assert True\n'});
  commit('main', 'docs: unrelated', {'README.md': '# demo\n\nmore\n'});

  await run('1.63.0');
  assert.equal(head(BRANCH), fix);
  assert.equal(show(BRANCH, 'test_sdk.py'), 'assert True');
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0']);
});

test('a new release rebuilds the branch on the current base and retitles the pull request', async t => {
  const {origin, commit, head, exists, calls, run, api} = setUp(t);
  await run('1.63.0');
  commit(BRANCH, 'fix: adapt a test to the new SDK', {'test_sdk.py': 'assert True\n'});
  const main = commit('main', 'docs: unrelated', {'README.md': '# demo\n\nmore\n'});

  await run('1.64.0');
  assert.equal(git(origin, 'rev-parse', `${BRANCH}~1`), main);
  assert.equal(git(origin, 'rev-list', '--count', `main..${BRANCH}`), '1');
  assert.equal(git(origin, 'ls-tree', '--name-only', BRANCH).includes('test_sdk.py'), false);
  assert.equal(exists(BRANCH) && head(BRANCH) !== head('main'), true);
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0', 'update: fix: bump SDK to 1.64.0']);
  assert.equal(api.pr.title, 'fix: bump SDK to 1.64.0');
});

test('a lockfile change on the base branch rebuilds the branch, so it cannot conflict', async t => {
  const {origin, commit, show, calls, run} = setUp(t);
  await run('1.63.0');
  const main = commit('main', 'chore(deps): bump httpx', {'uv.lock': 'sdk 1.62.0\nhttpx 0.28.0\n'});

  await run('1.63.0');
  assert.equal(git(origin, 'rev-parse', `${BRANCH}~1`), main);
  assert.equal(show(BRANCH, 'uv.lock'), 'sdk 1.63.0\nhttpx 0.28.0');
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0', 'update: fix: bump SDK to 1.63.0']);
});

test('nothing is pushed when the base branch already has the pins', async t => {
  const {exists, calls, run} = setUp(t);
  assert.deepEqual(await run('1.62.0'), {changed: false});
  assert.equal(exists(BRANCH), false);
  assert.deepEqual(calls, []);
});

test('a leftover branch is deleted once the base branch has the pins', async t => {
  const {commit, exists, calls, run} = setUp(t);
  await run('1.63.0');
  // The bump reached main another way (merged by hand, or squash-merged without
  // deleting the branch).
  commit('main', 'fix: bump SDK to 1.63.0', {'pyproject.toml': 'sdk==1.63.0\n', 'uv.lock': 'sdk 1.63.0\nhttpx 0.27.0\n'});

  assert.deepEqual(await run('1.63.0'), {changed: false});
  assert.equal(exists(BRANCH), false);
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0']);
});

test('a closed pull request is reopened as a new one while the branch is current', async t => {
  const {head, calls, run, api} = setUp(t);
  await run('1.63.0');
  const pushed = head(BRANCH);
  api.pr = undefined;

  await run('1.63.0');
  assert.equal(head(BRANCH), pushed);
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0', 'create: fix: bump SDK to 1.63.0']);
});

test('a dry run pushes nothing and opens nothing', async t => {
  const {commit, head, exists, calls, run} = setUp(t);
  assert.deepEqual(await run('1.63.0', {dryRun: true}), {changed: true});
  assert.equal(exists(BRANCH), false);

  // Nor does it delete a leftover branch.
  await run('1.63.0');
  const pushed = head(BRANCH);
  commit('main', 'fix: bump SDK to 1.63.0', {'pyproject.toml': 'sdk==1.63.0\n', 'uv.lock': 'sdk 1.63.0\nhttpx 0.27.0\n'});
  assert.deepEqual(await run('1.63.0', {dryRun: true}), {changed: false});
  assert.equal(head(BRANCH), pushed);
  assert.deepEqual(calls, ['create: fix: bump SDK to 1.63.0']);
});

test('renderTitle fills in pin versions and rejects unknown placeholders', () => {
  const versions = {SDK: '1.63.0', AUTOMATION: '1.33.0'};
  assert.equal(renderTitle('fix: bump SDK to {SDK}', versions), 'fix: bump SDK to 1.63.0');
  assert.equal(renderTitle('chore: bump agent-server to {SDK}, automation to {AUTOMATION}', versions), 'chore: bump agent-server to 1.63.0, automation to 1.33.0');
  assert.equal(renderTitle('chore: bump pins', versions), 'chore: bump pins');
  assert.throws(() => renderTitle('fix: bump to {VERSION}', versions), /\{VERSION\} is not a declared pin/);
});

test('renderBody lists every pin with its package and version', () => {
  const pins = parsePins('AUTOMATION=pypi:openhands-automation\nEXTENSIONS=npm:@openhands/extensions');
  const body = renderBody(pins, {AUTOMATION: '1.33.0', EXTENSIONS: '0.42.1'});
  assert.match(body, /\| `AUTOMATION` \| `pypi:openhands-automation` \| `1\.33\.0` \|/);
  assert.match(body, /\| `EXTENSIONS` \| `npm:@openhands\/extensions` \| `0\.42\.1` \|/);
});
