# Releasing

Everything here except the two steps in **What needs an account** runs with no signup and
no paid service.

## The release bundle

Quire develops as a workspace but ships as a single package, because the onboarding promise
is `npx quiredocs <folder>` and that has to work with one install.

```bash
npm run build:release   # tsc + vite + esbuild, then stage packages/cli
npm run check:release   # refuses to publish something that will not run
npm run verify          # full pre-release gate: types, tests, build, release checks
npm run test:e2e        # Chromium, Firefox, and WebKit against the disposable demo
```

`build:release` bundles both binaries with their dependencies and copies the web client and
registry index beside them. The published package therefore has **no runtime dependencies**
— nothing to resolve on the user's machine.

`check:release` is not a formality. It verifies the bundles exist, start, are executable,
report the package version, carry exactly one shebang each, declare the expected licence,
and contain no unresolvable workspace ranges in `dependencies`.
Both of those failures were real, and both only appear once the tarball is installed.

## Verifying it the way a user would

The test suite does not prove the *package* works. This does:

```bash
cd packages/cli && npm pack
mkdir -p /tmp/smoke/vault && cd /tmp/smoke && npm init -y
npm install /path/to/quiredocs-<version>.tgz
printf '# Hi\n\nhello\n' > vault/hi.md
./node_modules/.bin/quire vault --port 4321
```

CI does this on every push, along with a Docker build and run, Windows filesystem tests, and
Chromium, Firefox, and WebKit browser smoke tests.

## Publishing

```bash
npm publish --access public --tag beta   # from packages/cli
git tag v<version>
git push origin main v<version>
```

`prepublishOnly` runs `check:release` first, so a stale bundle cannot be published.

Until a stable release exists, both npm `beta` and `latest` point to the current public beta so a
bare `npx quiredocs` receives the safest build. After dogfooding, change the version to `0.1.0`,
move the changelog entry to that version, rerun every gate, and publish without `--tag beta`.

## What needs an account

These are the only steps that cannot be automated here, because they require credentials
that belong to a person:

1. **npm** — create the account, then `npm login`, then `npm publish --access public` from
   `packages/cli`. The name `quire` is taken by an unrelated package, so this project uses
   `quiredocs`; the installed binaries remain `quire` and `quire-mcp`. Public packages are
   included in npm's free plan; a paid npm plan is needed only for private packages and related
   paid account features.
2. **GitHub settings** — the public repository already lives at `heetdalsania/quire`.
   Enable private vulnerability reporting and require the CI workflow before merging to
   `main`. These settings require an owner in the GitHub UI.

Nothing else requires a signup. Docker Hub is not needed: the image builds from source, and
GHCR publishing can be added later if you want a pre-built image.
