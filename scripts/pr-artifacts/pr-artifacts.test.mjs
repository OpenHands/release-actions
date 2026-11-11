import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, test} from 'node:test';
import {
  authEnv, canPush, fastPath, guardStatus, ownPrPaths, pullNumbers, reviewPull, stripPrEntry,
} from './pr-artifacts.mjs';

const scratch = [];
after(() => scratch.forEach(dir => rmSync(dir, {recursive: true, force: true})));
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-artifacts-test-'));
  scratch.push(dir);
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
const git = (cwd, args, input) =>
  execFileSync('git', args, {cwd, env: GIT_ENV, input, stdio: ['pipe', 'pipe', 'pipe']}).toString().trim();

const identity = {name: 'bot', email: 'bot@example.com'};
const message = 'chore: remove PR-only artifacts';

// A bare "GitHub" remote holding branch `feature`, built from a work tree
// populated by `populate(dir)`; `stage(dir)` runs after `git add -A`, for index
// entries with no file behind them (gitlinks). Returns {remoteUrl, sha, work}.
function remoteWith(populate, stage = () => {}) {
  const work = tempDir();
  git(work, ['init', '--quiet', '-b', 'feature']);
  populate(work);
  git(work, ['add', '-A']);
  stage(work);
  git(work, ['commit', '--quiet', '-m', 'feature']);
  const bare = tempDir();
  git(bare, ['init', '--quiet', '--bare']);
  git(work, ['push', '--quiet', bare, 'feature']);
  return {remoteUrl: `file://${bare}`, bare, sha: git(work, ['rev-parse', 'HEAD']), work};
}

const writeFiles = (dir, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), {recursive: true});
    writeFileSync(join(dir, path), content);
  }
};
const tipTree = bare => git(bare, ['ls-tree', '-r', '--name-only', 'feature']).split('\n').filter(Boolean);

describe('ownPrPaths', () => {
  test('counts added, modified and renamed-in root .pr paths only', () => {
    const files = [
      {filename: '.pr/after.png', status: 'added'},
      {filename: '.pr/notes.md', status: 'modified'},
      {filename: '.pr/moved.md', status: 'renamed'},
      {filename: '.pr', status: 'added'},
      {filename: '.pr/old.md', status: 'removed'},
      {filename: '.pr-other/x.md', status: 'added'},
      {filename: 'docs/.pr/x.md', status: 'added'},
      {filename: 'src/app.ts', status: 'modified'},
    ];
    assert.deepEqual(ownPrPaths(files), ['.pr/after.png', '.pr/notes.md', '.pr/moved.md', '.pr']);
  });
});

const pullFrom = ({fork = false, maintainerCanModify = false, deletedFork = false} = {}) => ({
  base: {repo: {full_name: 'acme/app'}},
  head: {repo: deletedFork ? null : {full_name: fork ? 'someone/app' : 'acme/app'}},
  maintainer_can_modify: maintainerCanModify,
});

describe('guardStatus', () => {
  test('success when the PR adds no .pr files', () => {
    assert.equal(guardStatus({pull: pullFrom(), ownPaths: []}).state, 'success');
  });
  test('pending for same-repo PRs and forks that allow maintainer edits', () => {
    assert.equal(guardStatus({pull: pullFrom(), ownPaths: ['.pr/a.png']}).state, 'pending');
    assert.equal(guardStatus({pull: pullFrom({fork: true, maintainerCanModify: true}), ownPaths: ['.pr/a']}).state, 'pending');
  });
  test('failure for forks the bot cannot push to, with a fix in the message', () => {
    for (const pull of [pullFrom({fork: true}), pullFrom({deletedFork: true})]) {
      const status = guardStatus({pull, ownPaths: ['.pr/a.png']});
      assert.equal(status.state, 'failure');
      assert.match(status.description, /Allow edits by maintainers/);
    }
  });
  test('descriptions fit the 140-character status limit', () => {
    for (const pull of [pullFrom(), pullFrom({fork: true})]) {
      const many = Array.from({length: 12345}, (_, i) => `.pr/${i}.png`);
      assert.ok(guardStatus({pull, ownPaths: many}).description.length <= 140);
    }
  });
  test('canPush mirrors the guard', () => {
    assert.equal(canPush(pullFrom()), true);
    assert.equal(canPush(pullFrom({fork: true, maintainerCanModify: true})), true);
    assert.equal(canPush(pullFrom({fork: true})), false);
    assert.equal(canPush(pullFrom({deletedFork: true})), false);
  });
});

