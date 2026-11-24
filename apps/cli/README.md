# @jtdeelux/plane-cli

Command line client for a self-hosted [Plane](https://plane.so) server. The binary is `plane`.

## Install

```sh
npm i -g @jtdeelux/plane-cli
plane --version
```

Needs Node.js 20 or newer.

## Log in

```sh
plane auth login
```

The CLI asks for your server URL (or take it from `--url`), prints a confirmation code, and opens `<server>/device` in your browser. Check that the code matches, pick a workspace, and approve. The CLI stores an API token for that workspace. Set `PLANE_BROWSER=none` to print the URL without launching a browser.

On a machine without a browser, or in CI, read a token from stdin instead. `--workspace` is required in this mode:

```sh
echo "$PLANE_TOKEN" | plane auth login --with-token --url https://plane.example.com --workspace acme
```

Other auth commands:

```sh
plane auth status    # show the current login
plane auth token     # print the API token in use
plane auth logout    # remove the stored login
```

### Environment variables

These override the stored login, so you can run without logging in at all:

| Variable          | Meaning        |
| ----------------- | -------------- |
| `PLANE_URL`       | server URL     |
| `PLANE_API_TOKEN` | API token      |
| `PLANE_WORKSPACE` | workspace slug |

### Config file

Logins are stored in `~/.config/plane/config.json` (or `$XDG_CONFIG_HOME/plane/config.json`). The file is written with mode `0600` in a `0700` directory. It contains the API token in plain text.

Each server gets its own profile, keyed by host name. The most recent login is the default. Use the global `--host <host>` option to pick another one:

```sh
plane --host plane.example.com project list
```

`plane config get|set|list` reads and changes settings of the current login (`url`, `workspace`, `project`).

## Commands

```
plane auth login | status | logout | token
plane config get <key> | set <key> <value> | list
plane api <path>
plane project list | view [project] | create | edit [project] | archive [project] | unarchive [project] | delete [project]
plane issue list | view <id> | create | edit <id> | comment <id> | close <id> | reopen <id> | delete <id>
plane issue dependency list <id> | add <id> | remove <id>
plane issue link list <id> | view <id> <link> | add <id> | edit <id> <link> | delete <id> <link>
plane issue activity list <id>
plane comment list <issue> | view <issue> <comment> | edit <issue> <comment> | delete <issue> <comment>
plane cycle list | view <cycle> | create | edit <cycle> | delete <cycle> --yes | complete <cycle>
plane cycle archive <cycle> | unarchive <cycle> | transfer <cycle> --to <cycle> | issues <cycle>
plane cycle add-issue <cycle> --issue <id> | remove-issue <cycle> --issue <id>
plane module list | view <module>
plane state list | view <state> | create | edit <state> | delete <state>
plane label list | view <label> | create | edit <label> | delete <label>
plane member list
```

Global options: `--json`, `-q/--quiet`, `--debug`, `--host <host>`, `-V/--version`, `-h/--help`.

`project`, `cycle`, `module`, `issue`, `comment`, `state`, `label` and `member` commands take `--workspace <slug>`. All except `project` also take `--project` (`issue` accepts an identifier or UUID; `cycle` and `module` also accept a name). Both default to the values in your config (`plane config set project <identifier>`).

```sh
plane project list
plane project view WEB
plane cycle list --project WEB --status current
plane cycle view "Sprint 12" --project WEB --issues --limit 20
plane module list --project WEB
plane state list --project WEB
plane label list --project WEB
plane member list --project WEB
```

### Projects, states and labels

`project create` needs `--name` and `--identifier`. `project edit`, `archive`, `unarchive` and `delete` take the project as an optional argument (identifier, name or UUID), defaulting to the configured project. Deleting or archiving a project only changes data after the server confirms it on read-back.

```sh
plane project create --name "Web App" --identifier WEB --description "Customer web app" --cycles true
plane project edit WEB --name "Web Platform" --timezone Asia/Tokyo
plane project archive WEB
plane project unarchive WEB
plane project delete WEB --yes
```

`state` and `label` commands work on the project from `--project`. Create needs `--name` and `--color`; `state create` also needs `--group` (`backlog|unstarted|started|completed|cancelled`). `--description` and `--description-file` take plain Markdown text.

```sh
plane state create --project WEB --name Review --color "#f59e0b" --group started
plane state edit "Review" --project WEB --default true
plane state delete "Review" --project WEB --yes
plane label create --project WEB --name "needs-design" --color "#5e6ad2"
plane label edit "needs-design" --project WEB --name design
plane label delete design --project WEB --yes
```

`member list` prints the project members. Project, state and label names are matched case-insensitively, like states and labels elsewhere in the CLI.

Deletion requires `--yes` on the `project`, `state` and `label` delete commands; without it the CLI stops before sending anything.

`plane api` calls any endpoint under `/api/v1` and does no Markdown conversion. `-X` sets the method; `-f key=value` adds a field (a JSON body, or the query string for GET):

```sh
plane api workspaces/acme/projects/
plane api -X PATCH -f name=Renamed workspaces/acme/projects/<project-id>/
```

### Issues

Work items are addressed by id, such as `WEB-123`. A bare number works when a default project is set.

```sh
plane issue list --project WEB --state "In Progress" --assignee me --limit 20
plane issue list --project WEB --cycle "Sprint 12" --label bug
plane issue view WEB-123
plane issue view WEB-123 --web
plane issue create --project WEB -t "Fix login redirect" --priority high --assignee me --label bug --body "Steps to reproduce..."
plane issue edit WEB-123 --state Done --remove-label bug --remove-assignee alice
plane issue comment WEB-123 --body-file notes.md
plane issue close WEB-123
plane issue reopen WEB-123
plane issue delete WEB-123 --yes
```

Flags:

- `list`: `--state`, `--assignee` (repeatable), `--label` (repeatable, all must match), `--cycle`, `--module`, `--limit` (default 30), plus `--workspace` and `--project`.
- `view`: `--web` opens the item in your browser.
- `create`: `-t, --title` (required), `--state`, `--priority` (`urgent|high|medium|low|none`), `--assignee` and `--label` (repeatable), `--body`, `--body-file`.
- `edit`: `-t, --title`, `--state`, `--priority`, `--assignee`, `--label`, `--remove-assignee`, `--remove-label` (all repeatable except title, state and priority), `--body`, `--body-file`, `--force`.
- `comment`: `--body`, `--body-file`.
- `close` and `reopen`: move the item to the first completed or unstarted state. `--state <name>` picks a specific state. If the item is already there, the command says so and exits 0.
- `delete`: `--yes` is required.

Names for states, labels and assignees are matched case-insensitively. A near miss prints a "did you mean" hint. `me` as an assignee means the logged-in user.

#### Comments, links, dependencies and activity

```sh
plane comment list WEB-123
plane comment view WEB-123 <comment-id>
plane comment edit WEB-123 <comment-id> --body "Updated text"
plane comment delete WEB-123 <comment-id> --yes

plane issue link list WEB-123
plane issue link add WEB-123 --url https://example.com/design --title Design
plane issue link edit WEB-123 <link-id> --title "Design doc"
plane issue link view WEB-123 <link-id>
plane issue link delete WEB-123 <link-id> --yes

plane issue dependency list WEB-123
plane issue dependency add WEB-123 --target WEB-124 --type blocked_by
plane issue activity list WEB-123
```

- Comment bodies are Markdown and use the same `--body` / `--body-file` rules as issue bodies. Listing and viewing print Markdown; `--json` carries `body_markdown`.
- Link add/edit require an HTTP(S) URL; `--title` is optional. Deletes require `--yes`.
- Dependencies use one of `blocking`, `blocked_by`, `relates_to`, `duplicate`, `start_before`, `start_after`, `finish_before`, `finish_after` (default `blocked_by`). `--target-project` resolves a bare target number from another project. The v1 API has no route to remove a dependency, so `remove` explains that and exits non-zero.
- Activity lists work item changes with the actor, field and old/new value.

`list` filters run in the CLI, because the v1 API has no server-side filters. The CLI pages through the project's items (100 per request) until it has `--limit` matches, so a filter that matches little in a large project can use many requests and hit the 60 per minute API-key limit. The CLI retries on 429; raise `API_KEY_RATE_LIMIT` on your server if it keeps happening.

#### Bodies and Markdown

Issue descriptions and comments are Markdown. The CLI converts them to the HTML that Plane stores when it sends, and back to Markdown when `issue view` prints, so you never handle HTML. `issue view --json` has the converted text in `body_markdown`.

Give a body with one of:

- `--body "text"`
- `--body-file path`
- `--body -` or `--body-file -` to read stdin
- `$VISUAL` or `$EDITOR` (falling back to `vi`), opened when `issue create` or `issue comment` gets no body and the terminal is interactive. `issue edit` never opens an editor; without a body flag it leaves the description alone.

`--body` and `--body-file` cannot be combined, and an empty body is rejected.

Markdown cannot express everything the Plane editor can. Underline, colors, mentions, callouts and embeds are flattened. `issue edit` therefore refuses to replace a description that has such formatting and tells you to re-run with `--force` if you want to overwrite it. Edits that don't pass a body never touch the description.

### Cycles

```sh
plane cycle list --project WEB --status current
plane cycle list --project WEB --archived
plane cycle create --project WEB --name "Sprint 12" --start-date 2026-01-05 --end-date 2026-01-19 --description "Theme: auth"
plane cycle edit "Sprint 12" --project WEB --end-date 2026-01-23
plane cycle complete "Sprint 12" --project WEB
plane cycle archive "Sprint 12" --project WEB
plane cycle unarchive "Sprint 12" --project WEB
plane cycle transfer "Sprint 12" --project WEB --to "Sprint 13"
plane cycle issues "Sprint 12" --project WEB
plane cycle add-issue "Sprint 12" --project WEB --issue WEB-123
plane cycle remove-issue "Sprint 12" --project WEB --issue WEB-123
plane cycle delete "Sprint 12" --project WEB --yes
```

Unless noted, cycles are matched by name or UUID, case-insensitively.

- `create` needs `--name`. `--start-date` and `--end-date` are `YYYY-MM-DD`, and the start cannot be later than the end. `--owned-by` takes a user UUID.
- `edit` takes the same fields. It sends only the flags you pass, keeps the current owner, and reports the fields the server did not apply.
- `complete` ends the cycle now and refuses to run when the start date is still in the future.
- `--archived` on `list` shows archived cycles instead; the `--status` filter does not apply there.
- `delete` requires `--yes`.
- `transfer` moves every issue to the destination cycle; the two cycles must differ.
- `add-issue` and `remove-issue` take the work item id (e.g. `WEB-123`) and check that it belongs to the same project.
- `--description "text"` or `--description-file <path>` (`-` reads stdin) sets the description. Cycle descriptions are plain text, not the rich HTML used by work items.
- Writes read the cycle back before reporting success; `--json` returns the cycle from that read-back.

## Output and exit codes

Commands that change something print one `✓` line to stdout on success. List and view commands print their table or detail text. Failures print one `✗` line to stderr:

```
✓ Logged in as justin (workspace: acme) on plane.example.com
✗ not logged in; run `plane auth login` (or set PLANE_URL and PLANE_API_TOKEN)
```

| Code | Meaning                         |
| ---- | ------------------------------- |
| 0    | success                         |
| 1    | general error                   |
| 2    | usage error (bad flags or args) |
| 3    | authentication failed           |
| 4    | not found                       |
| 5    | rate limited or network failure |

- `--json` prints JSON on stdout. Success is `{"ok": true, "action": ..., "item": ...}`, failure is `{"ok": false, "error": {"code", "message", "status"}}`.
- `-q`, `--quiet` hides the `✓` line. Failures are always printed.
- `--debug` prints HTTP debug logs and stack traces to stderr.

On HTTP 429 the CLI retries, honoring `Retry-After`.

## Self-hosting notes

- The server must run a Plane build that includes the device-flow endpoints, and the web app must serve `/device`. Older servers still work with `--with-token`.
- Behind a reverse proxy, set `NUM_PROXIES` on the API so throttling works per client IP instead of per proxy.
- API tokens are limited to 60 requests per minute by default (`API_KEY_RATE_LIMIT`). Listing many issues can hit this; raise the setting if it does.

## License

AGPL-3.0
