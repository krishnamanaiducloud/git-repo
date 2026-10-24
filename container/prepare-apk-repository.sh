#!/bin/sh
# Build-only: resolve against a signed index, fetch with GNU wget, then install offline.
set -eu

repository="$1"
root="$2"
shift 2
architecture="$(apk --print-arch)"
mkdir -p "/runtime-repository/$architecture" /tmp/apks "$root"
# APK still locates installed state through /lib/apk; Wolfi's /lib is usr/lib.
if [ ! -e "$root/lib" ] && [ ! -L "$root/lib" ]; then
  ln -s usr/lib "$root/lib"
fi
index_downloaded=0
for attempt in 1 2 3 4 5; do
  if wget --https-only --prefer-family=IPv4 --timeout=30 --tries=3 \
    --retry-connrefused --retry-on-host-error \
    --retry-on-http-error=429,500,502,503,504 --quiet \
    "$repository/$architecture/APKINDEX.tar.gz" \
    -O "/runtime-repository/$architecture/APKINDEX.tar.gz"; then
    index_downloaded=1
    break
  fi
  echo "Signed APK index download failed; retry $attempt" >&2
  sleep "$attempt"
done
if [ "$index_downloaded" != 1 ]; then
  echo "ERROR: Unable to download signed APK index over HTTPS" >&2
  exit 1
fi
printf '%s\n' /runtime-repository > /etc/apk/repositories
transaction="$(apk --root "$root" --initdb --keys-dir /etc/apk/keys \
  --repositories-file /etc/apk/repositories --no-network --simulate --no-progress \
  add "$@" 2>&1)" || { printf '%s\n' "$transaction" >&2; exit 1; }
printf '%s\n' "$transaction"
printf '%s\n' "$transaction" \
  | awk '/^\([^)]*\) (Installing|Upgrading|Downgrading|Reinstalling) / { version=$0; sub(/^\([^)]*\) [^ ]+ [^ ]+ \(/, "", version); sub(/\).*/, "", version); sub(/.* -> /, "", version); print $3 "=" version }' \
  > /runtime-repository/constraints
test -s /runtime-repository/constraints
package_files="$(sed 's/=/-/; s/$/.apk/' /runtime-repository/constraints)"
for package_file in $package_files; do
  if [ ! -s "/tmp/apks/$package_file" ]; then
    downloaded=0
    for attempt in 1 2 3 4 5; do
      if wget --https-only --prefer-family=IPv4 --timeout=30 --tries=3 \
        --retry-connrefused --retry-on-host-error \
        --retry-on-http-error=429,500,502,503,504 --quiet \
        "$repository/$architecture/$package_file" -O "/tmp/apks/$package_file.partial"; then
        downloaded=1
        break
      fi
      echo "Package download failed; retry $attempt: $package_file" >&2
      sleep "$attempt"
    done
    test "$downloaded" = 1
    mv "/tmp/apks/$package_file.partial" "/tmp/apks/$package_file"
  fi
  cp "/tmp/apks/$package_file" "/runtime-repository/$architecture/"
done