describe('stripPrEntry (real Git)', () => {
  test('pushes one commit that drops the root .pr directory and nothing else', () => {
    const {remoteUrl, bare, sha} = remoteWith(dir => writeFiles(dir, {
      'src/app.ts': 'app\n',
      '.pr/after.png': 'png',
      '.pr/topic/notes.md': 'notes\n',
      '.pr-other/keep.md': 'keep\n',
      'docs/.pr/keep.md': 'keep\n',
    }));
    const result = stripPrEntry({dir: tempDir(), remoteUrl, ref: 'feature', expectedSha: sha, identity, message});
    assert.equal(result.pushed, true);
    assert.deepEqual(tipTree(bare), ['.pr-other/keep.md', 'docs/.pr/keep.md', 'src/app.ts']);
    assert.equal(git(bare, ['rev-parse', 'feature^']), sha, 'the removal commit sits on the old head');
    assert.equal(git(bare, ['log', '-1', '--format=%an <%ae>|%s', 'feature']), 'bot <bot@example.com>|' + message);
    // Every other path keeps its exact blob.
    assert.equal(git(bare, ['rev-parse', 'feature:src/app.ts']), git(bare, [`rev-parse`, `${sha}:src/app.ts`]));
  });

  test('drops a root .pr file or symlink too', () => {
    const asFile = remoteWith(dir => writeFiles(dir, {'.pr': 'file\n', 'a.txt': 'a\n'}));
    assert.equal(stripPrEntry({dir: tempDir(), remoteUrl: asFile.remoteUrl, ref: 'feature', expectedSha: asFile.sha, identity, message}).pushed, true);
    assert.deepEqual(tipTree(asFile.bare), ['a.txt']);

    const asLink = remoteWith(dir => {
      writeFiles(dir, {'a.txt': 'a\n'});
      symlinkSync('a.txt', join(dir, '.pr'));
    });
    assert.equal(stripPrEntry({dir: tempDir(), remoteUrl: asLink.remoteUrl, ref: 'feature', expectedSha: asLink.sha, identity, message}).pushed, true);
    assert.deepEqual(tipTree(asLink.bare), ['a.txt']);
  });

  test('keeps submodule entries it never fetched', () => {
    const {remoteUrl, bare, sha} = remoteWith(
      dir => writeFiles(dir, {'.pr/a.png': 'png', 'a.txt': 'a\n'}),
      dir => git(dir, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},lib`]),
    );
    assert.equal(stripPrEntry({dir: tempDir(), remoteUrl, ref: 'feature', expectedSha: sha, identity, message}).pushed, true);
    assert.equal(git(bare, ['ls-tree', 'feature', 'lib']).split(/\s/)[0], '160000');
    assert.equal(git(bare, ['ls-tree', 'feature', '.pr']), '');
  });

  test('does nothing when there is no root .pr entry', () => {
    const {remoteUrl, bare, sha} = remoteWith(dir => writeFiles(dir, {'docs/.pr/x.md': 'x\n'}));
    const result = stripPrEntry({dir: tempDir(), remoteUrl, ref: 'feature', expectedSha: sha, identity, message});
    assert.deepEqual([result.pushed, result.reason], [false, 'no root .pr entry']);
    assert.equal(git(bare, ['rev-parse', 'feature']), sha);
  });

  test('never pushes over a branch that moved since the PR was read', () => {
    const {remoteUrl, bare, sha, work} = remoteWith(dir => writeFiles(dir, {'.pr/a.png': 'png', 'a.txt': 'a\n'}));
    writeFiles(work, {'b.txt': 'b\n'});
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'more']);
    git(work, ['push', '--quiet', bare, 'feature']);
    const moved = git(work, ['rev-parse', 'HEAD']);
    const result = stripPrEntry({dir: tempDir(), remoteUrl, ref: 'feature', expectedSha: sha, identity, message});
    assert.equal(result.pushed, false);
    assert.match(result.reason, /branch moved/);
    assert.equal(git(bare, ['rev-parse', 'feature']), moved);
  });

  test('reports a rejected push instead of throwing', () => {
    const {remoteUrl, bare, sha} = remoteWith(dir => writeFiles(dir, {'.pr/a.png': 'png', 'a.txt': 'a\n'}));
    // A server-side hook stands in for a push GitHub refuses (no permission,
    // branch protection).
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho denied >&2\nexit 1\n', {mode: 0o755});
    const result = stripPrEntry({dir: tempDir(), remoteUrl, ref: 'feature', expectedSha: sha, identity, message});
    assert.equal(result.pushed, false);
    assert.match(result.reason, /push rejected/);
    assert.equal(git(bare, ['rev-parse', 'feature']), sha);
  });
});

describe('authEnv', () => {
  test('passes the token as an extra header in the environment, never in a URL', () => {
    const env = authEnv('secret-token', 'https://github.com');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:secret-token').toString('base64')}`);
    assert.deepEqual(authEnv(''), {});
  });
});

