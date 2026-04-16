import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { context, reddit, redis, settings, createServer, getServerPort } from '@devvit/web/server';
import type { PartialJsonValue, UiResponse } from '@devvit/web/shared';

type ErrorResponse = { error: string; status: number };

const REPO_SLOTS = [
  'githubRepo1', 'githubRepo2', 'githubRepo3', 'githubRepo4', 'githubRepo5',
] as const;

const OVERRIDE_SLOTS = [
  'overrideText1', 'overrideText2', 'overrideText3', 'overrideText4', 'overrideText5',
] as const;

/** Redis key prefix used to back up settings so they survive version-upgrade resets. */
const SETTINGS_BACKUP_PREFIX = 'settings_backup:';

/** Hard cap matching Reddit's self-post body limit. */
const MAX_TEXT_LEN = 39_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function writeJSON<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json);
  const len = Buffer.byteLength(body);
  rsp.writeHead(status, { 'Content-Length': len, 'Content-Type': 'application/json' });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  await once(req, 'end');
  return JSON.parse(`${Buffer.concat(chunks)}`);
}

/**
 * Reads a string setting and simultaneously keeps a Redis backup of the last
 * non-empty value.  When Devvit resets settings to their defaults on a version
 * upgrade the backup lets us restore the previous value transparently.
 */
async function getSettingWithFallback(key: string): Promise<string> {
  const raw = await settings.get(key) as string | undefined;
  const trimmed = raw?.trim() ?? '';

  if (trimmed !== '') {
    // Store a fresh backup every time we see a real value.
    await redis.set(`${SETTINGS_BACKUP_PREFIX}${key}`, trimmed);
    return trimmed;
  }

  // Setting is empty (likely a post-upgrade reset) — try the Redis backup.
  return (await redis.get(`${SETTINGS_BACKUP_PREFIX}${key}`)) ?? '';
}

/**
 * Validates that a repo string looks like "owner/repo" with safe characters.
 * Guards against path-traversal or injection via the GitHub API URL.
 */
function isValidRepo(repo: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(repo);
}

/**
 * Sanitizes moderator-supplied override text before it is posted to Reddit.
 *
 * - Removes HTML tags (Reddit's markdown renderer ignores them, but better safe
 *   than sorry if a future renderer changes).
 * - Strips non-printable control characters (keeps \n, \r, \t).
 * - Truncates to Reddit's post-body limit.
 */
function sanitizeText(text: string): string {
  // Drop non-printable control characters except newline / carriage-return / tab.
  let s = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Strip HTML tags so a bad actor can't inject raw HTML into the Reddit post.
  s = s.replace(/<[^>]*>/g, '');
  if (s.length > MAX_TEXT_LEN) {
    s = s.substring(0, MAX_TEXT_LEN) + '\n\n*(announcement text truncated)*';
  }
  return s;
}

/**
 * Converts relative Markdown links found in GitHub release notes into absolute
 * GitHub URLs so they render correctly on Reddit instead of appearing as
 * broken garble.
 *
 * Rules:
 *  - Image links  ![alt](relative)  →  raw.githubusercontent.com URL
 *  - Regular links [text](relative) →  github.com/blob/<tag>/... URL
 *  - Absolute URLs, anchors (#…), and mailto: links are left untouched.
 *  - Leading ./  ../  or /  prefixes are normalised away before building the
 *    absolute URL (simple flatten; deep ../../ traversal is not supported
 *    because GitHub release notes virtually never use it).
 */
