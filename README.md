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
   `<parent>-<name>.test` — so `ZDonusum/crm-web` and `KolayBi/crm-web` can
   never collide.
3. Launches the repo's own `dev` script with the port injected (`PORT` env plus
   `--port/--strictPort` for tools that support it) and warns if the tool
   ignored it.

Projects launched the ordinary way (`yarn dev`) are untouched and keep their
usual 3000+N behavior.

## Commands

| Command | Effect |
| --- | --- |
| `webherd` | Register (first run) and start the current project |
| `webherd -- <args>` | Same, forwarding extra args to the dev script |
| `webherd list` | Show registered projects, hostnames, ports, running state |
| `webherd rename <host>` | Change the current project's hostname |
| `webherd rm` | Unregister the current project and drop its proxy |

## Install

```sh
ln -s "$(pwd)/webherd.js" ~/bin/webherd
```

Requires Laravel Herd (for nginx + `.test` DNS on the host) and Node 18+.

## Android emulator

Herd's dnsmasq answers `*.test` with `127.0.0.1`, which inside an emulator is
the device itself. The companion launchd service in `emulator/` runs a second
dnsmasq on `127.0.0.2:53` answering `*.test -> 10.0.2.2` (the emulator's alias
for the host), so an emulator booted with `-dns-server 127.0.0.2` reaches every
webherd/Herd hostname with no adb port tunnels. See `emulator/README.md`.
