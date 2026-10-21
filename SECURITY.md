# Security

Please report a vulnerability in ravn-hook-echo, or in how Ravn delivers to hooks, to
**security@ravnsecurity.io**. Do not open a public issue for it.

Include what you found, how to reproduce it, and the version (`ravn-hook-echo --help`
prints it at start). We acknowledge within three working days and keep you informed
until it is fixed.

## What this project promises

- A delivery without a valid `x-ravn-signature` is answered `401` and nothing about
  it is stored.
- With `--show-values` off (the default), no viewer response contains a value from
  a delivered packet. A test enforces this with canary strings.
- `--show-values` is refused unless the server is bound to `127.0.0.1` or `::1`.

A way to break any of these is a vulnerability. Please report it.
