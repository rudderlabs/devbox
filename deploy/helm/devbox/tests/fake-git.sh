#!/bin/sh
# A fake git for snapshot-builder.sh: records argv and the auth env, and makes
# a clone's directory so the next run takes the fetch path.
printf '%s|%s\n' "$*" "${GIT_CONFIG_VALUE_0:-}" >>"$FAKE_KUBE_DIR/git.log"
[ -n "${GIT_SSL_CAINFO:-}" ] && printf '%s\n' "$GIT_SSL_CAINFO" >"$FAKE_KUBE_DIR/ssl.log"
for last; do :; done
case "$*" in
  *" clone "*) mkdir -p "$last/.git" ;;
  # The remote a checkout has, as the test says (FAKE_REMOTE_URL).
  *" config --get remote.origin.url") printf '%s\n' "${FAKE_REMOTE_URL:-}" ;;
esac
exit 0
