// Library-mode release-please driver.
//
// This replaces the googleapis/release-please-action step ONLY so we can inject
// a custom ChangelogNotes (the action exposes no hook for one). Everything else
// — version bumps, the release PR, the tag, the GitHub Release — is stock
// release-please via its public Manifest API, so behavior matches the action.
//
// Order matters and mirrors the action: create releases first (cut a release if
// a release PR was just merged), then create/refresh the next release PR.

import {Manifest, GitHub, registerChangelogNotes} from 'release-please';
import {appendFileSync} from 'node:fs';
import {GitHubScopedChangelogNotes} from './github-scoped-notes.mjs';

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${name}=${value}\n`);
  console.log(`::output:: ${name}=${value}`);
}

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
const targetBranch = process.env.TARGET_BRANCH;
const configFile = process.env.CONFIG_FILE || 'release-please-config.json';
const manifestFile = process.env.MANIFEST_FILE || '.release-please-manifest.json';

if (!token || !owner || !repo || !targetBranch) {
  console.error('Missing env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), TARGET_BRANCH');
  process.exit(1);
}

const github = await GitHub.create({owner, repo, token});

// Register our GitHub-style, path-scoped notes generator under a new changelog
// type. A package opts in with `"changelog-type": "github-scoped"` in its
// release-please config; packages that don't keep release-please's stock notes.
// (release-please does not enum-validate changelog-type — it just looks the name
// up in this registry — so a custom type is safe.)
registerChangelogNotes('github-scoped', options =>
  new GitHubScopedChangelogNotes({
    octokit: options.github.octokit, // release-please's authenticated client
    owner,
    repo,
  }));

const manifest = await Manifest.fromManifest(github, targetBranch, configFile, manifestFile);

// 1. Cut any release whose release PR was just merged. createReleases() copies
//    our GitHub-style notes out of the merged PR body (it does not regenerate
//    them), so the Release matches the PR exactly.
const releases = (await manifest.createReleases()).filter(Boolean);
const release = releases[0]; // single-package config per call -> at most one
setOutput('releases_created', releases.length);
setOutput('release_created', release ? 'true' : 'false');
if (release) {
  setOutput('tag_name', release.tagName);
  setOutput('version', release.version);
  setOutput('sha', release.sha);
  setOutput('pr', release.prNumber);
  console.log(`Created release ${release.tagName} @ ${release.sha}`);
}

// 2. Open/refresh the release PR for the next version. Its body is built by our
//    ChangelogNotes.buildNotes() — GitHub-styled and scoped to this chart.
const prs = (await manifest.createPullRequests()).filter(Boolean);
setOutput('prs_created', prs.length ? 'true' : 'false');
if (prs.length) {
  setOutput('pr_number', prs[0].number);
  console.log(`Release PR(s): ${prs.map(p => '#' + p.number).join(', ')}`);
}
