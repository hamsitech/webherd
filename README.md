# webherd

Herd-style `.test` hostnames for JS dev servers. Laravel Herd gives every
parked PHP app a hostname automatically; webherd does the moral equivalent for
Vite/Next/Angular/CRA projects, where a dev server picks its own port and
nginx can't discover it.

Park a directory, and every project inside it (any direct subfolder with a
`dev`, `start`, or `serve` script) can be registered with one click:

1. A stable port from the 3100+ block is allocated once and persisted in
   `~/.config/webherd/registry.json`.
2. A Herd nginx proxy makes `http://<name>.test` reach the dev server. When
   the folder name exists under more than one parked path (or is already
   claimed by a Herd site), the hostname becomes `<parent>-<name>.test` — so
   `TeamA/crm-web` and `TeamB/crm-web` can never collide.
3. Starting a project runs the repo's own script (`dev` preferred, then
   `start`, then `serve`) with the port injected (`PORT`/`HOST` env plus
   `--port/--strictPort/--host` for tools that support them), and warns if
   the tool ignored it.

Projects launched the ordinary way (`yarn dev`) are untouched and keep their
usual 3000+N behavior.

## Install

```sh
git clone https://github.com/HamsiTech/webherd.git
cd webherd
ln -s "$(pwd)/webherd.js" /usr/local/bin/webherd   # or any directory on your PATH
webherd ui install                                 # the http://webherd.test dashboard
```

Requirements: macOS, [Laravel Herd](https://herd.laravel.com) (provides nginx
and `.test` DNS on the host), and Node 18+ (runs unchanged on 18/20/22/24 —
no version-specific APIs are used).

The dashboard runs as a LaunchAgent from then on — nothing to launch, just
open **http://webherd.test**. The code executes from this checkout, so after a
`git pull` restart it with
`launchctl kickstart -k gui/$UID/tech.hamsi.webherd.ui`.

## Dashboard

Three tabs:

- **Projects** — every registered project with its running state, path,
  hostname, and port. Per-project controls: Start/Stop, an http/https toggle
  (Herd-CA certificate; plain http stays available for emulators), a log
  viewer (tail of the background log), rename, change port, and unregister.
- **Available** — unregistered runnable projects found under the parked
  paths; one click gives them a hostname.
- **Paths** — the parked directories, Herd-style. "Add path" suggests
  workspace folders that actually contain runnable projects (with counts), or
  takes a custom path.

Actions show a spinner and are serialized so rapid clicks can't double-fire;
failures surface their server message in a dismissible bar. The page talks to
the API directly on `127.0.0.1:3098` (not through nginx), so proxy rebuilds
can't sever in-flight actions. Background logs live in
`~/.config/webherd/logs/<host>.log`. Icons are inlined from Phosphor Icons
(MIT).

## CLI

The CLI mirrors the dashboard; first-time registration also works by just
running `webherd` inside a project (its parent directory is parked
automatically).

| Command | Effect |
| --- | --- |
| `webherd` | Register (first run) and start the current project in the foreground |
| `webherd -- <args>` | Same, forwarding extra args to the dev script |
| `webherd start` | Start the current project in the background (detached, logged) |
| `webherd stop` | Stop the current project's background server |
| `webherd logs` | Print the current project's background log path |
| `webherd list` | Show registered projects, hostnames, ports, running state |
| `webherd secure` / `unsecure` | Toggle https via Herd's CA (http stays on for emulators) |
| `webherd rename <host>` | Change the current project's hostname |
| `webherd port <number>` | Move the current project to another port |
| `webherd rm` | Unregister the current project and drop its proxy |
| `webherd ui install` | Install the dashboard (one-time) |

Configuration lives in `~/.config/webherd/config.json`; the legacy
`~/workspaces/<group>/<parent>/<name>` convention (root overridable via
`WEBHERD_ROOT`) still resolves as a fallback.

## Notes

- **Login Items cosmetics:** the services appear in System Settings with
  their proper `webherd-*` names but a generic `exec` icon and an
  "unidentified developer" subtitle. Modern macOS only attributes an item to
  an app's name/icon when both carry a real signing Team ID — ad-hoc
  signatures don't qualify. Signing with an Apple Developer identity would
  fix it; functionally nothing is affected.
- **Content blockers:** uBlock Origin's "Block Outsider Intrusion into LAN"
  list (and medium/hard dynamic filtering) blocks cross-origin requests to
  `.test` hosts because they resolve to loopback — API calls fail with
  status 0 and a misleading CORS message while direct navigation still works.
  Add `test` to uBlock's Trusted sites to exempt all local dev hostnames.

## Android emulator

Herd's dnsmasq answers `*.test` with `127.0.0.1`, which inside an emulator is
the device itself. The companion launchd service in `emulator/` runs a second
dnsmasq on `127.0.0.2:53` answering `*.test -> 10.0.2.2` (the emulator's alias
for the host), so an emulator booted with `-dns-server 127.0.0.2` reaches every
webherd/Herd hostname with no adb port tunnels. See `emulator/README.md`.