function resolveRelativeLinks(body: string, repo: string, tag: string): string {
  const [owner, repoName] = repo.split('/');

  // Single-pass regex handles both ![img](url) and [text](url).
  // Group 1: optional leading '!' (distinguishes image from link)
  // Group 2: alt / link text  (anything except ']')
  // Group 3: URL              (anything except ')')
  return body.replace(/(!)?\[([^\]]*)\]\(([^)]+)\)/g, (match, bang, text, url) => {
    const trimmedUrl = url.trim();

    // Leave absolute URLs, protocol-relative URLs, anchors, and mailto alone.
    if (/^(https?:\/\/|ftp:\/\/|\/\/|#|mailto:)/i.test(trimmedUrl)) {
      return match;
    }

    // Normalise: strip leading ./, ../, or / so we have a clean relative path.
    const cleanPath = trimmedUrl
      .replace(/^(\.\.?\/)+/, '') // strip leading ../ or ./  (repeated)
      .replace(/^\//, '');        // strip bare leading /

    if (bang === '!') {
      // Images: raw CDN so Reddit can embed them inline.
      return `![${text}](https://raw.githubusercontent.com/${owner}/${repoName}/${tag}/${cleanPath})`;
    }

    // Regular links: blob browser view.
    return `[${text}](https://github.com/${owner}/${repoName}/blob/${tag}/${cleanPath})`;
  });
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function checkRepo(
  githubRepo: string,
  overrideText: string,
): Promise<{ posted: boolean; message: string }> {
  if (!isValidRepo(githubRepo)) {
    console.warn(`[${githubRepo}] Skipped — invalid repo format`);
    return { posted: false, message: `Invalid repo format: ${githubRepo}` };
  }

  const repoName = githubRepo.split('/')[1];
  const REDIS_KEY = `last_known_release:${githubRepo}`;

  const response = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
    headers: { 'Accept': 'application/vnd.github+json' },
  });

  console.log(`[${githubRepo}] GitHub response status =`, response.status);

  if (!response.ok) {
    return { posted: false, message: `GitHub fetch failed for ${githubRepo}` };
  }

  const release = await response.json();
  const latestTag = release.tag_name;
  const lastKnownTag = await redis.get(REDIS_KEY);

  console.log(`[${githubRepo}] latestTag =`, latestTag, '| lastKnownTag =', lastKnownTag);

  if (latestTag === lastKnownTag) {
    console.log(`[${githubRepo}] No new release`);
    return { posted: false, message: `No new release for ${githubRepo}` };
  }

  await redis.set(REDIS_KEY, latestTag);

  const { subredditName } = context;
  console.log(`[${githubRepo}] Submitting post to`, subredditName);

  const promo =
    `\n\n---\n\nModerators: Want automated GitHub release posts like this? ` +
    `Install [Release Announce](https://developers.reddit.com/apps/release-announce) ` +
    `to use it in your subreddit.`;

  let postBody: string;

  if (overrideText.trim() !== '') {
    // Moderator supplied custom text — sanitize and use as-is.
    postBody = sanitizeText(overrideText);
  } else {
    // Default: use GitHub release notes with relative links resolved.
    const releaseBody = (release.body as string | null) ?? 'No release notes provided.';
    postBody = resolveRelativeLinks(releaseBody, githubRepo, latestTag);
  }

  await reddit.submitPost({
    subredditName,
    title: `${repoName} Release: ${release.tag_name}`,
    text: `${postBody}${promo}`,
  });

  return { posted: true, message: `Posted release ${latestTag} for ${repoName}` };
}

async function handleCheckReleases(): Promise<UiResponse | { status: string; message: string }> {
  console.log('check-releases triggered');

  const [repoValues, overrideValues] = await Promise.all([
    Promise.all(REPO_SLOTS.map((slot) => getSettingWithFallback(slot))),
    Promise.all(OVERRIDE_SLOTS.map((slot) => getSettingWithFallback(slot))),
  ]);

  const activeRepos = repoValues
    .map((repo, i) => ({ repo: repo.trim(), override: overrideValues[i]?.trim() ?? '' }))
    .filter(({ repo }) => repo !== '');

  console.log('Active repos:', activeRepos.map((r) => r.repo));

  if (activeRepos.length === 0) {
    console.log('No repos configured');
    return { showToast: { text: 'No GitHub repos configured', appearance: 'neutral' } };
  }

  const results = await Promise.all(
    activeRepos.map(({ repo, override }) => checkRepo(repo, override)),
  );

  const posted = results.filter((r) => r.posted);
  const messages = results.map((r) => r.message).join('; ');
  console.log('Results:', messages);

  if (posted.length > 0) {
    return { showToast: { text: `Posted ${posted.length} new release(s)!`, appearance: 'success' } };
  }

  return { showToast: { text: 'No new releases found', appearance: 'neutral' } };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function onRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  const { url } = req;

  if (!url) {
    writeJSON<ErrorResponse>(404, { error: 'not found', status: 404 }, rsp);
    return;
  }

  if (
    url === '/internal/menu/check-releases' ||
    url === '/internal/scheduler/check-releases'
  ) {
    const result = await handleCheckReleases();
    writeJSON<PartialJsonValue>(200, result as PartialJsonValue, rsp);
    return;
  }

  writeJSON<ErrorResponse>(404, { error: 'not found', status: 404 }, rsp);
}

async function serverOnRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON<ErrorResponse>(500, { error: msg, status: 500 }, rsp);
  }
}

const server = createServer(serverOnRequest);
server.on('error', (err) => console.error(`server error; ${err.stack}`));
server.listen(getServerPort());
