#!/usr/bin/env bash
set -euo pipefail

SIZE="${SWAP_SIZE:-2G}"
FILE="${SWAP_FILE:-/swapfile}"

echo "Configuring swap $FILE ($SIZE)..."
if swapon --show=NAME | grep -qx "$FILE"; then
  echo "Swap already active: $FILE"
  exit 0
fi

if [[ ! -f "$FILE" ]]; then
  fallocate -l "$SIZE" "$FILE" 2>/dev/null || dd if=/dev/zero of="$FILE" bs=1M count="${SIZE%G}024" status=progress
  chmod 600 "$FILE"
  mkswap "$FILE"
fi

swapon "$FILE"
if ! grep -qE "^$FILE\s" /etc/fstab; then
  echo "$FILE none swap sw 0 0" >> /etc/fstab
fi

echo "Swap ready:"
swapon --show
