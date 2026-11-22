# Plan: `@jtdeelux/plane-cli` (`plane` command)

A TypeScript/Node CLI installed with `npm i -g @jtdeelux/plane-cli` that connects to a self-hosted Plane server, in the style of `gh`. Users write **Markdown**; the CLI converts to and from the HTML the Plane API uses.

## Decisions

| Topic          | Choice                                                                |
| -------------- | --------------------------------------------------------------------- |
| Login          | Browser device flow (needs new backend endpoints)                     |
| v1 scope       | `auth`, `config`, `issue`, `project`, `cycle`, `module`, `api`        |
| Location       | `apps/cli`, package `@jtdeelux/plane-cli`, bin `plane`                |
| Publishing     | Public npm, GitHub Actions workflow on tag                            |
| Content format | Markdown in the CLI, HTML on the wire, via a conversion layer (below) |

## Assumptions (tell me to change any)

- The user supplies **one URL**: the Plane web URL (e.g. `https://plane.example.com`). The CLI calls `<url>/api/...`, which matches the default reverse proxy setup.
- Data commands use `/api/v1/` (`X-Api-Key` header, default rate limit 60/min) and the `work-items` endpoints, not the older `issues` ones.
- Token is stored in `~/.config/plane/config.json` with mode `0600`. No OS keychain yet: native modules make `npm -g` installs fragile. Upgrade later if needed.
- Runtime deps kept small: `commander`, `open`, `@inquirer/prompts`; everything else uses Node 20+ built-in `fetch`. Built with `tsdown` (ESM).
- The CLI never touches the database; everything goes over HTTP.

## Connection UX

```
$ plane auth login
? Plane server URL: https://plane.example.com
! Confirmation code: ABCD-EFGH
  Opening https://plane.example.com/device?user_code=ABCD-EFGH in your browser...
  If it does not open, visit https://plane.example.com/device and enter the code
✓ Logged in as justin (workspace: acme)
```

- `plane auth login [--url <url>] [--with-token]`. `--with-token` reads a token from stdin (CI, headless machines). Env overrides: `PLANE_URL`, `PLANE_API_TOKEN`, `PLANE_WORKSPACE`.
- `plane auth status | logout | token`.
- Multiple servers via profiles (`--host`); default is the most recently logged-in one.
- Friendly errors: wrong URL (not a Plane server: hint to check `/api/instances/`), expired token ("run `plane auth login`"), 429 (auto-retry honoring `Retry-After`).

## Part 1: Markdown <-> HTML conversion layer

Plane stores rich text as HTML produced by the TipTap editor (`description_html`, comment `comment_html`). The CLI must never expose that HTML.

**Existing code to reuse.** `packages/utils/src/editor/markdown-parser/` already converts TipTap HTML to Markdown (`rehype-parse` -> `rehype-remark` -> `remark-gfm` -> `remark-stringify`), including task lists, marks, and custom components. It is one-way only, and `@plane/utils` pulls in React and other web-only deps, which we don't want in a CLI.

**Plan.**

1. Extract that folder into a small react-free package `packages/markdown` (`@plane/markdown`) and make `@plane/utils` re-export it, so web behaviour does not change. The CLI bundles it via `tsdown` (`noExternal`), so the published package has no workspace dependency.
2. Add the missing direction `markdownToHtml(md)` in the same package: `unified` + `remark-parse` + `remark-gfm` + `remark-rehype` + `rehype-stringify`, with handlers that emit what TipTap expects so the web editor renders it correctly:
   - Task lists -> `<ul data-type="taskList"><li data-type="taskItem" data-checked="true|false"><label><input type="checkbox"><span></span></label><div><p>text</p></div></li></ul>`
   - Code blocks -> `<pre><code class="language-x">`
   - Tables, blockquotes, headings, lists, links, bold/italic/strike/inline code: standard HTML
   - Images: Markdown `![alt](url)` -> plain `<img>` (v1 does not upload assets; external URLs only)
