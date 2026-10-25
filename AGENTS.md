# Repository instructions

## Dependency release-age policy

- Wait at least seven days after publication before adding or updating a
  third-party npm or PyPI version, including transitive lockfile changes.
  A weekly update schedule alone does not enforce this minimum age.
- Keep Dependabot `cooldown.default-days: 7` for npm and Python version
  updates, and preserve `tool.uv.exclude-newer = "7 days"` where configured.
  Existing named first-party exceptions do not exempt their third-party
  dependencies. Do not add broad exemptions or disable the cutoff to make a
  resolver succeed.
- Verify the exact version's publication/upload time from npm or PyPI metadata
  (or artifact `upload-time` in `uv.lock`), not the package's creation date.
  If age cannot be established, report the missing evidence rather than guess.
- Security updates can bypass Dependabot cooldown. An urgent exception needs
  explicit maintainer approval recorded in the PR with the package, version,
  advisory/reason, and publication time. Agents must not grant themselves an
  exception. Keep overrides narrow and remove temporary exceptions afterward.
- Use the committed lock for reproducible installs; review newly resolved
  artifacts before committing a lock update.

For manual npm dependency resolution, use npm >= 11.10 with
`npm install --min-release-age=7` (days), or verify registry timestamps before
committing the result. Older npm versions do not enforce this option. `npm ci`
replays the lock and is not proof that newly locked versions meet the age rule.
