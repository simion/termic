---
title: Task snapshots
status: draft
owner: alice
reviewers: [bob, carol]
tags:
  - storage
  - undo
---

# Task snapshots

Agents rewrite a lot of files, and today the only undo is git. This spec
adds automatic snapshots of a task's worktree, taken each time an agent
settles. A snapshot is ==just a manifest== pointing at stored blobs.[^hash]

> [!NOTE]
> This replaces the snapshot section of an older draft.

> [!TIP]
> Snapshots are cheap; take them often.

> [!IMPORTANT]
> Restore never touches the index or the stash.

> [!WARNING]
> A snapshot taken mid-write captures a torn file.

> [!CAUTION]
> Pruning deletes blobs no manifest points at.

> A plain quote stays a plain quote.

## Design

Each snapshot writes one manifest:

```rust
pub struct Manifest {
    pub task_id: String,
    pub entries: Vec<Entry>,
}
```

    an indented block has a header too

## Latency budget

With $B$ the changed bytes and $W$ the write throughput, a snapshot costs
about $\frac{B}{W}$ plus the scan. Prices like $5 and $10 stay text.

$$
t_{\text{snap}} = t_{\text{scan}} + \frac{B}{W} + n \cdot t_{\text{fsync}}
$$

```math
\sqrt{a^2 + b^2}
```

$$ \frac{1 $$

The measurement ran 20 times.[^runs]

<details>
<summary>Rejected alternatives</summary>

**Stash refs.** Cheap, but they show up in the user's stash list.

**Clones.** Close to free on one platform, missing on the others.

</details>

### Glossary

Snapshot
: A manifest plus the blobs it points at.

Manifest
: The sorted list of paths and blob hashes.

[^hash]: Hashing kept up with disk reads on every machine tried.
[^runs]: Measured over 20 runs on a 1 GB checkout.
