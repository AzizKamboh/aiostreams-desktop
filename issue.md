Upstream v2.38.1 changes files under .github/workflows, which GITHUB_TOKEN cannot push.
Configure the sync GitHub App (docs/UPSTREAM-SYNC.md) and re-run **Upstream Sync**, or run locally:

```sh
node scripts/upstream/sync.mjs prepare --ref v2.38.1
git push -u origin b
```

# report

the full upstream report body
