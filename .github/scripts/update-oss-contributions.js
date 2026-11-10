const fs = require("fs");
const path = require("path");

const README_PATH = path.join(process.cwd(), "README.md");
const START_MARKER = "<!-- OSS_CONTRIBUTIONS:START -->";
const END_MARKER = "<!-- OSS_CONTRIBUTIONS:END -->";

// Invisible once rendered; documents what the table lists.
const POLICY_COMMENT = "<!-- One row per repository: the most representative merged PR. (+N) = N more merged PRs in that repo. Stats below count public PRs only. -->";

// Star counts and PR status are refreshed from the GitHub API on every run.
// To add a contribution, append { repo, pr, scope } below.
// Add highlight: true to also show it as a badge at the top.
// Example:
//   { repo: "owner/name", pr: 123, scope: "Fix ...", highlight: true },
const contributions = [];

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GH_USER = process.env.GH_USER || "tientham2005";
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "tientham2005-profile-readme",
  "X-GitHub-Api-Version": "2022-11-28",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function githubJson(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${endpoint} failed: ${response.status} ${body}`);
  }
  return response.json();
}

function formatStars(count) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

async function getPrStatus(repo, prNumber, pr) {
  if (pr.merged_at) {
    return "Merged";
  }
  if (pr.state !== "open") {
    return "Closed";
  }

  const reviews = await githubJson(`/repos/${repo}/pulls/${prNumber}/reviews`);
  const hasApproval = reviews.some((review) => review.state === "APPROVED");
  return hasApproval ? "Approved" : "In review";
}

// Merged PRs by this user in the repo, shown as "(+N)". Returns null if search fails.
async function countMergedInRepo(repo) {
  try {
    const q = encodeURIComponent(
      `repo:${repo} type:pr is:merged is:public author:${GH_USER}`,
    ).replace(/%20/g, "+");
    const result = await githubJson(`/search/issues?q=${q}&per_page=1`);
    return typeof result.total_count === "number" ? result.total_count : null;
  } catch (error) {
    console.warn(`countMergedInRepo(${repo}) skipped: ${error.message}`);
    return null;
  }
}

// Merged / in-review / closed counts and repo count over all of this user's
// public PRs (not just the tracked list), for the stats line under the table.
async function getUserPrStats(user) {
  const q = encodeURIComponent(`author:${user} type:pr is:public`).replace(/%20/g, "+");
  const items = [];
  let total = 0;

  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(
      `/search/issues?q=${q}&per_page=100&page=${page}`,
    );
    total = result.total_count;
    items.push(...result.items);
    if (items.length >= total || result.items.length < 100) {
      break;
    }
  }

  const isMerged = (item) =>
    Boolean(item.pull_request && item.pull_request.merged_at);
  const countIf = (predicate) => items.filter(predicate).length;
  const repos = new Set(
    items.map((item) =>
      item.repository_url.replace("https://api.github.com/repos/", ""),
    ),
  );

  return {
    merged: countIf(isMerged),
    inReview: countIf((item) => item.state === "open"),
    closed: countIf((item) => item.state !== "open" && !isMerged(item)),
    repos: repos.size,
    total,
    date: new Date().toISOString().slice(0, 10),
  };
}

function statsLine(stats) {
  return `${stats.merged} merged · ${stats.inReview} in review · ${stats.closed} closed — ${stats.repos} repositories, ${stats.total} PRs · updated ${stats.date}`;
}

function badgeUrl(item) {
  const params = new URLSearchParams({
    label: item.status,
    message: `${item.repo} \u2b50 ${item.stars}`,
    color: item.status === "Merged" ? "2ea44f" : "6f42c1",
    style: "for-the-badge",
    logo: "github",
  });
  return `https://img.shields.io/static/v1?${params.toString()}`;
}

function render(items, stats) {
  const highlighted = items.filter((item) => item.highlight);
  const badges = highlighted
    .map(
      (item) =>
        `  <a href="${item.prUrl}"><img alt="${item.repo} ${item.status} PR" src="${badgeUrl(item)}" /></a>`,
    )
    .join("\n");

  // Placeholder row until the first contribution is added
  const rows = items.length
    ? items
        .map((item) => {
          const more =
            item.status === "Merged" && item.prCount > 1
              ? ` (+${item.prCount - 1})`
              : "";
          return `| ${item.status} | \`${item.repo}\` (${item.stars} stars) | [#${item.pr}](${item.prUrl})${more} | ${item.scope} |`;
        })
        .join("\n")
    : "| 🌱 | First upstream PR in progress | — | — |";

  return [
    START_MARKER,
    "",
    POLICY_COMMENT,
    "",
    ...(badges ? ['<p align="center">', badges, "</p>", ""] : []),
    "| Status | Project | PR | Scope |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    '<p align="center">',
    `<sub>${statsLine(stats)}</sub>`,
    "</p>",
    "",
    END_MARKER,
  ].join("\n");
}

async function main() {
  const items = [];

  for (const contribution of contributions) {
    const [repoInfo, prInfo] = await Promise.all([
      githubJson(`/repos/${contribution.repo}`),
      githubJson(`/repos/${contribution.repo}/pulls/${contribution.pr}`),
    ]);

    const status = await getPrStatus(
      contribution.repo,
      contribution.pr,
      prInfo,
    );

    const prCount =
      status === "Merged" ? await countMergedInRepo(contribution.repo) : null;

    items.push({
      ...contribution,
      status,
      stars: formatStars(repoInfo.stargazers_count),
      prUrl: prInfo.html_url,
      prCount,
    });
  }

  // Only merged PRs get a badge
  items.forEach((item) => {
    if (item.highlight && item.status !== "Merged") {
      item.highlight = false;
    }
  });

  const stats = await getUserPrStats(GH_USER);

  const readme = fs.readFileSync(README_PATH, "utf8");
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end < start) {
    throw new Error("README contribution markers were not found.");
  }

  const before = readme.slice(0, start);
  const after = readme.slice(end + END_MARKER.length);
  fs.writeFileSync(README_PATH, `${before}${render(items, stats)}${after}`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
