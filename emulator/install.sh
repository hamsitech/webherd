#!/usr/bin/env bash
# Install the emulator DNS companion:
#  - root LaunchDaemon that aliases 127.0.0.2 onto lo0 at boot
#  - user LaunchAgent running a dnsmasq that answers *.test -> 10.0.2.2
# Boot the emulator with `-dns-server 127.0.0.2` (zd-emu does this).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.config/webherd"
cp "$here/dnsmasq-emulator.conf" "$HOME/.config/webherd/dnsmasq-emulator.conf"

sudo cp "$here/com.hamsitech.webherd.lo0-alias.plist" /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.hamsitech.webherd.lo0-alias.plist 2>/dev/null || true
sudo /sbin/ifconfig lo0 alias 127.0.0.2 up

# Binding a specific loopback address on port 53 needs root (only wildcard
# low-port binds are exempt on macOS), so the dnsmasq runs as a LaunchDaemon
# and drops privileges itself.
launchctl bootout "gui/$(id -u)/com.hamsitech.webherd.emulator-dns" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.hamsitech.webherd.emulator-dns.plist"
sudo cp "$here/com.hamsitech.webherd.emulator-dns.plist" /Library/LaunchDaemons/
sudo launchctl bootout system/com.hamsitech.webherd.emulator-dns 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/com.hamsitech.webherd.emulator-dns.plist

sleep 1
dig +short +time=2 anything.test @127.0.0.2
echo "ok: *.test resolves to 10.0.2.2 for the emulator"
