# Pulling and resolving conflicts before you work

Before editing for an item, sync each repository you will touch so you build on
the latest branch state and never clobber pushed work:

1. **Fetch.** `git fetch origin` and compare your branch to its upstream tip.
2. **Fast-forward** when the branch only advanced on the remote; **integrate**
   (merge/rebase onto the latest tip) when local and remote both have commits —
   never discard either side.
3. **Resolve conflicts deliberately**, preserving both the intent already on the
   branch and the new request; never drop committed work to clear a conflict.
4. **Re-validate** — re-run the relevant build / tests so you start green.

Do this first; only then edit, commit, and push.
