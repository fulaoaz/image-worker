#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-imge-worker:local}"
ARCHIVE_PATH="${ARCHIVE_PATH:-dist/imge-worker-image.tar.gz}"

mkdir -p "$(dirname "$ARCHIVE_PATH")"

echo "Building $IMAGE_NAME locally..."
docker build -t "$IMAGE_NAME" .

echo "Exporting $IMAGE_NAME to $ARCHIVE_PATH..."
docker save "$IMAGE_NAME" | gzip -c > "$ARCHIVE_PATH"

echo "Done: $ARCHIVE_PATH"