3. Public API: `htmlToMarkdown(html)` and `markdownToHtml(md)`. Both pure, sync-friendly, no I/O.
4. **Lossy cases are explicit, not silent.** HTML with no Markdown equivalent (underline, colors, mentions, callouts, embeds, custom components) is preserved on read as a readable placeholder (e.g. `@username`, or raw HTML kept inline) and the CLI warns on `issue edit` when the existing body contains constructs it would flatten, offering `--force`. Edits that don't touch the description never resend it.
5. XSS/safety: sanitize generated HTML with the same `sanitize-html` settings the web app uses before sending; the server also sanitizes, this is defense in depth.

**Tests** (vitest, already in the catalog): round-trip fixtures (`md -> html -> md` stable for the supported subset), TipTap-produced HTML fixtures copied from real issues (task lists, nested lists, code, tables), lossy-case warnings, and a snapshot that the HTML we emit matches TipTap's task list structure.

CLI usage: `issue create/edit/comment` run `markdownToHtml` before sending; `issue view` runs `htmlToMarkdown` before printing. `--body`, `--body-file`, `-` (stdin), or `$EDITOR` supply Markdown.

## Part 2: backend device flow (`apps/api`)

Follows RFC 8628, trimmed.

**New model** `DeviceAuthorization` (`apps/api/plane/db/models/`): `device_code_hash`, `user_code`, `status` (pending/approved/denied), `user` (null until approved), `workspace` (nullable), `token` (the created APIToken, cleared once delivered), `expires_at` (10 minutes), `last_polled_at`, `client_name`.
Migration: `uv run python manage.py makemigrations db -n device_authorization` (lockfile updates automatically; commit together).

**Endpoints**

| Method | Path                                     | Auth                               | Purpose                                                                                                                     |
| ------ | ---------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/device/code/`                     | public, per-IP throttle            | Create record; return `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval` (5s)                         |
| POST   | `/auth/device/token/`                    | public, per-`device_code` throttle | Return `authorization_pending` / `slow_down` / `access_denied` / `expired_token`, or `{token, workspace_slug}` exactly once |
| GET    | `/api/users/device/<user_code>/`         | session                            | Show client name, let the page pick a workspace                                                                             |
| POST   | `/api/users/device/<user_code>/approve/` | session                            | Create an `APIToken` for the current user (label `plane-cli@<hostname>`) and attach it                                      |
| POST   | `/api/users/device/<user_code>/deny/`    | session                            | Deny                                                                                                                        |

Security: `device_code` is at least 32 random bytes and stored hashed; `user_code` is 8 unambiguous characters (no 0/O/1/I) with a cap on guess attempts; token is returned once then removed from the record; expired rows cleaned lazily on poll or via an existing celery task. Created tokens show in the user's API tokens page so they can be revoked.

**Backend tests** (pytest in Docker): pending -> approved -> single delivery, expiry, deny, `slow_down`, wrong `user_code`, throttling.

## Part 3: confirmation page (`apps/web`)

Route `/device`: enter or receive `?user_code=`; if signed out, go through sign-in and return; show "The CLI on `<hostname>` is requesting access to your account", a workspace dropdown, Approve and Deny buttons. Built with `@makeplane/propel` and `@plane/blocks`. Add strings to `packages/i18n` (`en` is the source; use the `translate` skill for other locales; run `pnpm --filter=@plane/i18n sync:check`).

## Part 4: the CLI (`apps/cli`)

```
apps/cli/
  package.json        # name @jtdeelux/plane-cli, bin {plane: dist/index.js}, files [dist], engines node>=20
  tsconfig.json  tsdown.config.ts
  src/
    index.ts          # commander root, shebang
    config.ts         # read/write config, env overrides, profiles
    client.ts         # fetch wrapper: base URL, X-Api-Key, 429 retry, typed errors, pagination
    auth/device.ts    # device flow + polling
    commands/{auth,config,issue,project,cycle,module,api}.ts
    format.ts         # tables on TTY, --json for scripts, no color when not a TTY
  tests/
