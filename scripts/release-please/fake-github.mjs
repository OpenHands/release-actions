// Test helper (not a test): a throwaway Git repository, plus the slice of
// GitHub's REST and GraphQL APIs that release-please and code-suggester call,
// answered from that repository. Trees, modes and SHAs are real Git objects;
// only the HTTP hop is faked. Unimplemented calls throw, naming the method.

import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const GIT_ENV = {
  ...process.env,
  // Ignore the developer's own Git config (hooks, signing, autocrlf, ...).
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00]);
export const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x80, 0x00]);

export function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-artifacts-'));
  const run = (args, {env, input} = {}) =>
    execFileSync('git', args, {cwd: dir, env: {...GIT_ENV, ...env}, input, stdio: ['pipe', 'pipe', 'pipe']});
  const git = (args, options) => run(args, options).toString().trimEnd();
  git(['init', '--quiet', '-b', 'main']);

  const rev = name => {
    try {
      return git(['rev-parse', '--verify', '--quiet', name]);
    } catch {
      return null;
    }
  };

  // `git ls-tree`, shaped like GitHub's tree entries ({path, mode, type, sha}).
  const lsTree = (treeish, recursive = false) =>
    run(['ls-tree', '-z', ...(recursive ? ['-r', '-t'] : []), treeish]).toString()
      .split('\0').filter(Boolean).map(line => {
        const tab = line.indexOf('\t');
        const [mode, type, sha] = line.slice(0, tab).split(' ');
        return {path: line.slice(tab + 1), mode, type, sha};
      });

  function writeBlobs(contents) {
    if (!contents.length) return [];
    const scratch = mkdtempSync(join(dir, '.git', 'blobs-'));
    const paths = contents.map((content, i) => {
      writeFileSync(join(scratch, String(i)), content);
      return join(scratch, String(i));
    });
    const shas = git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {input: `${paths.join('\n')}\n`});
    rmSync(scratch, {recursive: true, force: true});
    return shas.split('\n');
  }

  // `base` (null = empty) plus blob entries: `content` writes a blob, `sha`
  // reuses one, `sha: null` deletes a path that must exist in `base`.
  function writeTree(base, entries) {
    if (entries.some(entry => entry.type && entry.type !== 'blob')) {
      throw new Error('fake GitHub: only blob entries are supported on top of a base tree');
    }
    const env = {GIT_INDEX_FILE: join(dir, '.git', 'scratch-index')};
    git(base ? ['read-tree', base] : ['read-tree', '--empty'], {env});
    const removals = entries.filter(entry => entry.sha === null).map(entry => entry.path);
    if (removals.length) {
      const tracked = new Set(run(['--literal-pathspecs', 'ls-files', '-z', '--', ...removals], {env})
        .toString().split('\0'));
      const missing = removals.filter(path => !tracked.has(path));
      if (missing.length) throw new Error(`cannot delete paths missing from ${base}: ${missing.join(', ')}`);
      git(['--literal-pathspecs', 'update-index', '--force-remove', '--', ...removals], {env});
    }
    const additions = entries.filter(entry => entry.sha !== null);
    const blobs = writeBlobs(additions.filter(entry => !entry.sha).map(entry => entry.content));
    const lines = additions.map(({path, mode, sha}) => `${mode} ${sha ?? blobs.shift()}\t${path}`);
    if (lines.length) git(['update-index', '--index-info'], {env, input: `${lines.join('\n')}\n`});
    return git(['write-tree'], {env});
  }

  // A tree of exactly these existing objects, as GitHub builds one without `base_tree`.
  function makeTree(entries) {
    if (entries.some(entry => entry.path.includes('/') || !entry.sha)) {
      throw new Error('fake GitHub: a tree without base_tree must list existing objects by name');
    }
    return git(['mktree'], {input: entries.map(e => `${e.mode} ${e.type} ${e.sha}\t${e.path}\n`).join('')});
  }

  const commitTree = (tree, parents, message) =>
    git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message]);

  return {
    dir,
    git,
    rev,
    lsTree,
    writeTree,
    makeTree,
    commitTree,
    blob: sha => run(['cat-file', 'blob', sha]),
    // Commit `files` (path -> string | Buffer | {mode, content} | null to delete)
    // on top of `branch`, creating the branch if needed.
    commit(files, {branch = 'main', message = 'test'} = {}) {
      const parent = rev(`refs/heads/${branch}`);
      const entries = Object.entries(files).map(([path, value]) => {
        if (value === null) return {path, sha: null};
        if (typeof value === 'string' || Buffer.isBuffer(value)) return {path, mode: '100644', content: value};
        return {path, ...value};
      });
      const sha = commitTree(writeTree(parent, entries), parent ? [parent] : [], message);
      git(['update-ref', `refs/heads/${branch}`, sha]);
      return sha;
    },
    // Paths that differ between two revisions, as `git diff --name-status` lines.
    diff: (from, to) => git(['diff', '--no-renames', '--name-status', from, to]).split('\n').filter(Boolean).sort(),
    show: (rev, path) => git(['show', `${rev}:${path}`]),
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  };
}

