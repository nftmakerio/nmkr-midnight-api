# Official proof server 9.0.1, run under qemu-user: the host CPU (Xeon E5-2650 v3,
# Haswell) has no ADX, and the official build uses ADX unconditionally.
FROM midnightntwrk/proof-server:9.0.1
COPY qemu-x86_64 /qemu-x86_64
ENTRYPOINT ["/qemu-x86_64", "-cpu", "max", "/nix/store/yp0l5w0gx8cr996x50f5ymck913m2r9s-ledger-1.0.1/bin/midnight-proof-server"]
CMD ["--port", "6300"]
