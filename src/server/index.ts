import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { context, reddit, redis, settings, createServer, getServerPort } from '@devvit/web/server';
import type { PartialJsonValue, UiResponse } from '@devvit/web/shared';

type ErrorResponse = { error: string; status: number };

const REPO_SLOTS = ['githubRepo1', 'githubRepo2', 'githubRepo3', 'githubRepo4', 'githubRepo5'] as const;

function writeJSON<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json);
  const len = Buffer.byteLength(body);
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  await once(req, 'end');
  return JSON.parse(`${Buffer.concat(chunks)}`);
}

async function checkRepo(githubRepo: string): Promise<{ posted: boolean; message: string }> {
  const repoName = githubRepo.split('/')[1];
  const REDIS_KEY = `last_known_release:${githubRepo}`;

  const response = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
    headers: { 'Accept': 'application/vnd.github+json' }
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

  const promo = `\n\n---\n\nModerators: Want automated GitHub release posts like this? Install [Release Announce](https://developers.reddit.com/apps/release-announce) to use it in your subreddit.`;

  const releaseBody = release.body ?? 'No release notes provided.';

  await reddit.submitPost({
    subredditName,
    title: `${repoName} Release: ${release.tag_name}`,
    text: `${releaseBody}${promo}`,
  });

  return { posted: true, message: `Posted release ${latestTag} for ${repoName}` };
}

async function handleCheckReleases(): Promise<UiResponse | { status: string; message: string }> {
  console.log('check-releases triggered');

  const repoValues = await Promise.all(REPO_SLOTS.map(slot => settings.get(slot)));
  const activeRepos = repoValues.filter((r): r is string => !!r && r.trim() !== '');

  console.log('Active repos:', activeRepos);

  if (activeRepos.length === 0) {
    console.log('No repos configured');
    return { showToast: { text: 'No GitHub repos configured', appearance: 'neutral' } };
  }

  const results = await Promise.all(activeRepos.map(repo => checkRepo(repo)));
  const posted = results.filter(r => r.posted);
  const messages = results.map(r => r.message).join('; ');

  console.log('Results:', messages);

  if (posted.length > 0) {
    return { showToast: { text: `Posted ${posted.length} new release(s)!`, appearance: 'success' } };
  }

  return { showToast: { text: 'No new releases found', appearance: 'neutral' } };
}

async function onRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  const url = req.url;

  if (!url) {
    writeJSON<ErrorResponse>(404, { error: 'not found', status: 404 }, rsp);
    return;
  }

  if (url === '/internal/menu/check-releases' || url === '/internal/scheduler/check-releases') {
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
