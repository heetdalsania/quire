# Releasing

Everything here except the two steps in **What needs an account** runs with no signup and
no paid service.

## The release bundle

Quire develops as a workspace but ships as a single package, because the onboarding promise
is `npx quiredocs <folder>` and that has to work with one install.

```bash
npm run build:release   # tsc + vite + esbuild, then stage packages/cli
npm run check:release   # refuses to publish something that will not run
```

`build:release` bundles both binaries with their dependencies and copies the web client and
registry index beside them. The published package therefore has **no runtime dependencies**
— nothing to resolve on the user's machine.

`check:release` is not a formality. It verifies the bundles exist, start, and carry exactly
one shebang each, and that no unresolvable workspace ranges leaked into `dependencies`.
Both of those failures were real, and both only appear once the tarball is installed.

## Verifying it the way a user would

The test suite does not prove the *package* works. This does:

```bash
cd packages/cli && npm pack
mkdir -p /tmp/smoke/vault && cd /tmp/smoke && npm init -y
npm install /path/to/quiredocs-0.1.0.tgz
printf '# Hi\n\nhello\n' > vault/hi.md
./node_modules/.bin/quire vault --port 4321 --no-git
```

CI does this on every push, along with a Docker build and run.

## Publishing

```bash
npm publish --access public        # from packages/cli
git tag v0.1.0 && git push --tags
```

`prepublishOnly` runs `check:release` first, so a stale bundle cannot be published.

## What needs an account

These are the only steps that cannot be automated here, because they require credentials
that belong to a person:

1. **npm** — create the account, then `npm login`, then `npm publish --access public` from
   `packages/cli`. The name `quire` is taken on npm by an unrelated 2015 package, so the package is published as
   `quiredocs`. The binaries are still `quire` and `quire-mcp`. Confirm the name before
   publishing, and if it has gone, change `name` in `packages/cli/package.json` and the
   references in README.md.
2. **GitHub** — create the `quiredocs` organisation and the `quire` repository, then
   `git remote add origin …` and push. CI runs on first push and will verify the release
   bundle and the Docker image, neither of which has been executed locally.

Nothing else requires a signup. Docker Hub is not needed: the image builds from source, and
GHCR publishing can be added later if you want a pre-built image.
