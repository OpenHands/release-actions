// Keeps root `.pr/` review evidence out of the target branch BEFORE merge.
//
// - guardStatus: the `pr-artifacts` commit status. Pending while the PR adds
//   `.pr/` files, failure when the bot cannot remove them (a fork without
//   "Allow edits by maintainers"), success once the PR adds none. Make it a
//   required check and nothing under `.pr/` can merge.
// - stripPrEntry: one commit on the PR head that drops the root `.pr` entry,
//   built with Git plumbing only. PR code is never checked out or run.
// - fastPath: tells a consumer's CI that the head commit is exactly its parent
//   minus `.pr`, and the parent already passed, so the full suite can be skipped.

import {execFileSync} from 'node:child_process';

export const PR = '.pr';
const isPrPath = path => path === PR || path.startsWith(`${PR}/`);

// Commit status descriptions are capped at 140 characters by GitHub.
const clip = text => (text.length <= 140 ? text : `${text.slice(0, 139)}…`);

// The REST/GraphQL slice this module needs, over fetch. Tests inject a fake
// with the same three methods.
export function createApi({token, apiUrl = 'https://api.github.com', fetchImpl = fetch}) {
  async function request(method, path, body) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? {'content-type': 'application/json'} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const error = new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? null : res.json();
  }

  async function paginate(path) {
    const items = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const batch = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async function graphql(query, variables) {
    const res = await request('POST', '/graphql', {query, variables});
    if (res.errors?.length) throw new Error(`GraphQL: ${res.errors.map(e => e.message).join('; ')}`);
    return res.data;
  }

  return {request, paginate, graphql};
}

// Paths the PR itself adds or changes under the root `.pr/`. Evidence the base
// branch already carries is not this PR's, and deletions are what we want.
export function ownPrPaths(files) {
  return files.filter(file => file.status !== 'removed' && isPrPath(file.filename)).map(file => file.filename);
}

const isFork = pull => pull.head.repo?.full_name !== pull.base.repo.full_name;

// Same-repository branches are pushable with the bot token; a fork only when
// its author left "Allow edits by maintainers" on. A deleted fork never is.
export function canPush(pull) {
  if (!pull.head.repo) return false;
  return !isFork(pull) || pull.maintainer_can_modify === true;
}

export function guardStatus({pull, ownPaths}) {
  if (!ownPaths.length) {
    return {state: 'success', description: 'This PR adds no .pr/ review evidence.'};
  }
  if (!canPush(pull)) {
    return {
      state: 'failure',
      description: clip('Adds .pr/ files the bot cannot remove: turn on "Allow edits by maintainers" or delete .pr/, then push.'),
    };
  }
  const files = ownPaths.length === 1 ? '1 .pr/ file' : `${ownPaths.length} .pr/ files`;
  return {state: 'pending', description: clip(`${files} will be removed automatically after approval.`)};
}

// GitHub's own reading of the branch's review rules (null when none apply).
export async function isApproved({api, owner, repo, number}) {
  const data = await api.graphql(
    'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}',
    {owner, repo, number},
  );
  return data.repository.pullRequest.reviewDecision === 'APPROVED';
}

