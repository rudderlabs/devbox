#!/bin/sh
# A fake git for snapshot-builder.sh: records argv and the auth env, and makes
# a clone's directory so the next run takes the fetch path.
printf '%s|%s\n' "$*" "${GIT_CONFIG_VALUE_0:-}" >>"$FAKE_KUBE_DIR/git.log"
for last; do :; done
case "$*" in *" clone "*) mkdir -p "$last/.git" ;; esac
exit 0
