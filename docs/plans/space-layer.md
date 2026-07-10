# Future work: the Space layer

Deferred, not yet built. Captured here so the intent survives; the Task rename
(shipped v0.19.0) deliberately reserved the word **Space** for this top layer so
nobody reads the new grouping as "the old workspace moved up a level."

## The idea

A top-level, Arc-style **Space**: a colored, horizontally-scrollable group of
projects, with per-Space accent / chrome colors and action routing. It sits
above Project in the hierarchy:

```
Space                        (Arc-style colored group of projects) -- this note
└─ Project                   (a git repo, or a plain folder)
   ├─ Task · main checkout   the repo's original checkout; always present
   └─ Task · worktree feat/x an isolated git worktree (git projects only)
```

Everything below Space (Project → Task, main checkout vs worktree) already
ships. Space is purely the missing top grouping layer.

## Scope when we build it

- Colored, horizontally-scrollable groups of projects (the Arc "spaces" feel).
- Per-Space accent + chrome colors (theme-tinted per Space).
- Action routing scoped to the active Space (new project / broadcast / etc.
  target the current Space).
- Persistence: a Space entity owning an ordered list of projects, plus the
  active-Space selection.

## Why "Space" (naming, decided during the rename)

The unit of work is **Task** (was "Workspace"); "workspace" left the vocabulary
entirely so the future top layer reads cleanly as a new concept, not a promoted
old one. Terminology lineage (super.engineering → termic):

| Concept | super.engineering | termic |
|---|---|---|
| Colored group of projects | Workspace | **Space** (this note) |
| A repo or folder | Project | Project |
| Unit of work | (task) worktree | **Task** |
| Isolated branch location | task worktree | Task · worktree `<branch>` |
| Repo-root location | primary worktree | Task · main checkout |
