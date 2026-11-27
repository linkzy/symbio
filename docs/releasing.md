# Releasing

For maintainers. A release is a version tag: the **Release** workflow checks everything again and
publishes only if it all passes, so a broken build never reaches users.

## Branches and versions

- `main` is what's released; it's protected (no force pushes or deletion; changes come through pull
  requests that pass the CI check, maintainers can push directly).
- `next` follows `main` and is where pre-releases are cut from when a change needs a beta
  (`1.2.3-beta.1` goes to npm's `next` tag; `npm i -g symbio` keeps getting the stable one).
- Versions follow [Semantic Versioning](https://semver.org/): a minor version for features, a patch
  for fixes.

## Who changes what

Symbio is also developed by a Symbio team on another machine, working on the same repository with
the same GitHub account. To keep the two from colliding:

- **The Symbio team works on branches and opens pull requests** (`symbio/<issue>-<short-name>`); it
  never pushes to `main` or `next`, and never tags. Its GitHub connection is set to *Ask me*, so each
  push waits for the maintainer, and it uses its own fine-grained token, limited to this repository
  (contents and pull requests).
- **Direct pushes to `main`, merges and releases happen in one place**, the maintainers' own
  session, so two version tags never race.
- **Issues are the shared list.** Work in progress is labelled `in progress: symbio` (or assigned);
  the other side leaves those alone.
- **`CHANGELOG.md` and the roadmap conflict often** (both sides add to `[Unreleased]`): keep both
  sides' entries when merging; they're sorted out at release.

## Steps

1. Move the entries under `[Unreleased]` in `CHANGELOG.md` to a new version and set the same
   version in `package.json` (`npm version <x.y.z> --no-git-tag-version`). Add a line for it to the
   roadmap's *Done*, and mark or remove the items it finished.
2. If agents work differently, make sure `src/server/updates.ts` has entries for it.
3. `npm pack` and try the package from a temporary prefix before publishing:
   ```sh
   npm pack --pack-destination /tmp/symbio-pkg
   npm i -g --prefix /tmp/symbio-pkg/prefix /tmp/symbio-pkg/symbio-<version>.tgz
   SYMBIO_HOME=/tmp/symbio-pkg/home SYMBIO_PORT=4330 /tmp/symbio-pkg/prefix/sym doctor
   ```
4. If the release changes what depends on the machine (installers, runtime installs, the vault,
   paths, starting and stopping), run the platform pass first ([platform-testing.md](platform-testing.md)).
5. Commit, tag the commit with the version (`git tag v<version>`) and push the tag. The **Release**
   workflow (`.github/workflows/release.yml`) checks that the tag matches `package.json`, runs every
   check (type-check, unit, contract and end-to-end tests, build), and publishes to npm through trusted publishing: no npm token is
   stored anywhere, and the package gets provenance. It then creates the GitHub release, with the
   version's section of `CHANGELOG.md` (`scripts/release-notes.mjs`; pre-releases marked as such). It's authorized on npmjs.com → symbio →
   Settings → Trusted Publisher (GitHub Actions, user `linkzy`, repo `symbio`, workflow
   `release.yml`).

**Updates reach users by themselves.** Installed copies ask Symbio's update endpoint
(`symbio.linkzy.dev/update`, which answers npm's latest version unless a release is held back there)
and update automatically (see `self-update.ts`), so a release goes out to everyone within hours: keep `CHANGELOG.md` current (its
section for the version is shown in Settings → Updates). A copy running from a clone (`npm link`)
never updates itself. To test updates without npm, install a packed version into a temporary
prefix and point it at a stand-in registry: `SYMBIO_UPDATE_REGISTRY` (serves `/symbio/latest`),
`SYMBIO_UPDATE_SPEC` (what to install, e.g. a `.tgz`) and `SYMBIO_UPDATE_CHANGELOG`.

The runtimes are pinned dev dependencies (`@opencode/cli`, patch updates only; `@github/copilot-sdk`,
exact), and they're the versions users install. Moving to a newer one means re-verifying the APIs in
[opencode-api.md](opencode-api.md) or [copilot-api.md](copilot-api.md) first; users get it with the
Symbio update (Settings → Agent runtimes reinstalls; a missing one is reinstalled at startup).

## When the release workflow fails

Nothing was published (the checks run before `npm publish`). Fix the cause on `main`; if it was a
flaky test, make it wait for what it checks instead of retrying. Then move the tag to the fixed
commit and push it again:

```sh
git push origin --delete v<version>
git tag -d v<version> && git tag v<version>
git push origin v<version>
```

A version that did get published can't be published again: release the next patch instead.

## After a release

- npm shows the new version a few minutes after the workflow ends (`npm view symbio dist-tags`).
- Close the issues the release finished, with a comment saying which version has it, and move the
  roadmap item to **Done**.
- Contributors' work is credited in `CHANGELOG.md` (by name and pull request) and in the README's
  Contributors list.

## Dependencies

Dependabot (`.github/dependabot.yml`) opens weekly pull requests: GitHub Actions, and minor and patch
updates of the npm dependencies, grouped, checked by CI like any other change. The agent runtimes
(`@opencode/cli`, `@github/copilot-sdk`) and major versions are left out: they're updated by hand,
after verifying what changed.