// A fake of the three API methods, routed by "METHOD path" (query included).
function fakeApi(routes, {graphql = () => { throw new Error('unexpected graphql'); }} = {}) {
  const calls = [];
  const handle = (method, path, body) => {
    calls.push({method, path, body});
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`unexpected call: ${key}`);
    const route = routes[key];
    return typeof route === 'function' ? route(body) : structuredClone(route);
  };
  return {
    calls,
    request: async (method, path, body) => handle(method, path, body),
    paginate: async path => handle('GET', path),
    graphql: async (query, variables) => {
      calls.push({method: 'GRAPHQL', variables});
      return graphql(query, variables);
    },
  };
}

describe('fastPath', () => {
  const entry = (path, sha, type = 'blob', mode = '100644') => ({path, mode, type, sha});
  const parentTree = [entry('src', 'aaa', 'tree', '040000'), entry('.pr', 'ppp', 'tree', '040000'), entry('README.md', 'rrr')];
  const routesFor = ({headTree, parents = [{sha: 'p1'}], conclusion = 'success', status = 'completed'}) => ({
    'GET /repos/acme/app/commits/h1': {parents, commit: {tree: {sha: 'th'}}},
    'GET /repos/acme/app/commits/p1': {parents: [{sha: 'p0'}], commit: {tree: {sha: 'tp'}}},
    'GET /repos/acme/app/git/trees/th': {truncated: false, tree: headTree},
    'GET /repos/acme/app/git/trees/tp': {truncated: false, tree: parentTree},
    'GET /repos/acme/app/commits/p1/check-runs?check_name=test-and-build%20(ubuntu)&filter=latest':
      {check_runs: [{status, conclusion}]},
  });
  const run = routes => fastPath({api: fakeApi(routes), owner: 'acme', repo: 'app', headSha: 'h1', checkName: 'test-and-build (ubuntu)'});

  test('skips when the head is its passing parent minus .pr', async () => {
    const result = await run(routesFor({headTree: [parentTree[0], parentTree[2]]}));
    assert.equal(result.skip, true);
  });
  test('runs when anything outside .pr changed', async () => {
    const result = await run(routesFor({headTree: [entry('src', 'CHANGED', 'tree', '040000'), parentTree[2]]}));
    assert.equal(result.skip, false);
  });
  test('runs when the head still has .pr, or the parent never had it', async () => {
    assert.equal((await run(routesFor({headTree: parentTree}))).skip, false);
  });
  test('runs when the check did not succeed on the parent', async () => {
    const headTree = [parentTree[0], parentTree[2]];
    assert.equal((await run(routesFor({headTree, conclusion: 'failure'}))).skip, false);
    assert.equal((await run(routesFor({headTree, status: 'in_progress', conclusion: null}))).skip, false);
  });
  test('runs for merge commits', async () => {
    const headTree = [parentTree[0], parentTree[2]];
    assert.equal((await run(routesFor({headTree, parents: [{sha: 'p1'}, {sha: 'p2'}]}))).skip, false);
  });
});

