# webherd

Herd-style `.test` hostnames for JS dev servers. Laravel Herd gives every parked
PHP app a hostname automatically; webherd does the moral equivalent for
Vite/Next/Angular projects, where a dev server picks its own port and nginx
can't discover it.

Run `webherd` instead of `yarn dev` inside any project under
`~/workspaces/<group>/<parent>/<name>`:

1. Allocates a stable port from the 3100+ block on first run and persists it in
   `~/.config/webherd/registry.json`.
2. Ensures a Herd nginx proxy so `http://<name>.test` reaches the dev server.
   When the folder name exists under more than one parent (or is already
   claimed by a parked/linked Herd site), the hostname becomes
   `<parent>-<name>.test` — so `TeamA/crm-web` and `TeamB/crm-web` can
   never collide.
3. Launches the repo's own `dev` script with the port injected (`PORT` env plus
   `--port/--strictPort` for tools that support it) and warns if the tool
   ignored it.

Projects launched the ordinary way (`yarn dev`) are untouched and keep their
usual 3000+N behavior.

## Commands

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
| `webherd rm` | Unregister the current project and drop its proxy |
| `webherd ui install` | Install the dashboard (one-time) |

## Dashboard

`webherd ui install` (one-time) registers a LaunchAgent, so the dashboard is
always running from then on — there is no app to launch. Open
**http://webherd.test** in a browser: every registered project is listed with
its running state, hostname, port, and https badge, plus Start/Stop buttons
that control the background servers. Background logs live in
`~/.config/webherd/logs/<host>.log`.

Known cosmetic limitation: the services appear in System Settings > Login
Items with their proper `webherd-*` names but a generic `exec` icon and an
"unidentified developer" subtitle. Modern macOS only attributes an item to an
app's name/icon when both carry a matching real signing Team ID — ad-hoc
signatures don't qualify, and shell wrappers can't carry one at all. Signing
with an Apple Developer identity would fix it; functionally nothing is
affected.

## Install

```sh
git clone https://github.com/HamsiTech/webherd.git
cd webherd
ln -s "$(pwd)/webherd.js" /usr/local/bin/webherd   # or any directory on your PATH
webherd ui install                                 # optional: the http://webherd.test dashboard
```

Requirements: macOS, [Laravel Herd](https://herd.laravel.com) (provides nginx
and `.test` DNS on the host), and Node 18+ (runs unchanged on 18/20/22/24 —
no version-specific APIs are used).

Projects are identified as `<root>/<group>/<parent>/<name>`; the root defaults
to `~/workspaces` and can be overridden with the `WEBHERD_ROOT` environment
variable.

Heads-up for content blockers: uBlock Origin's "Block Outsider Intrusion into
LAN" list (and medium/hard dynamic filtering) blocks cross-origin requests to
`.test` hosts because they resolve to loopback — API calls fail with status 0
and a misleading CORS message while direct navigation still works. Add `test`
to uBlock's Trusted sites to exempt all local dev hostnames.

## Android emulator

Herd's dnsmasq answers `*.test` with `127.0.0.1`, which inside an emulator is
the device itself. The companion launchd service in `emulator/` runs a second
dnsmasq on `127.0.0.2:53` answering `*.test -> 10.0.2.2` (the emulator's alias
for the host), so an emulator booted with `-dns-server 127.0.0.2` reaches every
webherd/Herd hostname with no adb port tunnels. See `emulator/README.md`.
