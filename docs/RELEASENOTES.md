# Release Notes

## Unreleased

### Settings Persistence Across Version Upgrades

Subreddit settings (configured repo names and any custom announcement text) are
now backed up to Redis every time they are read. If a Devvit version upgrade
resets the platform-managed settings back to their defaults, the app
automatically restores the previous values from the backup on the next run.
Moderators no longer need to re-enter their repository list after installing an
update.

**Implementation:** `getSettingWithFallback()` in `src/server/index.ts` wraps
every `settings.get()` call. On a non-empty read it writes `settings_backup:<key>`
to Redis; on an empty read it falls back to that key.

---

### Per-Repository Custom Announcement Text

Each of the five repository slots now has a corresponding **Custom announcement
text** field in the subreddit settings panel. When this field is filled in, its
content is used as the Reddit post body instead of the GitHub release notes.
Leaving the field blank preserves the existing default behaviour (GitHub release
notes are fetched and posted verbatim, subject to relative-link resolution — see
below).

The override text is sanitised before posting:

- Non-printable control characters (except newline, carriage-return, and tab)
  are removed.
- HTML tags are stripped.
- Content is hard-truncated at 39 000 characters (Reddit's self-post body limit)
  with a notice appended if truncation occurs.

---

### Relative Link Resolution in GitHub Release Notes

GitHub release notes often contain relative Markdown links such as
`[Changelog](./CHANGELOG.md)` or `![screenshot](docs/img/screen.png)`. These
render as broken garble on Reddit because Reddit has no concept of a base URL.

The app now rewrites all relative links to absolute GitHub URLs before posting:

| Link type | Resolved to |
|---|---|
| `[text](relative/path)` | `https://github.com/owner/repo/blob/<tag>/relative/path` |
| `![alt](relative/path)` | `https://raw.githubusercontent.com/owner/repo/<tag>/relative/path` |

Images are pointed at `raw.githubusercontent.com` so Reddit can embed them
inline. Regular links are pointed at the blob browser view. Absolute URLs,
`#anchor` links, and `mailto:` links are left untouched.

Leading `./`, `../`, and bare `/` prefixes are normalised away before the
absolute URL is constructed. Note: deep parent-traversal paths (e.g.
`../../some/file`) are flattened rather than resolved relative to a directory
tree, which is sufficient for the paths that appear in practice in release notes.

This rewriting is applied to GitHub release notes only. Custom announcement text
(see above) is posted as-is after sanitisation, since the moderator controls
the content directly.

---

### Repository Name Validation

Repository names entered in settings are now validated against the pattern
`owner/repo` (alphanumeric characters, hyphens, underscores, and dots; no
slashes or other special characters in either segment) before they are used to
construct GitHub API URLs. An invalid entry is logged and skipped rather than
triggering a failed API call.
