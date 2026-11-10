# Proof server (Ledger 9)

The official image `midnightntwrk/proof-server:9.0.1` crashes with `invalid opcode` on this
host: the CPU (Xeon E5-2650 v3, Haswell) has no ADX, and the official build uses ADX
instructions unconditionally. The same applies to `zkir-v3` from compactc 0.36.0 (key
generation).

Workaround: run the unchanged official binary under qemu-user (`-cpu max` emulates ADX).
A deploy proof takes about 12 s and a mint about 70 s in total.

```
sudo apt-get install -y qemu-user docker.io
cp /usr/bin/qemu-x86_64 .            # static-pie, works inside the nix-based image
sudo docker build -t nmkr/proof-server-emu:9.0.1 .
sudo docker run -d --name midnight-proof-server --restart unless-stopped \
  -p 127.0.0.1:6300:6300 nmkr/proof-server-emu:9.0.1
```

APIs use `"proofServer": "http://127.0.0.1:6300"`. On a host with ADX (Broadwell or newer),
use the official image directly.

Contract compile (compactc 0.36.0, keys generated with emulated zkir):
`/opt/nmkr/tools/compactc-0.36.0-emu/compactc contracts/<c>.compact contracts/managed/<c>`.
