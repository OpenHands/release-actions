// `.pr/` cleanup (pr-artifacts.mjs) driven through the real release-please
// Manifest, GitHub client and code-suggester. Run: `npm install && npm test`.
// The GitHub API is the only fake (fake-github.mjs), answered from a real
// throwaway Git repository.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GitHub, Manifest, setLogger} from 'release-please';
import {createRepo, fakeGitHub, PNG, WEBM} from './fake-github.mjs';
import {cleanUpPrArtifacts} from './pr-artifacts.mjs';

const OWNER = 'o';
const REPO = 'r';
const MAIN_HEAD = 'release-please--branches--main';
const APP = {config: 'release-please-config.json', manifest: '.release-please-manifest.json'};
const CLOUD = {config: 'release-please-config.cloud.json', manifest: '.release-please-manifest.cloud.json'};
const logger = {error() {}, warn() {}, info() {}, debug() {}, trace() {}};
setLogger(logger);

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const config = (pkg = {}) =>
  json({'draft-pull-request': true, packages: {'.': {'release-type': 'simple', 'skip-changelog': true, ...pkg}}});
const isPr = path => path === '.pr' || path.startsWith('.pr/');

const EVIDENCE = {
  '.pr/README.md': '# evidence\n',
  '.pr/screenshots/home.png': PNG,
  '.pr/live-e2e/run-1/video.webm': WEBM,
  '.pr/live-e2e/latest': {mode: '120000', content: 'run-1/video.webm'},
  '.pr/scripts/repro.sh': {mode: '100755', content: '#!/bin/sh\necho repro\n'},
  ...Object.fromEntries(Array.from({length: 120}, (_, i) => [`.pr/bulk/note-${String(i).padStart(3, '0')}.md`, `${i}\n`])),
};
const LOOKALIKES = {'.prettierrc': '{}\n', '.pr-other/keep.txt': 'keep\n', 'pkg/.pr/keep.md': 'keep\n'};

// A repository released at v0.3.0, as release-please left it.
function released(t, files = {}, options = {}) {
  const repo = createRepo();
  t.after(repo.cleanup);
  const gh = fakeGitHub(repo, {owner: OWNER, name: REPO, ...options});
  const base = gh.mergePr('chore: initial import', {
    [APP.config]: config(),
    [APP.manifest]: json({'.': '0.3.0'}),
    'version.txt': '0.3.0\n',
    'README.md': '# demo\n',
    ...files,
  });
  gh.publishRelease('v0.3.0', base);
  return {repo, gh};
}

// The real release-please client and manifest, wired as run.mjs wires them.
async function setUp(gh, {branch = 'main', line = APP, cleanup = true} = {}) {
  const github = await GitHub.create({
    owner: OWNER,
    repo: REPO,
    defaultBranch: 'main',
    logger,
    octokitAPIs: {octokit: gh.octokit, graphql: gh.graphql, request: () => { throw new Error('unexpected request()'); }},
  });
  const manifest = await Manifest.fromManifest(github, branch, line.config, line.manifest, {logger});
  if (cleanup) cleanUpPrArtifacts({github, manifest, owner: OWNER, repo: REPO, targetBranch: branch, logger});
  gh.calls.length = 0;
  return {github, manifest};
}

// One release-please run, as run.mjs runs it.
async function releasePlease(gh, options) {
  const {manifest} = await setUp(gh, options);
  const releases = (await manifest.createReleases()).filter(Boolean);
  const prs = (await manifest.createPullRequests()).filter(Boolean);
  return {releases, prs};
}

// Each ref update of an existing branch is one push, i.e. one CI run.
const pushes = (gh, head) =>
  gh.calls.filter(c => c.method === 'git.updateRef' && c.params.ref === `heads/${head}`).length;

// `head` is ONE commit on top of `target` that bumps the release files and
// deletes every tracked root `.pr` entry of `target` — nothing else.
function assertCleanRelease(repo, {head = MAIN_HEAD, target = 'main', manifest = APP.manifest, bumped = {'version.txt': '0.4.0'}} = {}) {
  const evidence = repo.lsTree(target, true).filter(e => e.type !== 'tree' && isPr(e.path)).map(e => `D\t${e.path}`);
  const releaseFiles = [manifest, ...Object.keys(bumped)].map(path => `M\t${path}`);
  assert.deepEqual(repo.diff(target, head), [...evidence, ...releaseFiles].sort());
  assert.equal(repo.git(['rev-list', '--count', `${target}..${head}`]), '1');
  assert.equal(repo.git(['merge-base', target, head]), repo.rev(target));
  for (const [path, version] of Object.entries(bumped)) assert.equal(repo.show(head, path), version);
}

