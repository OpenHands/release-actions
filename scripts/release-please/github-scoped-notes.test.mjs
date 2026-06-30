// Unit tests for the custom ChangelogNotes renderer. Run: `npm test` (or
// `node --test github-scoped-notes.test.mjs`). No dependencies — the module
// under test has no imports, and the GitHub client is faked below.
//
// The expected sectioned format (contiguous `###` sections, one blank line
// before "## New Contributors" and "**Full Changelog**") is byte-checked against
// a real GitHub-generated release (OpenHands/runtime-api v0.2.0).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GitHubScopedChangelogNotes} from './github-scoped-notes.mjs';

const url = n => `https://github.com/o/r/pull/${n}`;

function pr(number, {title, login = 'alice', labels = [], merged = true} = {}) {
  return {
    number,
    title: title ?? `PR ${number}`,
    html_url: url(number),
    user: {login},
    labels: labels.map(name => ({name})),
    merged_at: merged ? '2026-01-01T00:00:00Z' : null,
  };
}

const commit = sha => ({sha});

// Fake @octokit/rest. prsByCommit maps a commit SHA -> associated PRs;
// earliestByAuthor maps a login -> the number of that author's earliest merged
// PR in the repo (what the search endpoint would return).
function fakeOctokit({prsByCommit = {}, earliestByAuthor = {}} = {}) {
  return {
    repos: {
      listPullRequestsAssociatedWithCommit: async ({commit_sha}) =>
        prsByCommit[commit_sha] ?? [],
    },
    search: {
      issuesAndPullRequests: async ({q}) => {
        const login = (q.match(/author:(\S+)/) || [])[1];
        const num = earliestByAuthor[login];
        return {data: {items: num != null ? [{number: num}] : []}};
      },
    },
    paginate: async (fn, params) => fn(params),
  };
}

function notes(fixtures) {
  return new GitHubScopedChangelogNotes({
    octokit: fakeOctokit(fixtures),
    owner: 'o',
    repo: 'r',
    logger: {warn() {}, info() {}},
  });
}

const OPTS = {previousTag: 'c-v1.0.0', currentTag: 'c-v1.1.0'};
const FULL = '**Full Changelog**: https://github.com/o/r/compare/c-v1.0.0...c-v1.1.0';

test('namedCategoryFor maps labels to the first matching named category', () => {
  const n = notes();
  assert.equal(n.namedCategoryFor(['type: feat']), 'Features');
  assert.equal(n.namedCategoryFor(['type: fix']), 'Bug Fixes');
  assert.equal(n.namedCategoryFor(['type: perf']), 'Performance');
  assert.equal(n.namedCategoryFor(['type: docs']), 'Documentation');
  assert.equal(n.namedCategoryFor(['type: chore']), 'Maintenance');
  assert.equal(n.namedCategoryFor(['type: ci']), 'Maintenance');
  assert.equal(n.namedCategoryFor(['type: refactor']), 'Maintenance');
  // Category order decides ties: Features comes before Bug Fixes.
  assert.equal(n.namedCategoryFor(['type: fix', 'type: feat']), 'Features');
  // No type label -> null. The '*' catch-all is never returned here (it is
  // applied during rendering, not by this helper).
  assert.equal(n.namedCategoryFor([]), null);
  assert.equal(n.namedCategoryFor(['enhancement', 'bug']), null);
});

test('flat list (oldest-first) when no PR carries a named-category label', async () => {
  const n = notes({
    prsByCommit: {
      s1: [pr(101, {title: 'First', login: 'alice'})],
      s2: [pr(102, {title: 'Second', login: 'bob'})],
    },
  });
  // release-please hands commits newest-first; output must be oldest-first.
  const out = await n.buildNotes([commit('s2'), commit('s1')], OPTS);
  assert.equal(out, [
    "## What's Changed",
    `* First by @alice in ${url(101)}`,
    `* Second by @bob in ${url(102)}`,
    '',
    FULL,
  ].join('\n'));
});

