# unattended-pr-guard

A GitHub action that closes pull requests whose author’s public activity
suggests that an LLM is opening them unattended, and records the evidence in
the workflow run summary.

It labels each pull request it closes, `unattended` by default, creating the
label if needed. To overrule a decision, reopen the pull request and remove the
label. Pull requests that a maintainer has reopened, commented on or reviewed
are never closed afterwards.

## Usage

```yaml
name: Close unattended PRs
on:  # zizmor: ignore[dangerous-triggers]
  pull_request_target:
    types: [opened]
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: write
jobs:
  unattended-pr-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: scrapy/unattended-pr-guard@575f5d14e8f91dabd7da30a2ee22e3fdaad41474 # 0.1.0
        with:
          trusted-orgs: scrapy,scrapy-plugins,scrapinghub,zytedata
```

`pull_request_target` is safe here: the action only reads pull request and
public activity metadata through the API, it never checks out or runs pull
request code.

The schedule re-scores pull requests opened within the last 3 days, since the
evidence builds up over time.

Inputs:

- `trusted-orgs` (default: the owner of the repository): comma-separated
  organisations whose public members, and authors with 10 or more pull
  requests merged into them, are never scored.
- `label` (default: `unattended`): label added to the pull requests it closes.

## How it decides

Any of these signals is enough to close. Each one abstains when the data it
needs is unavailable, so a missing signal never counts against an author.

- Rejection burst: pull requests of theirs closed unmerged elsewhere within the
  last 30 days. Absolute volume separates spraying from ordinary contribution
  far better than a merge ratio, which rewards merges into trivial
  repositories.
- Spray breadth: pull requests opened against more than 2 repositories they
  do not own in a single week. It catches an agent on its first day, and it
  comes from the event feed, so it also covers authors that search refuses to
  return.
- Assistant voice: their recent comments across GitHub read as assistant
  output, by section headings, bullet lists, em dash density or stock
  acknowledgement phrases.
- Agent branch: the branch name carries an agent prefix, e.g. `codex/`.

Deliberately not used: account age, fork age, follower count, total pull
request count and cross-repository merge ratio. All of them were measured
against hand-labelled pull requests and either failed to separate or, in the
case of the merge ratio, inverted on held-out data.

## Development

```
node --test
pre-commit run --all-files
```

`test/fixtures/` holds snapshots of the public activity of real authors, with
their login replaced by `author`, sorted by whether their pull requests were
opened unattended.

To release, merge the release notes into `CHANGELOG.md` first, under a
`## X.Y.Z (unreleased)` heading. Then run `bump-my-version bump minor` (or
`major`, or `patch`), which commits the version bump, tags it, and commits the
README example pinned to that tag. Push `main` and the tag.
