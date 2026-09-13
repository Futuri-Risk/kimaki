---
'kimaki': minor
---

Add a `/rename` command that manually renames a thread applying the `{TAG} T#n: {title}` convention.

- `/rename` with no args scans recent thread messages for a ticket reference (`owner/repo#n`, `repo#n`, or a Gitea issue URL). If found, it fetches the issue title from the Gitea API (`GITEA_URL`, `GITEA_TOKEN` env; defaults to `http://127.0.0.1:3000` / org `projects`) and renames deterministically — zero LLM cost.
- Without a ticket reference (or if the API is unreachable), it falls back to one cheap Gemini flash call using the key already configured for voice transcription (`/gemini-apikey` or `GEMINI_API_KEY`).
- `/rename name:<text>` renames directly with no model call.

Preserved thread prefixes (`⬦ `, `btw: `, `Fork: `) survive the rename. Rate-limit aware: fails soft with a notice (Discord allows ~2 thread renames per 10 minutes). Kimaki's session-title sync already respects any non-synced rename, so one invocation per thread is permanent.
