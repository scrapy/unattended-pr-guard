const RETRIES = 5;
const RETRY_WAIT_MS = 60000;
const REJECTION_WINDOW_DAYS = 30;
const RECHECK_WINDOW_DAYS = 3;
const MIN_REJECTIONS = 1;
const MIN_COMMENTS = 2;
const MAX_REPOS_PER_WEEK = 2;
const VOICE = { structure: 0.1, emDashPerKChar: 0.3, acknowledgement: 0.4 };
const EVENT_PAGES = 3;
const MIN_TRUSTED_MERGES = 10;
const AGENT_BRANCH =
  /^(agent|codex|claude|cursor|devin|copilot|jules|bot)[/_-]/i;
const STRUCTURE = [
  /^\s*#{2,3}\s/m,
  /^\s*[-*]\s.+\n\s*[-*]\s/m,
  /\*\*[^*]+\*\*/,
  /```/,
];
const ACKNOWLEDGEMENT = [
  /thanks for (the )?(review|feedback|pointing|catching|flagging|clarif)/i,
  /you'?re (absolutely )?right/i,
  /great catch/i,
  /that makes sense/i,
  /i'?ll (continue|investigate|update|submit|look into|make sure)/i,
  /let me know (if|whether)/i,
  /happy to (update|adjust|revise|change)/i,
  /i understand that/i,
  /thanks for your time/i,
  /just following up/i,
  /hope (this|that) helps/i,
  /please let me know/i,
  /i'?ve (updated|addressed|fixed)/i,
];

const daysBetween = (date, now) => (now - new Date(date)) / 86400000;

// Pull requests closed unmerged elsewhere, recently, from search results.
function rejections(items, author, now) {
  return items
    .filter((item) => {
      const itemOwner = item.repository_url
        .split('/repos/')[1]
        .split('/')[0]
        .toLowerCase();
      return (
        itemOwner !== author.toLowerCase() &&
        item.state === 'closed' &&
        !item.pull_request?.merged_at &&
        daysBetween(item.created_at, now) <= REJECTION_WINDOW_DAYS
      );
    })
    .map((item) => item.html_url);
}

// How their recent comments across GitHub read.
function voice(events) {
  const comments = events
    .filter((event) =>
      ['IssueCommentEvent', 'PullRequestReviewCommentEvent'].includes(
        event.type,
      ),
    )
    .map((event) => event.payload?.comment?.body)
    .filter(Boolean);
  if (comments.length < MIN_COMMENTS) return null;
  const chars = comments.reduce((total, body) => total + body.length, 0);
  const rate = (patterns) =>
    comments.filter((body) => patterns.some((re) => re.test(body))).length /
    comments.length;
  return {
    comments: comments.length,
    structure: rate(STRUCTURE),
    acknowledgement: rate(ACKNOWLEDGEMENT),
    emDashPerKChar:
      (1000 *
        comments.reduce(
          (total, body) => total + (body.match(/—/g) || []).length,
          0,
        )) /
      chars,
  };
}

// How many unrelated projects they open pull requests against in a single
// week. Breadth rather than volume: a focused contributor sends many pull
// requests to few repositories, while an unattended agent sprays a few across
// many. Taken from the event feed, which unlike search covers authors that
// search refuses to return.
function breadth(events, author) {
  if (!events.length) return null;
  const weeks = {};
  for (const event of events) {
    if (event.type !== 'PullRequestEvent' || event.payload?.action !== 'opened')
      continue;
    const name = event.repo?.name;
    if (!name || name.toLowerCase().startsWith(`${author.toLowerCase()}/`))
      continue;
    const week = Math.floor(new Date(event.created_at) / (7 * 86400000));
    weeks[week] ??= new Set();
    weeks[week].add(name);
  }
  return Math.max(0, ...Object.values(weeks).map((repos) => repos.size));
}

const agentBranch = (ref) => AGENT_BRANCH.test(ref || '');

const describeVoice = (metrics) =>
  `${(100 * metrics.structure).toFixed(0)}% structured,` +
  ` ${(100 * metrics.acknowledgement).toFixed(0)}% stock acknowledgements,` +
  ` ${metrics.emDashPerKChar.toFixed(2)} em dashes per 1000 characters`;

// Reasons to close, empty to leave the pull request open. A signal that is
// null could not be measured and abstains.
function verdict(signals) {
  const reasons = [];
  if (signals.rejections && signals.rejections.length >= MIN_REJECTIONS) {
    reasons.push(
      `${signals.rejections.length} PR(s) of theirs closed unmerged elsewhere in the last` +
        ` ${REJECTION_WINDOW_DAYS} days: ${signals.rejections.slice(0, 10).join(' ')}`,
    );
  }
  const { voice } = signals;
  if (
    voice &&
    (voice.structure > VOICE.structure ||
      voice.emDashPerKChar > VOICE.emDashPerKChar ||
      voice.acknowledgement > VOICE.acknowledgement)
  ) {
    reasons.push(
      `comment style over ${voice.comments} recent comments: ${describeVoice(voice)}`,
    );
  }
  if (signals.breadth !== null && signals.breadth > MAX_REPOS_PER_WEEK) {
    reasons.push(
      `opened pull requests against ${signals.breadth} unrelated repositories within a week`,
    );
  }
  if (agentBranch(signals.branch)) {
    reasons.push(`branch name carries an agent prefix: ${signals.branch}`);
  }
  return reasons;
}

module.exports = async ({ github, context, core }, { trustedOrgs, label }) => {
  const { owner, repo } = context.repo;
  const now = new Date();

  // Rate and abuse limits reset on the order of a minute, so waiting is
  // enough; other errors are not worth retrying.
  const retriable = new Set([403, 429, 500, 502, 503, 504]);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function withRetries(description, call) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!retriable.has(error.status) || attempt > RETRIES) throw error;
        const reset =
          Number(error.response?.headers?.['x-ratelimit-reset']) * 1000 -
          Date.now();
        const after = Number(error.response?.headers?.['retry-after']) * 1000;
        const wait = Math.min(
          Math.max(after || reset || RETRY_WAIT_MS, RETRY_WAIT_MS),
          15 * RETRY_WAIT_MS,
        );
        core.info(
          `${description} failed with ${error.status}, retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${RETRIES}).`,
        );
        await sleep(wait);
      }
    }
  }
  // Accounts excluded from search, deleted users and the like leave a signal
  // unmeasurable rather than negative.
  const orNull = (promise) =>
    promise.catch((error) => {
      if ([404, 410, 422].includes(error.status)) return null;
      throw error;
    });

  async function score(pr) {
    const author = pr.user.login;

    // author_association only reports membership of the organisation that
    // owns this repository, and only when it is public, so trust in the
    // author is established here instead.
    const trustedOrg = (
      await Promise.all(
        trustedOrgs.map((org) =>
          orNull(
            withRetries(`Checking public membership of ${org}`, () =>
              github.rest.orgs.checkPublicMembershipForUser({
                org,
                username: author,
              }),
            ),
          ).then((response) => response && org),
        ),
      )
    ).find(Boolean);
    if (trustedOrg) {
      core.info(
        `Skipping PR #${pr.number} by ${author} (public member of ${trustedOrg}).`,
      );
      return;
    }
    // Repeating a qualifier narrows the search instead of widening it, hence
    // the explicit disjunction.
    const trustedMerges = await orNull(
      withRetries('Counting merged PRs in trusted organisations', () =>
        github.rest.search
          .issuesAndPullRequests({
            q:
              `author:${author} type:pr is:merged` +
              ` (${trustedOrgs.map((org) => `org:${org}`).join(' OR ')})`,
            advanced_search: 'true',
            per_page: 1,
          })
          .then((response) => response.data.total_count),
      ),
    );
    if (trustedMerges >= MIN_TRUSTED_MERGES) {
      core.info(
        `Skipping PR #${pr.number} by ${author}` +
          ` (${trustedMerges} PR(s) merged into ${trustedOrgs.join(', ')}).`,
      );
      return;
    }

    const search = await orNull(
      withRetries('Searching for PRs by the author', () =>
        github.rest.search
          .issuesAndPullRequests({
            q: `author:${author} type:pr`,
            advanced_search: 'true',
            sort: 'created',
            order: 'desc',
            per_page: 100,
          })
          .then((response) => response.data),
      ),
    );
    const events = [];
    for (let page = 1; page <= EVENT_PAGES; page++) {
      const batch = await orNull(
        withRetries(`Reading public events page ${page}`, () =>
          github.rest.activity
            .listPublicEventsForUser({
              username: author,
              per_page: 100,
              page,
            })
            .then((response) => response.data),
        ),
      );
      if (!batch?.length) break;
      events.push(...batch);
      if (batch.length < 100) break;
    }
    const signals = {
      rejections: search && rejections(search.items, author, now),
      voice: voice(events),
      breadth: breadth(events, author),
      branch: pr.head?.ref,
    };
    const reasons = verdict(signals);

    await core.summary
      .addHeading(`PR #${pr.number} by ${author}`, 3)
      .addList([
        signals.rejections === null
          ? 'recent rejections elsewhere: unmeasurable, the author cannot be searched'
          : `recent rejections elsewhere: ${signals.rejections.length}`,
        signals.voice === null
          ? `comment style: unmeasurable, fewer than ${MIN_COMMENTS} recent comments found`
          : `comment style: ${describeVoice(signals.voice)} over ${signals.voice.comments} comments`,
        signals.breadth === null
          ? 'repositories per week: unmeasurable, no public events found'
          : `repositories per week, at most: ${signals.breadth}`,
        `branch: ${signals.branch ?? 'unknown'}`,
        `verdict: ${reasons.length ? `closed as ${label}` : 'left open'}`,
      ])
      .addRaw(
        reasons.length
          ? `\n${reasons.map((reason) => `- ${reason}`).join('\n')}\n`
          : '',
      )
      .write();

    if (!reasons.length) {
      core.info(`Leaving PR #${pr.number} open.`);
      return;
    }
    // Adding a missing label only creates it with issues: write, so it is
    // created here, which pull-requests: write allows. 422 means it exists.
    await orNull(
      withRetries('Creating the label', () =>
        github.rest.issues.createLabel({
          owner,
          repo,
          name: label,
          color: '6a4c81',
        }),
      ),
    );
    await withRetries('Adding the label', () =>
      github.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: [label],
      }),
    );
    await withRetries('Closing the PR', () =>
      github.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        state: 'closed',
      }),
    );
    core.info(`Closed PR #${pr.number} as ${label}: ${reasons.join(' | ')}`);
  }

  // A maintainer who has commented on, reviewed or reopened a pull request
  // has already made the call.
  async function attended(pr) {
    const timeline = await withRetries(
      `Reading the timeline of PR #${pr.number}`,
      () =>
        github.paginate(github.rest.issues.listEventsForTimeline, {
          owner,
          repo,
          issue_number: pr.number,
          per_page: 100,
        }),
    );
    return timeline.some(
      (event) =>
        event.event === 'reopened' ||
        (['commented', 'reviewed'].includes(event.event) &&
          event.user?.login !== pr.user.login &&
          event.user?.type !== 'Bot'),
    );
  }

  const opened = context.payload.pull_request;
  const prs = opened
    ? [opened]
    : (
        await withRetries('Listing open PRs', () =>
          github.paginate(github.rest.pulls.list, {
            owner,
            repo,
            state: 'open',
            sort: 'created',
            direction: 'desc',
            per_page: 100,
          }),
        )
      ).filter((pr) => daysBetween(pr.created_at, now) <= RECHECK_WINDOW_DAYS);
  core.info(`Scoring ${prs.length} PR(s).`);
  for (const pr of prs) {
    if (
      pr.user.type === 'Bot' ||
      ['MEMBER', 'OWNER', 'COLLABORATOR'].includes(pr.author_association)
    ) {
      core.info(
        `Skipping PR #${pr.number} by ${pr.user.login} (${pr.user.type}, ${pr.author_association}).`,
      );
      continue;
    }
    if (!opened && (await attended(pr))) {
      core.info(
        `Skipping PR #${pr.number} by ${pr.user.login} (a maintainer has already looked at it).`,
      );
      continue;
    }
    await score(pr);
  }
};

Object.assign(module.exports, {
  rejections,
  voice,
  breadth,
  agentBranch,
  verdict,
});
