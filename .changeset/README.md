# Changesets

Version bumps and the changelog come from files in this directory. Add one in
the pull request that changes behaviour:

```sh
pnpm changeset          # pick the packages, pick major/minor/patch, write the note
```

The note is what lands in the changelog, so write it for someone using the
package, not for the diff. Releasing is two steps on `master`:

```sh
pnpm version-packages   # applies the changesets: bumps versions, writes CHANGELOG.md
pnpm release            # builds, then publishes what changed
```

Every package here moves as one version (`fixed` in `config.json`): the bundle
and its rows are shipped together, and a profile that mixes versions of them is
not a configuration anyone should have to debug.
