#!/usr/bin/env bash
# Install the emulator DNS companion:
#  - root LaunchDaemon that aliases 127.0.0.2 onto lo0 at boot
#  - root LaunchDaemon running a dnsmasq that answers *.test -> 10.0.2.2
#    (root because binding a specific loopback address on :53 needs it;
#    dnsmasq drops privileges after binding)
# Boot the emulator with `-dns-server 127.0.0.2` (zd-emu does this).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="/Applications/webherd.app/Contents/MacOS"

# Wrappers live inside webherd.app so the background-items list shows the
# app's name and icon (path-based attribution needs no code signing).
[ -f "/Applications/webherd.app/Contents/Info.plist" ] || bash "$here/../app/install.sh"

herd_dnsmasq="/Applications/Herd.app/Contents/Resources/dnsmasq-$(uname -m)"
[ -x "$herd_dnsmasq" ] || { echo "cannot find Herd's dnsmasq at $herd_dnsmasq — is Laravel Herd installed?" >&2; exit 1; }

mkdir -p "$bin"
cp "$here/dnsmasq-emulator.conf" "$HOME/.config/webherd/dnsmasq-emulator.conf"

cat > "$bin/webherd-emulator-dns" <<WRAP
#!/bin/sh
# Named wrapper so the macOS background-items list shows "webherd-emulator-dns".
exec "$herd_dnsmasq" --keep-in-foreground --conf-file="$HOME/.config/webherd/dnsmasq-emulator.conf"
WRAP

cat > "$bin/webherd-lo0-alias" <<'WRAP'
#!/bin/sh
# Named wrapper so the macOS background-items list shows "webherd-lo0-alias".
exec /sbin/ifconfig lo0 alias 127.0.0.2 up
WRAP
chmod +x "$bin/webherd-emulator-dns" "$bin/webherd-lo0-alias"
codesign -s - --force "$bin/webherd-emulator-dns" "$bin/webherd-lo0-alias" 2>/dev/null || true
codesign -s - --force "/Applications/webherd.app" 2>/dev/null || true

tmp="$(mktemp -d)"
for plist in tech.hamsi.webherd.lo0-alias.plist tech.hamsi.webherd.emulator-dns.plist; do
  sed "s|__HOME__|$HOME|g" "$here/$plist" > "$tmp/$plist"
done

sudo cp "$tmp/tech.hamsi.webherd.lo0-alias.plist" /Library/LaunchDaemons/
sudo launchctl bootout system/tech.hamsi.webherd.lo0-alias 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/tech.hamsi.webherd.lo0-alias.plist 2>/dev/null || true
sudo /sbin/ifconfig lo0 alias 127.0.0.2 up

sudo cp "$tmp/tech.hamsi.webherd.emulator-dns.plist" /Library/LaunchDaemons/
sudo launchctl bootout system/tech.hamsi.webherd.emulator-dns 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/tech.hamsi.webherd.emulator-dns.plist

sleep 1
dig +short +time=2 anything.test @127.0.0.2
echo "ok: *.test resolves to 10.0.2.2 for the emulator"