describe('pullNumbers', () => {
  const base = {owner: 'acme', repo: 'app'};
  test('uses an explicit number, then the event PR', async () => {
    assert.deepEqual(await pullNumbers({...base, api: fakeApi({}), eventName: 'workflow_dispatch', event: {}, pullNumber: '7'}), [7]);
    assert.deepEqual(await pullNumbers({...base, api: fakeApi({}), eventName: 'pull_request_target', event: {pull_request: {number: 3}}}), [3]);
  });
  test('finds fork PRs behind a workflow_run relay by head label', async () => {
    const api = fakeApi({'GET /repos/acme/app/pulls?state=open&head=someone%3Afix%2Fthing': [{number: 42}]});
    const event = {workflow_run: {pull_requests: [], head_branch: 'fix/thing', head_repository: {owner: {login: 'someone'}}}};
    assert.deepEqual(await pullNumbers({...base, api, eventName: 'workflow_run', event}), [42]);
  });
  test('sweeps approved open PRs on schedule', async () => {
    const api = fakeApi({}, {graphql: (_q, v) => {
      assert.equal(v.q, 'repo:acme/app is:pr is:open draft:false review:approved');
      return {search: {nodes: [{number: 1}, {number: 2}]}};
    }});
    assert.deepEqual(await pullNumbers({...base, api, eventName: 'schedule', event: {}}), [1, 2]);
  });
});

describe('reviewPull', () => {
  const pull = (overrides = {}) => ({
    state: 'open', draft: false, maintainer_can_modify: false,
    head: {sha: 'h1', ref: 'feature', repo: {full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git'}},
    base: {repo: {full_name: 'acme/app'}},
    ...overrides,
  });
  const setup = ({pr = pull(), files = [{filename: '.pr/a.png', status: 'added'}], decision = 'APPROVED'} = {}) => {
    const statuses = [];
    const api = fakeApi({
      'GET /repos/acme/app/pulls/5': pr,
      'GET /repos/acme/app/pulls/5/files': files,
      'POST /repos/acme/app/statuses/h1': body => statuses.push(body) && {},
    }, {graphql: () => ({repository: {pullRequest: {reviewDecision: decision}}})});
    const stripped = [];
    const strip = p => (stripped.push(p.head.sha), {pushed: true, commit: 'c2'});
    const run = (requireApproval = true) => reviewPull({
      api, owner: 'acme', repo: 'app', number: 5, requireApproval, context: 'pr-artifacts', strip, logger: {info() {}},
    });
    return {run, statuses, stripped};
  };

  test('approved PR with evidence: pending status, then the removal commit', async () => {
    const {run, statuses, stripped} = setup();
    assert.equal((await run()).action, 'stripped');
    assert.deepEqual(statuses.map(s => [s.state, s.context]), [['pending', 'pr-artifacts']]);
    assert.deepEqual(stripped, ['h1']);
  });
  test('not yet approved: pending, nothing pushed', async () => {
    const {run, stripped} = setup({decision: 'REVIEW_REQUIRED'});
    assert.equal((await run()).action, 'pending: not approved');
    assert.deepEqual(stripped, []);
  });
  test('require-approval false removes right away', async () => {
    const {run, stripped} = setup({decision: 'REVIEW_REQUIRED'});
    assert.equal((await run(false)).action, 'stripped');
    assert.deepEqual(stripped, ['h1']);
  });
  test('drafts are left alone', async () => {
    const {run, stripped} = setup({pr: pull({draft: true})});
    assert.equal((await run()).action, 'pending: draft');
    assert.deepEqual(stripped, []);
  });
  test('fork without maintainer edits: failure status, nothing pushed', async () => {
    const pr = pull({head: {sha: 'h1', ref: 'f', repo: {full_name: 'someone/app', clone_url: 'https://github.com/someone/app.git'}}});
    const {run, statuses, stripped} = setup({pr});
    assert.equal((await run()).action, 'status failure');
    assert.equal(statuses[0].state, 'failure');
    assert.deepEqual(stripped, []);
  });
  test('no evidence: success status only', async () => {
    const {run, statuses, stripped} = setup({files: [{filename: 'src/a.ts', status: 'modified'}, {filename: '.pr/old.md', status: 'removed'}]});
    assert.equal((await run()).action, 'status success');
    assert.equal(statuses[0].state, 'success');
    assert.deepEqual(stripped, []);
  });
  test('closed PRs are skipped without a status', async () => {
    const {run, statuses} = setup({pr: pull({state: 'closed'})});
    assert.equal((await run()).action, 'skipped: closed');
    assert.deepEqual(statuses, []);
  });
});