test('sections render in category order, contiguous, with the catch-all', async () => {
  const n = notes({
    prsByCommit: {
      s1: [pr(201, {title: 'Add X', login: 'alice', labels: ['type: feat']})],
      s2: [pr(202, {title: 'Fix Y', login: 'bob', labels: ['type: fix']})],
      s3: [pr(203, {title: 'Chore Z', login: 'alice', labels: ['type: chore']})],
      s4: [pr(204, {title: 'Other W', login: 'carol'})], // unlabeled -> Other Changes
    },
  });
  const out = await n.buildNotes(
    [commit('s4'), commit('s3'), commit('s2'), commit('s1')], OPTS);
  assert.equal(out, [
    "## What's Changed",
    '### Features',
    `* Add X by @alice in ${url(201)}`,
    '### Bug Fixes',
    `* Fix Y by @bob in ${url(202)}`,
    '### Maintenance',
    `* Chore Z by @alice in ${url(203)}`,
    '### Other Changes',
    `* Other W by @carol in ${url(204)}`,
    '',
    FULL,
  ].join('\n'));
});

test('a PR mapped from multiple commits appears exactly once', async () => {
  const shared = pr(300, {title: 'Shared', login: 'alice'});
  const n = notes({prsByCommit: {s1: [shared], s2: [shared]}});
  const out = await n.buildNotes([commit('s2'), commit('s1')], OPTS);
  assert.equal(out.split('\n').filter(l => l.includes('/pull/300')).length, 1);
});

test('New Contributors lists only authors whose earliest merged PR is in this release', async () => {
  const n = notes({
    prsByCommit: {
      s1: [pr(401, {title: 'A1', login: 'newbie'})],
      s2: [pr(402, {title: 'B1', login: 'veteran'})],
    },
    earliestByAuthor: {
      newbie: 401, // earliest PR is in this release -> a new contributor
      veteran: 12, // earliest PR predates this release -> not new
    },
  });
  const out = await n.buildNotes([commit('s2'), commit('s1')], OPTS);
  assert.equal(out, [
    "## What's Changed",
    `* A1 by @newbie in ${url(401)}`,
    `* B1 by @veteran in ${url(402)}`,
    '',
    '## New Contributors',
    `* @newbie made their first contribution in ${url(401)}`,
    '',
    FULL,
  ].join('\n'));
});

test('omits Full Changelog when there is no previous tag (first release of a line)', async () => {
  const n = notes({prsByCommit: {s1: [pr(501, {title: 'Init', login: 'alice'})]}});
  const out = await n.buildNotes([commit('s1')], {currentTag: 'c-v1.0.0'});
  assert.equal(out, ["## What's Changed", `* Init by @alice in ${url(501)}`].join('\n'));
});

test('skips PRs that are not merged', async () => {
  const n = notes({
    prsByCommit: {
      s1: [pr(601, {title: 'Open PR', login: 'alice', merged: false})],
      s2: [pr(602, {title: 'Merged PR', login: 'bob'})],
    },
  });
  const out = await n.buildNotes([commit('s2'), commit('s1')], OPTS);
  assert.ok(!out.includes('/pull/601'));
  assert.ok(out.includes(`* Merged PR by @bob in ${url(602)}`));
});

test('ignores commits with no associated PR', async () => {
  const n = notes({prsByCommit: {s2: [pr(701, {title: 'Has PR', login: 'a'})]}}); // s1 has none
  const out = await n.buildNotes([commit('s2'), commit('s1')], OPTS);
  assert.ok(out.includes('/pull/701'));
});

test('placeholder when there are no commits', async () => {
  const out = await notes().buildNotes([], {currentTag: 'c-v1.0.0'});
  assert.equal(out, "## What's Changed\n\n_No changes in this release._");
});

test('does not throw when the PR lookup fails', async () => {
  const octokit = {
    repos: {listPullRequestsAssociatedWithCommit: async () => { throw new Error('boom'); }},
    search: {issuesAndPullRequests: async () => ({data: {items: []}})},
    paginate: async (fn, params) => fn(params),
  };
  const n = new GitHubScopedChangelogNotes({octokit, owner: 'o', repo: 'r', logger: {warn() {}}});
  const out = await n.buildNotes([commit('s1')], {currentTag: 'c-v1.0.0'});
  assert.equal(out, "## What's Changed\n\n_No changes in this release._");
});
