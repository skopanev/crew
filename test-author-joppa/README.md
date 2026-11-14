# Test-author approval selection

This command previews approved criteria. It does not claim an AC, start a model or publish Tests.
The author, critics and publication workflow are not implemented here.

```sh
sh ./lane-launcher/test-author-joppa.sh /absolute/project-config.json --dry-run
```

Use the existing project config with `workspace` and the authenticated `joppa` connection.
Add the selection settings. The following field name is an example, not a default:

```json
"testAuthor": {
  "approvalField": "review_hash",
  "filter": {}
}
```

`testAuthor.filter` uses the same native filters as `joppa.filter`. The project supplies all field names and values.
The selector reads criterion kinds from the workspace schema. It skips archived, assigned and held nodes.
It trusts native `contract_hash` only when `joppa_tree.capabilities` includes `contract_hash:c1`.
The native proof must have the `c1:` prefix and 64 lowercase hexadecimal digits.
The configured approval field must equal that proof. Missing or stale approval excludes the criterion.
There is no local hash or revision fallback. Unsupported servers stop with `CONTRACT_HASH_UNSUPPORTED`.
An advertised capability with an invalid per-node proof stops with `CONTRACT_HASH_INVALID`.

The native hash API remains a server proposal. This preview cannot select criteria until that API is deployed.
Its output proves approval eligibility only. It does not prove that Tests are missing or that their coverage is complete.
A future author workflow must inspect existing Tests and recheck the native proof before publication.
