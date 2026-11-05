// Keeps root `.pr/` review evidence out of release PRs (`cleanup-pr-artifacts`):
// the release PR commit is built on the target minus its root `.pr` entry, so
// the release merge itself removes the evidence from the target.

const PR = '.pr';
const isPrPath = path => path === PR || path.startsWith(`${PR}/`);

async function rootEntries(octokit, owner, repo, treeSha) {
  const {data} = await octokit.git.getTree({owner, repo, tree_sha: treeSha});
  if (data.truncated) throw new Error(`Tree ${treeSha} is truncated; cannot tell whether it holds ${PR}.`);
  return data.tree;
}

// Mode and type matter too: a file turned symlink or executable keeps its blob.
async function prEntry(octokit, owner, repo, treeSha) {
  const entry = (await rootEntries(octokit, owner, repo, treeSha)).find(({path}) => path === PR);
  return entry ? `${entry.mode} ${entry.type} ${entry.sha}` : null;
}

// The release PR on `head` would not merge clean if its tree holds `.pr`, or
// if the target's `.pr` is not the one the head was built on (and dropped).
async function isUnclean({octokit, owner, repo, targetBranch, head}) {
  const tip = async branch => (await octokit.repos.getBranch({owner, repo, branch})).data.commit;
  const release = await tip(head);
  if (await prEntry(octokit, owner, repo, release.commit.tree.sha)) return true;
  const target = await tip(targetBranch);
  const targetPr = await prEntry(octokit, owner, repo, target.commit.tree.sha);
  if (!targetPr) return false;
  const {data} = await octokit.repos.compareCommits({owner, repo, base: target.sha, head: release.sha});
  return targetPr !== await prEntry(octokit, owner, repo, data.merge_base_commit.commit.tree.sha);
}

export function cleanUpPrArtifacts({github, manifest, owner, repo, targetBranch, logger = console}) {
  const {octokit} = github;

  const buildChangeSet = github.buildChangeSet.bind(github);
  github.buildChangeSet = async (...args) => {
    const changes = await buildChangeSet(...args);
    for (const path of changes.keys()) if (isPrPath(path)) changes.delete(path);
    return changes;
  };

  // code-suggester is release-please's only createTree caller; `base_tree` is
  // the exact tree each release PR commit builds on. Swapping in a copy without
  // the root `.pr` entry (whatever its type) needs no `.pr` listing and no
  // assumption that the branch stays put, and relies only on documented
  // semantics: a tree created without `base_tree` is exactly its entries.
  const createTree = octokit.git.createTree;
  octokit.git.createTree = async params => {
    const entries = params.base_tree && await rootEntries(octokit, owner, repo, params.base_tree);
    if (!entries?.some(entry => entry.path === PR)) return createTree(params);
    const tree = entries.filter(entry => entry.path !== PR).map(({path, mode, type, sha}) => ({path, mode, type, sha}));
    const {data: base} = await createTree({owner, repo, tree});
    logger.info(`Dropping root ${PR} from the release PR commit.`);
    return createTree({...params, base_tree: base.sha});
  };

  // release-please re-pushes an open release PR only when its body changed;
  // re-push an unclean one too. Snoozed PRs and a configured always-update take
  // other paths and keep their stock behavior.
  const maybeUpdate = manifest.maybeUpdateExistingPullRequest.bind(manifest);
  manifest.maybeUpdateExistingPullRequest = async (existing, pullRequest) =>
    await isUnclean({octokit, owner, repo, targetBranch, head: existing.headBranchName})
      ? manifest.updateExistingPullRequest(existing, pullRequest)
      : maybeUpdate(existing, pullRequest);
}
