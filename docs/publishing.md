# Publishing

Two packages, published separately. `@anandman/courier` depends on
`jmap-courier`, so that one goes first — a release that reverses the order
produces a package nobody can install.

## One-time

```bash
npm login
```

Scoped packages default to `restricted`, which fails on a free account. The
`publishConfig.access: "public"` in package.json covers that; it is not a flag
to remember.

## Releasing

```bash
# 1. The client library first.
cd jmap-courier
npm version patch          # or minor / major
npm publish                # prepublishOnly builds

# 2. Point Courier at the published version, if it moved.
cd ../courier
npm pkg set dependencies.jmap-courier="^$(node -p "require('../jmap-courier/package.json').version")"

# 3. Courier itself.
npm version patch
npm publish
```

`npm pack --dry-run --json` before either publish, and read the file list. Both
packages use a `files` whitelist rather than relying on `.gitignore`: what ships
should be a decision, not a side effect of what happens not to be ignored.
Without it, Courier packed 312 files including `src/` and all 41 tests.

## Installing

```bash
npm install -g @anandman/courier
```

That provides two commands:

- `courier` — the CLI, and `courier mcp` to run the server
- `courier-mcp` — the server directly, for a client config that spawns it

## Running the installed package under systemd

Point the unit at the installed binary rather than a working tree, so the
service stops depending on where the source happens to live:

```ini
[Service]
Environment=PATH=/home/you/.nvm/versions/node/v24.14.0/bin:/usr/bin:/bin
ExecStart=/home/you/.nvm/versions/node/v24.14.0/bin/courier-mcp
```

`PATH` must include the directory `node` lives in. `courier-mcp` is a shim with
`#!/usr/bin/env node`, so an absolute path to the shim is not enough — the
interpreter has to be findable too, and `systemd --user` does not inherit a
login shell's `PATH`.

Note the trade this makes: shipping a change becomes publish-then-upgrade
rather than rebuild-and-restart. During heavy iteration, point the unit back at
a working tree.

## Working on it locally

The dependency is `^1.0.0`, which resolves from the registry. For local
development against an unpublished `jmap-courier`:

```bash
npm install ../jmap-courier    # restores the file: link
```

Do not commit that change.