const GIT_ENV = {
  // Never read the runner's or a developer's Git config (hooks, signing,
  // credential helpers, filters).
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function gitRunner(dir, extraEnv) {
  return (args, input) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {...process.env, ...GIT_ENV, ...extraEnv},
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
}

// Basic auth via an extra header passed in the environment, the way
// actions/checkout does it, so the token never appears in argv or a URL.
export function authEnv(token, serverUrl = 'https://github.com') {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

// Pushes one commit on `ref` whose tree is the head's tree minus its root
// `.pr` entry (directory, file, symlink or submodule alike). Only plumbing
// runs: fetch, ls-tree, mktree, commit-tree, push. No checkout, so no filters,
// hooks or LFS smudging ever touch PR content.
//
// Returns {pushed, reason, commit}. It never force-pushes: if the branch moved
// since `expectedSha` was read, nothing is pushed and the next event retries.
export function stripPrEntry({dir, remoteUrl, ref, expectedSha, env = {}, identity, message}) {
  const git = gitRunner(dir, {
    ...env,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
  const branchRef = `refs/heads/${ref}`;
  git(['init', '--quiet']);
  git(['fetch', '--quiet', '--no-tags', '--depth=1', remoteUrl, branchRef]);
  const head = git(['rev-parse', 'FETCH_HEAD']).trim();
  if (head !== expectedSha) return {pushed: false, reason: `branch moved to ${head}`};

  const entries = git(['ls-tree', '-z', head]).split('\0').filter(Boolean);
  const kept = entries.filter(line => line.slice(line.indexOf('\t') + 1) !== PR);
  if (kept.length === entries.length) return {pushed: false, reason: 'no root .pr entry'};

  const tree = git(['mktree', '-z', '--missing'], kept.map(line => `${line}\0`).join('')).trim();
  const commit = git(['commit-tree', tree, '-p', head, '-m', message]).trim();
  try {
    git(['push', '--quiet', remoteUrl, `${commit}:${branchRef}`]);
  } catch (error) {
    return {pushed: false, reason: `push rejected: ${String(error.stderr || error.message).trim()}`};
  }
  return {pushed: true, reason: 'removed root .pr', commit};
}

async function rootEntries(api, owner, repo, treeSha) {
  const tree = await api.request('GET', `/repos/${owner}/${repo}/git/trees/${treeSha}`);
  if (tree.truncated) throw new Error(`Tree ${treeSha} is truncated.`);
  return tree.tree.map(({path, mode, type, sha}) => `${mode} ${type} ${sha}\t${path}`);
}

// True only when the head commit is its single parent minus the root `.pr`
// entry, nothing else, and `checkName` already succeeded on that parent. Every
// other file is then byte-for-byte what passed, so re-running is pure cost.
export async function fastPath({api, owner, repo, headSha, checkName}) {
  const head = await api.request('GET', `/repos/${owner}/${repo}/commits/${headSha}`);
  if (head.parents.length !== 1) return {skip: false, reason: 'head is not a single-parent commit'};
  const parentSha = head.parents[0].sha;
  const parent = await api.request('GET', `/repos/${owner}/${repo}/commits/${parentSha}`);

  const headEntries = await rootEntries(api, owner, repo, head.commit.tree.sha);
  const parentEntries = await rootEntries(api, owner, repo, parent.commit.tree.sha);
  const parentWithoutPr = parentEntries.filter(entry => entry.slice(entry.indexOf('\t') + 1) !== PR);
  if (parentWithoutPr.length === parentEntries.length) {
    return {skip: false, reason: 'parent has no root .pr entry'};
  }
  const same = headEntries.length === parentWithoutPr.length && headEntries.every(entry => parentWithoutPr.includes(entry));
  if (!same) return {skip: false, reason: 'head differs from its parent outside .pr'};

  const query = `check_name=${encodeURIComponent(checkName)}&filter=latest`;
  const runs = await api.request('GET', `/repos/${owner}/${repo}/commits/${parentSha}/check-runs?${query}`);
  const passed = runs.check_runs.some(run => run.status === 'completed' && run.conclusion === 'success');
  if (!passed) return {skip: false, reason: `"${checkName}" has not succeeded on parent ${parentSha}`};
  return {skip: true, reason: `head only drops .pr from ${parentSha}, where "${checkName}" passed`};
}

const APPROVED_PRS =
  'query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{number}}}}';

// Which PRs this run should look at, from the caller's event.
export async function pullNumbers({api, owner, repo, eventName, event, pullNumber}) {
  if (pullNumber) return [Number(pullNumber)];
  if (event.pull_request) return [event.pull_request.number];
  if (eventName === 'workflow_run') {
    // The review relay. `pull_requests` is empty for fork heads, so also look
    // the PR up by its head label.
    const run = event.workflow_run;
    const numbers = new Set((run.pull_requests || []).map(pull => pull.number));
    const headOwner = run.head_repository?.owner?.login;
    if (headOwner && run.head_branch) {
      const head = encodeURIComponent(`${headOwner}:${run.head_branch}`);
      const open = await api.request('GET', `/repos/${owner}/${repo}/pulls?state=open&head=${head}`);
      for (const pull of open) numbers.add(pull.number);
    }
    return [...numbers];
  }
  // schedule / workflow_dispatch without a number: sweep approved open PRs.
  const data = await api.graphql(APPROVED_PRS, {q: `repo:${owner}/${repo} is:pr is:open draft:false review:approved`});
  return data.search.nodes.map(node => node.number);
}

// One PR: publish the guard status, then remove `.pr` if it is time to.
export async function reviewPull({api, owner, repo, number, requireApproval, context, targetUrl, strip, logger = console}) {
  const pull = await api.request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  if (pull.state !== 'open') return {number, action: 'skipped: closed'};

  const files = await api.paginate(`/repos/${owner}/${repo}/pulls/${number}/files`);
  const ownPaths = ownPrPaths(files);
  const status = guardStatus({pull, ownPaths});
  await api.request('POST', `/repos/${owner}/${repo}/statuses/${pull.head.sha}`, {
    state: status.state,
    context,
    description: status.description,
    ...(targetUrl ? {target_url: targetUrl} : {}),
  });
  logger.info(`#${number}: ${context} = ${status.state} (${status.description})`);

  if (status.state !== 'pending') return {number, action: `status ${status.state}`};
  if (pull.draft) return {number, action: 'pending: draft'};
  if (requireApproval && !(await isApproved({api, owner, repo, number}))) {
    return {number, action: 'pending: not approved'};
  }
  const result = await strip(pull);
  logger.info(`#${number}: ${result.pushed ? `pushed ${result.commit}` : `not pushed (${result.reason})`}`);
  return {number, action: result.pushed ? 'stripped' : `not pushed: ${result.reason}`};
}
