const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  rejections,
  voice,
  breadth,
  agentBranch,
  verdict,
} = require('../index.js');

const now = new Date('2026-10-01T00:00:00Z');
const pr = (repo, state, created_at, merged_at = null) => ({
  repository_url: `https://api.github.com/repos/${repo}`,
  html_url: `https://github.com/${repo}/pull/1`,
  state,
  created_at,
  pull_request: { merged_at },
});
const comment = (body) => ({
  type: 'IssueCommentEvent',
  payload: { comment: { body } },
});
const opened = (name, created_at) => ({
  type: 'PullRequestEvent',
  payload: { action: 'opened' },
  repo: { name },
  created_at,
});
const signals = (overrides) => ({
  rejections: [],
  voice: null,
  breadth: 0,
  branch: 'fix',
  ...overrides,
});

test('rejections count recent unmerged closures outside own repositories', () => {
  assert.deepEqual(
    rejections(
      [
        pr('a/b', 'closed', '2026-09-20T00:00:00Z'),
        pr('a/c', 'closed', '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'),
        pr('a/d', 'open', '2026-09-20T00:00:00Z'),
        pr('a/e', 'closed', '2026-08-01T00:00:00Z'),
        pr('Author/x', 'closed', '2026-09-20T00:00:00Z'),
      ],
      'author',
      now,
    ),
    ['https://github.com/a/b/pull/1'],
  );
});

test('voice abstains below the comment minimum', () => {
  assert.equal(voice([comment('Thanks for the review!')]), null);
  assert.equal(voice([]), null);
});

test('voice measures structure, acknowledgements and em dashes', () => {
  const metrics = voice([
    comment('## Summary\n- one\n- two'),
    comment('You’re right, I’ll update it.'),
    comment("You're right — fixed."),
    comment('lgtm'),
  ]);
  assert.equal(metrics.comments, 4);
  assert.equal(metrics.structure, 0.25);
  assert.equal(metrics.acknowledgement, 0.25);
  assert.ok(metrics.emDashPerKChar > 0);
});

test('breadth counts unrelated repositories per week', () => {
  assert.equal(breadth([], 'author'), null);
  assert.equal(breadth([comment('hi')], 'author'), 0);
  assert.equal(
    breadth(
      [
        opened('a/a', '2026-09-03T00:00:00Z'),
        opened('b/b', '2026-09-03T00:00:00Z'),
        opened('b/b', '2026-09-04T00:00:00Z'),
        opened('author/fork', '2026-09-04T00:00:00Z'),
        opened('c/c', '2026-09-20T00:00:00Z'),
      ],
      'author',
    ),
    2,
  );
});

test('agent branch prefixes', () => {
  assert.ok(agentBranch('codex/fix-uris'));
  assert.ok(agentBranch('Claude-fix'));
  assert.ok(!agentBranch('fix/claude'));
  assert.ok(!agentBranch(undefined));
});

test('verdict', () => {
  assert.deepEqual(verdict(signals({})), []);
  assert.deepEqual(verdict(signals({ rejections: null, breadth: null })), []);
  assert.equal(verdict(signals({ rejections: ['x'] })).length, 1);
  assert.equal(verdict(signals({ breadth: 3 })).length, 1);
  assert.equal(verdict(signals({ branch: 'agent/x' })).length, 1);
  const quiet = {
    comments: 5,
    structure: 0.1,
    acknowledgement: 0.4,
    emDashPerKChar: 0.3,
  };
  assert.deepEqual(verdict(signals({ voice: quiet })), []);
  assert.equal(
    verdict(signals({ voice: { ...quiet, structure: 0.2 } })).length,
    1,
  );
});

// Snapshots of the public activity of real authors, with their login replaced
// by "author", sorted by whether their pull requests were opened unattended.
for (const kind of ['unattended', 'attended']) {
  const dir = path.join(__dirname, 'fixtures', kind);
  for (const file of fs.readdirSync(dir)) {
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, file)));
    test(`${kind}/${file}`, () => {
      const reasons = verdict({
        rejections: rejections(fixture.search, 'author', new Date(fixture.now)),
        voice: voice(fixture.events),
        breadth: breadth(fixture.events, 'author'),
        branch: fixture.branch,
      });
      assert.equal(
        reasons.length > 0,
        kind === 'unattended',
        reasons.join('\n'),
      );
    });
  }
}

test('trusted users are skipped without API calls', async () => {
  const logs = [];
  await require('../index.js')(
    {
      github: new Proxy(
        {},
        {
          get: () => {
            throw new Error('unexpected API call');
          },
        },
      ),
      context: {
        repo: { owner: 'o', repo: 'r' },
        payload: {
          pull_request: {
            number: 1,
            user: { login: 'Author', type: 'User' },
            author_association: 'CONTRIBUTOR',
          },
        },
      },
      core: { info: (message) => logs.push(message) },
    },
    { trustedOrgs: ['o'], trustedUsers: ['author'], label: 'unattended' },
  );
  assert.deepEqual(logs, [
    'Scoring 1 PR(s).',
    'Skipping PR #1 by Author (trusted user).',
  ]);
});
