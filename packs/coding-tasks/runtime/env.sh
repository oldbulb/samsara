# Put the pack-local toolchains (runtime/provision.sh) in front of PATH and
# pin both to offline, for the loop's shell: the agent runs `cargo test` /
# `go test` in its workdir with whatever the host process inherited.
# bin/truth finds the same toolchains by itself.
#
# usage: source packs/coding-tasks/runtime/env.sh
_rt="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -x "$_rt/go/go/bin/go" ] && export PATH="$_rt/go/go/bin:$PATH"
export GOTOOLCHAIN=local GOPROXY=off GOCACHE="$_rt/go/cache" GOPATH="$_rt/go/gopath"
if [ -d "$_rt/rust/rustup" ]; then
  export RUSTUP_HOME="$_rt/rust/rustup" CARGO_HOME="$_rt/rust/cargo" PATH="$_rt/rust/cargo/bin:$PATH"
fi
export CARGO_NET_OFFLINE=true
unset _rt
