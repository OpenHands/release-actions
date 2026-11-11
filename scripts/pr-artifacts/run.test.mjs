// End-to-end: runs run.mjs as the composite action does (environment only),
// against a local fake of the GitHub API and a real bare Git remote.

import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, test} from 'node:test';
import {promisify} from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = [];
after(() => scratch.forEach(dir => rmSync(dir, {recursive: true, force: true})));
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-artifacts-run-'));
  scratch.push(dir);
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
};
const git = (cwd, args) => execFileSync('git', args, {cwd, env: GIT_ENV}).toString().trim();

// Serves `routes` ("METHOD /path?query" -> body or fn(body)); records requests.
async function fakeGitHub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const key = `${req.method} ${req.url}`;
      requests.push({key, body, auth: req.headers.authorization});
      const route = key === 'POST /graphql' ? routes[`GRAPHQL ${body.query.match(/(reviewDecision|search)/)[1]}`] : routes[key];
      if (route === undefined) {
        res.writeHead(404).end(JSON.stringify({message: `no route ${key}`}));
        return;
      }
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(typeof route === 'function' ? route(body) : route));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close()};
}

async function runAction(env) {
  const dir = tempDir();
  const outputFile = join(dir, 'output');
  writeFileSync(outputFile, '');
  const eventFile = join(dir, 'event.json');
  writeFileSync(eventFile, JSON.stringify(env.event ?? {}));
  const {stdout, stderr} = await promisify(execFile)(process.execPath, [join(here, 'run.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_TOKEN: 'read-token',
      COMMITTER_NAME: 'bot',
      COMMITTER_EMAIL: 'bot@example.com',
      STATUS_CONTEXT: 'pr-artifacts',
      REQUIRE_APPROVAL: 'true',
      ...env.vars,
    },
  });
  return {stdout, stderr, output: readFileSync(outputFile, 'utf8')};
}

test('review: approved fork PR gets a pending status and a pushed removal commit', async () => {
  const work = tempDir();
  git(work, ['init', '--quiet', '-b', 'fix/thing']);
  mkdirSync(join(work, '.pr'));
  writeFileSync(join(work, '.pr', 'after.png'), 'png');
  writeFileSync(join(work, 'app.ts'), 'app\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'fix']);
  const bare = tempDir();
  git(bare, ['init', '--quiet', '--bare']);
  git(work, ['push', '--quiet', bare, 'fix/thing']);
  const sha = git(work, ['rev-parse', 'HEAD']);

  const pull = {
    state: 'open', draft: false, maintainer_can_modify: true,
    head: {sha, ref: 'fix/thing', repo: {full_name: 'someone/app', clone_url: `file://${bare}`}},
    base: {repo: {full_name: 'acme/app'}},
  };
  const api = await fakeGitHub({
    'GET /repos/acme/app/pulls/5': pull,
    'GET /repos/acme/app/pulls/5/files?per_page=100&page=1': [{filename: '.pr/after.png', status: 'added'}],
    [`POST /repos/acme/app/statuses/${sha}`]: {},
    'GRAPHQL reviewDecision': {data: {repository: {pullRequest: {reviewDecision: 'APPROVED'}}}},
  });
  try {
    await runAction({
      event: {pull_request: {number: 5}},
      vars: {MODE: 'review', GITHUB_API_URL: api.url, GITHUB_SERVER_URL: 'file://', GITHUB_EVENT_NAME: 'pull_request_target', PUSH_TOKEN: 'push-token'},
    });
  } finally {
    api.close();
  }
  const status = api.requests.find(r => r.key.startsWith('POST /repos/acme/app/statuses/'));
  assert.deepEqual([status.body.state, status.body.context], ['pending', 'pr-artifacts']);
  assert.ok(api.requests.every(r => r.auth === 'Bearer read-token'), 'API calls use github-token, never push-token');
  assert.equal(git(bare, ['ls-tree', '--name-only', 'fix/thing']), 'app.ts');
  assert.equal(git(bare, ['rev-parse', 'fix/thing^']), sha);
});

test('fast-path: writes skip=true only for a .pr-only commit on a passing parent', async () => {
  const tree = (...entries) => ({truncated: false, tree: entries.map(([path, sha]) => ({path, sha, mode: '100644', type: 'blob'}))});
  const api = await fakeGitHub({
    'GET /repos/acme/app/commits/h1': {parents: [{sha: 'p1'}], commit: {tree: {sha: 'th'}}},
    'GET /repos/acme/app/commits/p1': {parents: [{sha: 'p0'}], commit: {tree: {sha: 'tp'}}},
    'GET /repos/acme/app/git/trees/th': tree(['app.ts', 'a1']),
    'GET /repos/acme/app/git/trees/tp': tree(['app.ts', 'a1'], ['.pr', 'pr1']),
    'GET /repos/acme/app/commits/p1/check-runs?check_name=test&filter=latest': {check_runs: [{status: 'completed', conclusion: 'success'}]},
  });
  try {
    const skipped = await runAction({
      event: {pull_request: {number: 5, head: {sha: 'h1'}}},
      vars: {MODE: 'fast-path', GITHUB_API_URL: api.url, CHECK_NAME: 'test'},
    });
    assert.equal(skipped.output, 'skip=true\n');
    // An API failure means running the suite, not skipping it.
    const failed = await runAction({
      event: {pull_request: {number: 5, head: {sha: 'unknown'}}},
      vars: {MODE: 'fast-path', GITHUB_API_URL: api.url, CHECK_NAME: 'test'},
    });
    assert.equal(failed.output, 'skip=false\n');
  } finally {
    api.close();
  }
});