```

**Commands (v1)**

- `auth login|logout|status|token`
- `config get|set|list` (`workspace`, `project`, `url`)
- `issue list|view|create|edit|comment|close|reopen`: filters `--state --assignee --label --cycle --module`; `view` accepts `PROJ-123`; `--web` opens the browser; bodies are Markdown (Part 1)
- `project list|view`
- `cycle list|view` (`--issues`)
- `module list|view` (`--issues`)
- `api <path> [-X METHOD] [-f key=val]`: raw call like `gh api`, the escape hatch for anything v1 doesn't cover. Raw mode does **no** conversion.
- All data commands support `--json` and `--workspace/--project` overrides. `--json` returns the API's HTML untouched plus a `body_markdown` field for convenience.

**CLI tests**: unit tests for `config`, `client` (retry, errors), `device` (polling with fake timers), `PROJ-123` parsing, name->id resolution; a smoke test running the built bin with `--help` and `auth status` while logged out.

## Part 4b: output and exit-code contract (applies to every command)

No command may finish silently. Every write (create, edit, comment, close, reopen, delete, login, logout, `config set`) must say what happened.

- **Success**: print one line naming the action, the object, and a way to find it, then exit `0`. Examples: `✓ Created PROJ-123 "Fix login" https://plane.example.com/acme/browse/PROJ-123`, `✓ Updated PROJ-123: state Todo -> Done, 1 label added`, `✓ Commented on PROJ-123`, `✓ Logged out of plane.example.com`.
- **No-op**: if nothing changed (same values, already closed), say so and exit `0`: `PROJ-123 is already Done, nothing to change`. Never print nothing.
- **Failure**: print `✗ <what failed>: <reason from the server, e.g. 403 Forbidden / state "Doing" not found, did you mean "In Progress"?>` to **stderr** and exit non-zero (`1` general, `2` usage error, `3` auth error, `4` not found, `5` rate limited / network). No stack traces unless `--debug`.
- **Verified writes**: after a POST/PATCH the CLI checks the response status and that the returned object has the expected id/fields. An empty or malformed 2xx body is treated as a failure, not a success. For edits it reports the fields that actually changed (diff of before/after).
- **Partial failure** (e.g. create succeeded but adding a label failed): report both, exit non-zero, and print the created object so nothing is lost.
- **`--json`**: writes return the resulting object on success (`{ "ok": true, "action": "created", "item": {...} }`), and on failure `{ "ok": false, "error": { "code", "message", "status" } }` on stdout with the same non-zero exit code. List commands with no results print `No issues match` (human) or `[]` (`--json`), never blank output.
- `--quiet` suppresses the success line only; failures are always printed.
- Tests: for every write command assert the success line, the no-op line, the failure line + exit code, and that an empty 2xx response is reported as a failure.

## Part 5: publishing

- `package.json`: `publishConfig.access=public`, `files`, `repository`, AGPL-3.0 license (matches the repo), short README (install, login, examples).
- `.github/workflows/publish-cli.yml`: on tag `cli-v*`, run `pnpm --filter=@jtdeelux/plane-cli build && npm publish --provenance`. Needs an `NPM_TOKEN` secret and publish rights to the `@jtdeelux` scope.
- Every new `.ts`/`.py` file gets the `COPYRIGHT.txt` header. Run `pnpm check` before opening PRs against `preview`.

## Order of work (one PR each, some can merge)

1. `packages/markdown`: extract existing HTML->Markdown, add Markdown->HTML, tests. `@plane/utils` re-exports; web unchanged.
2. `apps/cli` skeleton + `client` + `config` + `auth login --with-token` + `auth status` + `api`, so it runs against a real server with a pasted token.
3. Backend device flow + tests. (Independent of 1 and 2; can run in parallel.)
4. `/device` web page + i18n.
5. CLI `auth login` using the device flow.
6. `issue` commands (uses the conversion layer), then `project`, `cycle`, `module`.
7. README, publish workflow, verify with `npm pack` and `npm i -g` from the tarball.

## Risks and open items

- The `@plane` npm scope may not be publishable by you. If not, rename the package.
- v1 has no endpoint to list workspaces. Device flow solves it by choosing the workspace on the approval page; `--with-token` requires `--workspace`.
- v1 accepts UUIDs for state and labels, so the CLI resolves names to ids via `states/` and `labels/` and caches them briefly.
- Markdown cannot express everything TipTap can (see lossy cases in Part 1). Editing an issue authored in the web editor with rich formatting is the main fidelity risk, hence the warning and `--force`.
- The 60/min API key limit can be hit when paginating `--issues`; the client retries, and you can raise `API_KEY_RATE_LIMIT` on your server.