test('the release PR drops all root .pr/ evidence in its single commit and push', async t => {
  const {repo, gh} = released(t, LOOKALIKES);
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n', ...EVIDENCE});

  const {prs} = await releasePlease(gh);

  assert.equal(prs.length, 1);
  assertCleanRelease(repo);
  assert.equal(pushes(gh, MAIN_HEAD), 1);
  // The root entry goes as a whole: no `.pr/` path is sent as a tree entry.
  const sent = gh.calls.filter(c => c.method === 'git.createTree').flatMap(c => c.params.tree);
  assert.ok(!sent.some(entry => isPr(entry.path)));
});

test('a release of over 100 files is several commits behind one push, the first already without .pr/', async t => {
  const {repo, gh} = released(t);
  gh.mergePr('feat: add search', {'.pr/home.png': PNG});
  const {github} = await setUp(gh);
  const updates = Array.from({length: 150}, (_, i) =>
    ({path: `gen/${i}.txt`, createIfMissing: true, updater: {updateContent: () => `${i}\n`}}));

  await github.createPullRequest(
    {headBranchName: MAIN_HEAD, baseBranchName: 'main', number: -1, title: 'chore: big', body: '', labels: [], files: []},
    'main', 'chore: big', updates, {fork: false});

  assert.equal(repo.git(['rev-list', '--count', `main..${MAIN_HEAD}`]), '2');
  assert.equal(pushes(gh, MAIN_HEAD), 1);
  assert.ok(!repo.lsTree(`${MAIN_HEAD}~1`).some(entry => entry.path === '.pr'));
  assert.deepEqual(repo.diff('main', MAIN_HEAD), ['D\t.pr/home.png', ...updates.map(u => `A\t${u.path}`)].sort());
});

test('a root .pr symlink is removed itself, never followed', async t => {
  const {repo, gh} = released(t, {'docs/guide.md': '# guide\n'});
  gh.mergePr('feat: link evidence', {'.pr': {mode: '120000', content: 'docs'}});

  await releasePlease(gh);

  assertCleanRelease(repo);
});

test('a release PR never adds .pr/ paths, even ones release-please generates', async t => {
  const {repo, gh} = released(t);
  gh.mergePr('chore: keep the changelog with evidence', {
    [APP.config]: config({'skip-changelog': false, 'changelog-path': '.pr/CHANGELOG.md'}),
  });
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n'});

  await releasePlease(gh, {cleanup: false});
  assert.ok(repo.diff('main', MAIN_HEAD).includes('A\t.pr/CHANGELOG.md'), 'stock release-please writes it');

  const {prs} = await releasePlease(gh);

  assert.equal(prs.length, 1, 'the unclean head is refreshed although the notes are unchanged');
  assertCleanRelease(repo);
});

test('evidence merged without a notes change refreshes the release PR once; reruns push nothing', async t => {
  const {repo, gh} = released(t);
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n'});
  await releasePlease(gh);
  gh.mergePr('chore: add screenshots', {'.pr/home.png': PNG});

  assert.deepEqual((await releasePlease(gh, {cleanup: false})).prs, [], 'stock release-please keeps the PR');
  assert.equal((await releasePlease(gh)).prs.length, 1);
  assertCleanRelease(repo);
  assert.equal(pushes(gh, MAIN_HEAD), 1);

  assert.deepEqual((await releasePlease(gh)).prs, []);
  assert.equal(pushes(gh, MAIN_HEAD), 0);
});

test('a mode-only change of a root .pr file (same blob) still refreshes the release PR', async t => {
  const {repo, gh} = released(t);
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n', '.pr': 'docs\n'});
  await releasePlease(gh);

  for (const mode of ['120000', '100755']) {
    gh.mergePr('chore: retype evidence', {'.pr': {mode, content: 'docs\n'}});
    assert.equal((await releasePlease(gh)).prs.length, 1, mode);
    assertCleanRelease(repo);
    assert.equal(pushes(gh, MAIN_HEAD), 1);
  }
});

test('evidence pushed onto the release branch alone forces a refresh', async t => {
  const {repo, gh} = released(t);
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n'});
  await releasePlease(gh);
  repo.commit({'.pr/live-e2e/video.webm': WEBM}, {branch: MAIN_HEAD});

  assert.equal((await releasePlease(gh)).prs.length, 1);
  assertCleanRelease(repo);

  assert.deepEqual((await releasePlease(gh)).prs, []);
  assert.equal(pushes(gh, MAIN_HEAD), 0);
});

test('without a release candidate there is no release PR, even with evidence on the target', async t => {
  const {gh} = released(t);
  gh.mergePr('chore: add screenshots', {'.pr/home.png': PNG});

  assert.deepEqual((await releasePlease(gh)).prs, []);

  assert.equal(gh.pulls.filter(pr => pr.state === 'open').length, 0);
  assert.ok(!gh.calls.some(c => /^git\.(createRef|updateRef|createTree|createCommit)$/.test(c.method)));
});

