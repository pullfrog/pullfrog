#!/bin/sh
# rebuilds the committed pullfrog-landlock binaries beside this script from landlock.c, in a pinned
# Alpine container with a pinned zig that cross-compiles both architectures. CI runs it and fails on
# any changed byte, so the binaries in the repo are exactly what the source says. needs docker.
# see wiki/security.md "Path sandbox".
set -eu
here=$(cd "$(dirname "$0")" && pwd)
docker run --rm -i -v "$here:/src" -w /src \
  alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f sh -eu <<'EOF'
version=0.17.1
case "$(uname -m)" in
x86_64) sum=3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a ;;
aarch64) sum=a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795 ;;
*) echo "build.sh: unsupported host $(uname -m)" >&2 && exit 1 ;;
esac
zig=zig-$(uname -m)-linux-$version
wget -q -O /tmp/zig.tar.xz "https://ziglang.org/download/$version/$zig.tar.xz"
echo "$sum  /tmp/zig.tar.xz" | sha256sum -c -s
tar -xJf /tmp/zig.tar.xz -C /tmp
for arch in x64:x86_64 arm64:aarch64; do
  "/tmp/$zig/zig" cc -target "${arch#*:}-linux-musl" -static -Os -s -Wall -Werror \
    -o "pullfrog-landlock-${arch%%:*}" landlock.c
done
EOF
