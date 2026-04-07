# release-announce

A Devvit app that automatically announces new GitHub releases to your subreddit.

## Features

- Polls GitHub for new releases on an hourly schedule
- Posts a release announcement to your subreddit when a new version is detected
- Moderators can manually trigger a release check via the subreddit menu
- Configurable per-subreddit via install settings

## Setup

1. Install the app on your subreddit via [this page](https://developers.reddit.com/apps/release-announce).
2. Navigate to the app settings page:
   `https://developers.reddit.com/r/{your-subreddit}/apps/release-announce`
3. Enter your GitHub repositories in `owner/repo` format (e.g. `drworman/release-announce`)
4. The app will check for new releases hourly and post automatically

## Manual Trigger

Moderators can click **"Check for New Release"** in the subreddit overflow menu to trigger an immediate check.

## Permissions Required

- Reddit API (post submission)
- Redis (release version tracking)
- HTTP fetch to `api.github.com`