test('pushes landing right after every read of the target still leave the release commit clean', async t => {
  let gh;
  let landed = 0;
  const afterBranchRead = branch => {
    if (branch === 'main' && landed < 5) gh.mergePr(`chore: evidence ${landed}`, {[`.pr/race-${landed++}.png`]: PNG});
  };
  const fixture = released(t, {}, {afterBranchRead});
  gh = fixture.gh;
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n', '.pr/search.png': PNG});

  await releasePlease(gh);

  assert.ok(landed > 0);
  assertCleanRelease(fixture.repo, {target: `${MAIN_HEAD}^`});
});

test('main and release/** release PRs each clean only their own target', async t => {
  const {repo, gh} = released(t);
  repo.git(['branch', 'release/0.3', 'main']);
  gh.mergePr('fix: patch crash', {'src/fix.txt': 'fix\n', '.pr/hotfix.png': PNG}, {base: 'release/0.3'});
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n', '.pr/search.png': PNG});

  await releasePlease(gh);
  const mainHead = repo.rev(MAIN_HEAD);
  await releasePlease(gh, {branch: 'release/0.3'});

  assertCleanRelease(repo);
  assertCleanRelease(repo, {
    head: 'release-please--branches--release/0.3', target: 'release/0.3', bumped: {'version.txt': '0.3.1'},
  });
  assert.equal(repo.rev(MAIN_HEAD), mainHead);
});

test('separate release lines on one branch refresh independently', async t => {
  const {repo, gh} = released(t, {
    [CLOUD.config]: config({component: 'cloud', 'version-file': 'cloud-version.txt'}),
    [CLOUD.manifest]: json({'.': '1.0.0'}),
    'cloud-version.txt': '1.0.0\n',
  });
  gh.publishRelease('cloud-v1.0.0', repo.rev('main'));
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n', '.pr/search.png': PNG});
  const cloudHead = 'release-please--branches--main--components--cloud';
  const cloud = {head: cloudHead, manifest: CLOUD.manifest, bumped: {'cloud-version.txt': '1.1.0'}};

  await releasePlease(gh);
  await releasePlease(gh, {line: CLOUD});
  assertCleanRelease(repo);
  assertCleanRelease(repo, cloud);

  repo.commit({'.pr/cloud-e2e.webm': WEBM}, {branch: cloudHead});
  assert.deepEqual((await releasePlease(gh)).prs, [], 'another line\'s release branch is not this line\'s concern');
  assert.equal((await releasePlease(gh, {line: CLOUD})).prs.length, 1);
  assertCleanRelease(repo, cloud);
});

test('with separate package PRs, only the unclean open one is refreshed; a snoozed sibling stays closed', async t => {
  const pkg = component => ({'release-type': 'simple', component, 'skip-changelog': true});
  const {repo, gh} = released(t, {
    [APP.config]: json({'draft-pull-request': true, 'separate-pull-requests': true, packages: {a: pkg('a'), b: pkg('b')}}),
    [APP.manifest]: json({a: '1.0.0', b: '1.0.0'}),
    'a/version.txt': '1.0.0\n',
    'b/version.txt': '1.0.0\n',
  });
  for (const tag of ['a-v1.0.0', 'b-v1.0.0']) gh.publishRelease(tag, repo.rev('main'));
  gh.mergePr('feat: a search', {'a/search.txt': 'a\n'});
  gh.mergePr('feat: b search', {'b/search.txt': 'b\n'});
  const [headA, headB] = ['a', 'b'].map(c => `release-please--branches--main--components--${c}`);
  assert.equal((await releasePlease(gh)).prs.length, 2);
  const snoozed = gh.pulls.find(pr => pr.head.ref === headB);
  Object.assign(snoozed, {state: 'closed', labels: [...snoozed.labels, {name: 'autorelease: snooze'}]});
  const snoozedHead = repo.rev(headB);
  gh.mergePr('chore: add screenshots', {'.pr/home.png': PNG});

  assert.equal((await releasePlease(gh)).prs.length, 1);

  assertCleanRelease(repo, {head: headA, bumped: {'a/version.txt': '1.1.0'}});
  assert.equal(pushes(gh, headB), 0);
  assert.equal(repo.rev(headB), snoozedHead);
  assert.equal(snoozed.state, 'closed');
});

test('merging the release PR publishes from a tree without .pr/ and opens no follow-up PR', async t => {
  const {repo, gh} = released(t);
  gh.mergePr('feat: add search', {'src/search.txt': 'search\n', ...EVIDENCE});
  const [pr] = (await releasePlease(gh)).prs;
  const merged = gh.squashMerge(pr.number);

  const {releases, prs} = await releasePlease(gh);

  assert.ok(!repo.lsTree('main').some(entry => entry.path === '.pr'));
  assert.deepEqual(releases.map(r => [r.tagName, r.sha]), [['v0.4.0', merged]]);
  assert.deepEqual(prs, []);
});
