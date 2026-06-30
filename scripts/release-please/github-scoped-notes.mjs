// A custom release-please ChangelogNotes that renders GitHub-style release
// notes from the commits release-please has ALREADY scoped to one package path.
//
// Why this exists: the googleapis/release-please-action ships only two changelog
// types ("default" and "github"). "default" scopes per package but uses
// release-please's own format; "github" calls GitHub's generate-notes (the exact
// format we want) but over a FLAT tag-to-tag diff with no path filter, so it
// intermingles every package in a monorepo. Neither does both. release-please's
// `registerChangelogNotes()` lets us register a third type that does.
//
// The key property we exploit (release-please source, strategies/base.js):
//   * buildPullRequestBody() wraps THIS function's output as the release PR body.
//   * at release time, the published Release body is copied VERBATIM out of the
//     merged PR body (it is never regenerated).
// So whatever this returns is what the reviewer sees on the PR *and* what ships
// on the Release — identical by construction. That is the whole point.
//
// Scoping: release-please calls buildNotes(commits, options) once per release
// line, having already bucketed commits by the files they touch (util/
// commit-split.js). So `commits` is the in-scope set for this chart's path — we
// do NOT path-filter here.
//
// The label -> category map mirrors the consumer's .github/release.yml. It is
// hardcoded for the prototype; a production version could fetch and parse the
// consumer repo's .github/release.yml so each repo owns its own categories
// (that is exactly what GitHub's generate-notes does).

const CATEGORIES = [
  {title: 'Features', labels: ['type: feat']},
  {title: 'Bug Fixes', labels: ['type: fix']},
  {title: 'Performance', labels: ['type: perf']},
  {title: 'Documentation', labels: ['type: docs']},
  {
    title: 'Maintenance',
    labels: [
      'type: chore', 'type: build', 'type: ci',
      'type: refactor', 'type: style', 'type: test', 'type: revert',
    ],
  },
  {title: 'Other Changes', labels: ['*']},
];

export class GitHubScopedChangelogNotes {
  // `octokit` is release-please's own authenticated @octokit/rest client
  // (github.octokit), so methods live at octokit.repos.* / .search.* (no .rest).
  constructor({octokit, owner, repo, logger = console}) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.logger = logger;
  }

  // First NAMED category whose labels intersect this PR's labels; `*` excluded.
  namedCategoryFor(labelNames) {
    const set = new Set(labelNames);
    for (const cat of CATEGORIES) {
      if (cat.labels.includes('*')) continue;
      if (cat.labels.some(l => set.has(l))) return cat.title;
    }
    return null;
  }

  // release-please ChangelogNotes contract: (ConventionalCommit[], options).
  async buildNotes(commits, options) {
    const {octokit, owner, repo} = this;
    const previousTag = options.previousTag; // e.g. openhands-v0.7.68 (undefined on first release)
    const currentTag = options.currentTag;   // e.g. openhands-v0.7.69

    // release-please hands us commits newest-first; GitHub's "What's Changed"
    // lists oldest-first. Reverse so our order matches generate-notes.
    const ordered = [...commits].reverse();

    // 1. Map each scoped commit -> its merged PR(s). The associated-PR objects
    //    already carry number/title/html_url/user.login/labels, so no pulls.get.
    //    Dedup by PR number, preserving first-seen (oldest-first) order.
    const seen = new Set();
    const prs = [];
    for (const commit of ordered) {
      let assoc = [];
      try {
        assoc = await octokit.paginate(
          octokit.repos.listPullRequestsAssociatedWithCommit,
          {owner, repo, commit_sha: commit.sha, per_page: 100});
      } catch (e) {
        this.logger.warn(`assoc PRs for ${commit.sha} failed: ${e.message}`);
      }
      for (const pr of assoc) {
        if (!pr.merged_at) continue;
        if (seen.has(pr.number)) continue;
        seen.add(pr.number);
        prs.push(pr);
      }
    }

    // 2. New Contributors (GitHub's repo-wide definition): a PR author whose
    //    EARLIEST merged PR in the repo is itself one of THIS release's PRs.
    const numbers = new Set(prs.map(p => p.number));
    const newContribLines = [];
    const seenAuthors = new Set();
    for (const pr of prs) {
      const login = pr.user.login;
      if (seenAuthors.has(login)) continue;
      seenAuthors.add(login);
      let earliest = null;
      try {
        const res = await octokit.search.issuesAndPullRequests({
          q: `repo:${owner}/${repo} is:pr is:merged author:${login}`,
          sort: 'created', order: 'asc', per_page: 1,
        });
        earliest = res.data.items.length ? res.data.items[0].number : null;
      } catch (e) {
        this.logger.warn(`first-contribution search for @${login} failed: ${e.message}`);
      }
      if (earliest != null && numbers.has(earliest)) {
        const ePr = prs.find(p => p.number === earliest);
        newContribLines.push(`* @${login} made their first contribution in ${ePr.html_url}`);
      }
    }

    // 3. Render. Named ### sections only materialize when >=1 PR has a
    //    named-category label; otherwise a flat list under "## What's Changed"
    //    (matches generate-notes byte-for-byte on the cases we ship).
    const entryLine = pr => `* ${pr.title} by @${pr.user.login} in ${pr.html_url}`;
    const named = new Map(CATEGORIES.map(c => [c.title, []]));
    const unmatched = [];
    for (const pr of prs) {
      const t = this.namedCategoryFor((pr.labels || []).map(l => l.name));
      if (t) named.get(t).push(pr); else unmatched.push(pr);
    }
    const anyNamed = CATEGORIES.some(c => c.labels[0] !== '*' && named.get(c.title).length);

    const lines = ["## What's Changed"];
    if (prs.length === 0) {
      lines.push('', '_No changes in this release._');
    } else if (!anyNamed) {
      for (const pr of prs) lines.push(entryLine(pr));
    } else {
      for (const cat of CATEGORIES) {
        const list = cat.labels[0] === '*' ? unmatched : named.get(cat.title);
        if (!list.length) continue;
        lines.push(`### ${cat.title}`);
        for (const pr of list) lines.push(entryLine(pr));
      }
    }
    if (newContribLines.length) {
      lines.push('', '## New Contributors', ...newContribLines);
    }
    if (previousTag) {
      lines.push('', `**Full Changelog**: https://github.com/${owner}/${repo}/compare/${previousTag}...${currentTag}`);
    }
    return lines.join('\n').trim();
  }
}
