#!/usr/bin/env bash
# Provision the four pack runtimes. Idempotent; the only step of the pack that
# touches the network. Go and Rust are installed under runtime/ unless a
# toolchain is already on PATH (CI runners ship both).
set -euo pipefail
cd "$(dirname "$0")"
GO_VERSION=1.27.0

[ -x py/.venv/bin/python ] || python3 -m venv py/.venv
py/.venv/bin/pip install --quiet -r py/requirements.txt
pnpm --dir js install --frozen-lockfile

if [ ! -x go/go/bin/go ] && ! command -v go >/dev/null; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in x86_64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; esac
  curl -sSL "https://go.dev/dl/go${GO_VERSION}.${os}-${arch}.tar.gz" | tar xz -C go
fi

if [ ! -x rust/cargo/bin/cargo ] && ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | RUSTUP_HOME="$PWD/rust/rustup" CARGO_HOME="$PWD/rust/cargo" \
    sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain stable
fi

# the crates the exercises and their reference solutions name, into the registry cache
. ./env.sh
CARGO_NET_OFFLINE=false cargo fetch --manifest-path rust/deps/Cargo.toml
