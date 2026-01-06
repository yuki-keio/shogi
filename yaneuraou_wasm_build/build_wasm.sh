#!/bin/bash
set -e

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

# Image name
IMAGE_NAME="yaneuraou-build-nothreads"

# Build Docker image
echo "Building Docker image..."
docker build -t $IMAGE_NAME .

# Run build container
echo "Running build..."
# usage: ./build_wasm.sh [sse42|nosimd]
# Default to building both if no arg provided to this script.

OUTPUT_DIR="../yaneuraou"
mkdir -p $OUTPUT_DIR

# We run the container and mount a volume to extract files
# The container's CMD runs the build then exits.
# We need to copy files AFTER build.
# So we override CMD or just CP out of a stopped container.

container_id=$(docker create $IMAGE_NAME /workspace/custom_build.sh)
docker start -a $container_id

echo "Copying artifacts..."
# Copy each variant directly to yaneuraou/ folder (not yaneuraou/dist/)
docker cp $container_id:/workspace/output/sse42 $OUTPUT_DIR/
docker cp $container_id:/workspace/output/nosimd $OUTPUT_DIR/

echo "Cleaning up..."
docker rm $container_id

echo "Build complete. Artifacts in $OUTPUT_DIR"
