# @plane/cli

Command line client for a self-hosted [Plane](https://plane.so) server. The binary is `plane`.

## Install

```sh
npm i -g @plane/cli
plane --version
```

Needs Node.js 20 or newer.

## Log in

```sh
plane auth login
```

The CLI asks for your server URL (or take it from `--url`), prints a confirmation code, and opens `<server>/device` in your browser. Check that the code matches, pick a workspace, and approve. The CLI stores an API token for that workspace.

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
plane project list | view [project]
plane cycle list | view <cycle>
plane module list | view <module>
```

Global options: `--json`, `-q/--quiet`, `--debug`, `--host <host>`, `-V/--version`, `-h/--help`.

`project`, `cycle` and `module` commands take `--workspace <slug>`. `cycle` and `module` also take `--project <project>` (identifier, name or UUID). Both default to the values in your config (`plane config set project <identifier>`).

```sh
plane project list
plane project view WEB
plane cycle list --project WEB --status current
plane cycle view "Sprint 12" --project WEB --issues --limit 20
plane module list --project WEB
```

`plane api` calls any endpoint under `/api/v1` and does no Markdown conversion. `-X` sets the method; `-f key=value` adds a field (a JSON body, or the query string for GET):

```sh
plane api workspaces/acme/projects/
plane api -X PATCH -f name=Renamed workspaces/acme/projects/<project-id>/
```

### Issues

The `issue` commands are not in this release yet. They are in a separate pull request and this section describes the plan, not the current binary. When they land, issue and comment bodies are Markdown (`--body`, `--body-file`, or stdin) and the CLI converts them to and from the HTML that Plane stores, so you never see HTML.

Markdown cannot express everything the Plane editor can. Underline, colors, mentions, callouts and embeds are shown as plain text or inline HTML when you read an issue. Before an edit would flatten such content, the CLI warns and asks you to pass `--force`.

## Output and exit codes

Each command prints one line to stdout on success and one to stderr on failure:

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
