# Emulator DNS companion

Herd's dnsmasq answers `*.test` with `127.0.0.1`. Inside the Android emulator
(a QEMU VM behind NAT) that address is the device itself, so every Herd and
webherd hostname is unreachable. This companion runs a second dnsmasq bound to
`127.0.0.2:53` that answers `*.test -> 10.0.2.2`, the emulator's fixed alias
for the host machine.

Install (asks for sudo — the loopback alias and binding a specific loopback
address on port 53 both need root; dnsmasq drops privileges after binding):

```sh
./install.sh
```

Then boot the emulator with `-dns-server 127.0.0.2` — the `zd-emu` helper does
this. Guest requests to `http://<name>.test` land on the host's nginx (port 80)
with the right Host header: Herd PHP sites, Herd proxies, and webherd projects
all work with zero adb tunnels. HTTPS still requires the guest to trust Herd's
CA, so dev apps should use plain http toward `.test` hosts on Android.