// An @octokit/rest-shaped client and a GraphQL function over `repo`, plus test
// controls for merging PRs and publishing releases. Every API call is recorded
// in `calls`. `afterBranchRead(branch)` runs after each `repos.getBranch`, to
// land concurrent pushes at the worst moment.
export function fakeGitHub(repo, {owner = 'o', name = 'r', afterBranchRead = () => {}} = {}) {
  const calls = [];
  const pulls = [];
  const releases = [];
  const fullName = `${owner}/${name}`;
  const notFound = what => Object.assign(new Error(`Not Found: ${what}`), {status: 404});
  const resolve = ref => repo.rev(ref) ?? (() => { throw notFound(ref); })();
  const pull = number => pulls[number - 1] ?? (() => { throw notFound(`pull ${number}`); })();

  function addPull({title, body = '', head, base, state = 'open', draft = false, files = []}) {
    const number = pulls.length + 1;
    const url = `https://github.test/${fullName}/pull/${number}`;
    pulls.push({
      number, title, body, state, draft, files, url, html_url: url, labels: [], merged_at: null, merge_commit_sha: null,
      head: {ref: head, label: `${owner}:${head}`, repo: {full_name: fullName}, get sha() { return repo.rev(`refs/heads/${head}`); }},
      base: {ref: base},
    });
    return pull(number);
  }

  function markMerged(pr, sha) {
    Object.assign(pr, {state: 'closed', merged_at: new Date().toISOString(), merge_commit_sha: sha});
  }

  const listPulls = ({state = 'open', head, base} = {}) => pulls
    .filter(pr => (state === 'all' || pr.state === state) && (!head || pr.head.label === head) && (!base || pr.base.ref === base))
    .reverse();

  const listTags = () => repo.git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/tags'])
    .split('\n').filter(Boolean).map(line => {
      const [tag, sha] = line.split(' ');
      return {name: tag, commit: {sha}};
    });

  const handlers = {
    repos: {
      async getBranch({branch}) {
        const sha = resolve(`refs/heads/${branch}`);
        const data = {name: branch, commit: {sha, commit: {tree: {sha: resolve(`${sha}^{tree}`)}}}};
        afterBranchRead(branch);
        return {data};
      },
      async compareCommits({base, head}) {
        const mergeBase = repo.git(['merge-base', base, head]);
        return {data: {merge_base_commit: {sha: mergeBase, commit: {tree: {sha: resolve(`${mergeBase}^{tree}`)}}}}};
      },
      async createRelease({tag_name, name: releaseName, body, target_commitish, draft}) {
        repo.git(['update-ref', `refs/tags/${tag_name}`, target_commitish, '']);
        const release = {
          id: releases.length + 1, name: releaseName, tag_name, body, target_commitish, draft,
          html_url: `https://github.test/${fullName}/releases/tag/${tag_name}`, upload_url: 'https://uploads.github.test',
        };
        releases.push(release);
        return {data: release};
      },
    },
    git: {
      async getTree({tree_sha, recursive}) {
        const sha = resolve(`${tree_sha}^{tree}`);
        return {data: {sha, truncated: false, tree: repo.lsTree(sha, recursive !== undefined)}};
      },
      async getBlob({file_sha}) {
        return {data: {sha: file_sha, encoding: 'base64', content: repo.blob(file_sha).toString('base64')}};
      },
      async getRef({ref}) {
        return {data: {ref: `refs/${ref}`, object: {type: 'commit', sha: resolve(`refs/${ref}`)}}};
      },
      async createRef({ref, sha}) {
        repo.git(['update-ref', ref, sha, '']); // '' = must not exist yet
        return {data: {ref, object: {type: 'commit', sha}}};
      },
      async updateRef({ref, sha}) {
        repo.git(['update-ref', `refs/${ref}`, sha]);
        return {data: {ref: `refs/${ref}`, object: {type: 'commit', sha}}};
      },
      async getCommit({commit_sha}) {
        return {data: {sha: commit_sha, tree: {sha: resolve(`${commit_sha}^{tree}`)}}};
      },
      async createTree({base_tree, tree}) {
        return {data: {sha: base_tree ? repo.writeTree(base_tree, tree) : repo.makeTree(tree)}};
      },
      async createCommit({message, tree, parents}) {
        const sha = repo.commitTree(tree, parents, message);
        return {data: {sha, url: `https://api.github.test/commits/${sha}`}};
      },
    },
    pulls: {
      async list(params) {
        return {data: listPulls(params)};
      },
      async create({title, head, base, body, draft}) {
        return {data: addPull({title, body, draft, base, head: head.slice(head.indexOf(':') + 1)})};
      },
      async get({pull_number}) {
        return {data: pull(pull_number)};
      },
      async update({pull_number, title, body, state}) {
        return {data: Object.assign(pull(pull_number), {title, body, ...(state && {state})})};
      },
    },
    issues: {
      async addLabels({issue_number, labels}) {
        const pr = pull(issue_number);
        for (const label of labels) if (!pr.labels.some(l => l.name === label)) pr.labels.push({name: label});
        return {data: pr.labels};
      },
      async removeLabel({issue_number, name: label}) {
        const pr = pull(issue_number);
        pr.labels = pr.labels.filter(l => l.name !== label);
        return {data: pr.labels};
      },
      async createComment({issue_number, body}) {
        return {data: {id: calls.length, issue_number, body}};
      },
    },
  };

  const routes = {
    'GET /repos/{owner}/{repo}/pulls': listPulls,
    'GET /repos/{owner}/{repo}/tags': listTags,
  };
  const listRoute = (route, params) => {
    if (!routes[route]) throw new Error(`fake GitHub: paginate('${route}') is not implemented`);
    calls.push({method: route, params});
    return routes[route](params);
  };

  const octokit = {};
  for (const [namespace, methods] of Object.entries(handlers)) {
    octokit[namespace] = new Proxy(methods, {
      get(target, method) {
        if (typeof method !== 'string') return undefined;
        if (!Object.hasOwn(target, method)) {
          throw new Error(`fake GitHub: octokit.${namespace}.${method}() is not implemented`);
        }
        const implementation = target[method];
        return async params => {
          calls.push({method: `${namespace}.${method}`, params});
          return implementation(params);
        };
      },
    });
  }
  octokit.rest = octokit;
  octokit.paginate = async (route, params) =>
    typeof route === 'function' ? (await route(params)).data : listRoute(route, params);
  octokit.paginate.iterator = (route, params) => (async function* () {
    yield {data: listRoute(route, params)};
  })();

  const graphqlPull = pr => ({
    number: pr.number, title: pr.title, body: pr.body, baseRefName: pr.base.ref, headRefName: pr.head.ref,
    labels: {nodes: pr.labels.map(l => ({name: l.name}))},
    mergeCommit: pr.merge_commit_sha && {oid: pr.merge_commit_sha},
    files: {nodes: pr.files.map(path => ({path})), pageInfo: {hasNextPage: false, endCursor: null}},
  });
  const page = (items, num, cursor) => {
    const start = Number(cursor ?? 0);
    return {nodes: items.slice(start, start + num), pageInfo: {hasNextPage: start + num < items.length, endCursor: String(start + num)}};
  };
  async function graphql({query, ...vars}) {
    calls.push({method: `graphql ${query.match(/query (\w+)/)?.[1]}`, params: vars});
    if (query.includes('query pullRequestsSince')) {
      const head = repo.rev(`refs/heads/${vars.targetBranch}`);
      if (!head) return {repository: {ref: null}};
      const shas = repo.git(['rev-list', '--first-parent', head]).split('\n');
      const commits = shas.map(sha => ({
        sha, message: repo.git(['log', '-1', '--format=%B', sha]),
        associatedPullRequests: {nodes: pulls.filter(pr => pr.merge_commit_sha === sha).map(graphqlPull)},
      }));
      return {repository: {ref: {target: {history: page(commits, vars.num, vars.cursor)}}}};
    }
    if (query.includes('query releases')) {
      const nodes = [...releases].reverse().map(r => ({
        name: r.name, tag: {name: r.tag_name}, tagCommit: {oid: r.target_commitish},
        url: r.html_url, description: r.body, isDraft: !!r.draft,
      }));
      return {repository: {releases: page(nodes, vars.num, vars.cursor)}};
    }
    throw new Error(`fake GitHub: GraphQL ${query.match(/query (\w+)/)?.[1]} is not implemented`);
  }

  return {
    octokit,
    graphql,
    calls,
    pulls,
    releases,
    // Squash-merge a product PR of `files` into `base` with `title` as message.
    mergePr(title, files, {base = 'main'} = {}) {
      const pr = addPull({title, base, head: `feature-${pulls.length + 1}`, state: 'closed', files: Object.keys(files)});
      markMerged(pr, repo.commit(files, {branch: base, message: title}));
      return pr.merge_commit_sha;
    },
    // Squash-merge an open PR (e.g. the release PR) as GitHub would.
    squashMerge(number) {
      const pr = pull(number);
      const base = resolve(`refs/heads/${pr.base.ref}`);
      const tree = repo.git(['merge-tree', '--write-tree', base, resolve(`refs/heads/${pr.head.ref}`)]).split('\n')[0];
      const sha = repo.commitTree(tree, [base], `${pr.title} (#${number})`);
      repo.git(['update-ref', `refs/heads/${pr.base.ref}`, sha]);
      markMerged(pr, sha);
      return sha;
    },
    publishRelease(tag, sha) {
      repo.git(['update-ref', `refs/tags/${tag}`, sha]);
      releases.push({id: releases.length + 1, name: tag, tag_name: tag, target_commitish: sha, body: ''});
    },
  };
}
