#!/bin/bash
set -e

echo "=== Custom Build Script Started ==="
echo "Current Directory: $(pwd)"

# Debug: list directory structure
echo "Listing /src structure:"
find /src -maxdepth 3 -not -path '*/.*'

# Locate source directory
SRC_DIR=$(find /src -type d -name "source" | head -n 1)
if [ -z "$SRC_DIR" ]; then
    echo "ERROR: Could not find 'source' directory in /src"
    exit 1
fi
echo "Found source directory at: $SRC_DIR"

# Locate wasm_pre.js
PRE_JS=$(find /src -name "wasm_pre.js" | head -n 1)
if [ -z "$PRE_JS" ]; then
    echo "WARNING: Could not find wasm_pre.js. Creating a default one."
    # Create a minimal wasm_pre.js if missing
    echo "Module['preRun'] = [];" > $SRC_DIR/wasm_pre.js
else
    echo "Found wasm_pre.js at: $PRE_JS"
    if [ "$PRE_JS" != "$SRC_DIR/wasm_pre.js" ]; then
        cp "$PRE_JS" "$SRC_DIR/"
    fi
fi

# Prepare source directory
cd "$SRC_DIR"
echo "Switched to: $(pwd)"

# Copy Makefile from workspace
echo "Copying Makefile from /workspace/script/Makefile"
cp -f /workspace/script/Makefile .

# Copy extra CPP files (including patched usi.cpp)
if compgen -G "/workspace/script/*.cpp" > /dev/null; then
    echo "Copying extra cpp files (including patched usi.cpp)..."
    cp -f /workspace/script/*.cpp .
fi

# Copy our custom wasm_pre.js (without PThread reference)
if [ -f "/workspace/script/wasm_pre.js" ]; then
    echo "Copying custom wasm_pre.js..."
    cp -f /workspace/script/wasm_pre.js .
fi

# Copy source patches for single-thread mode
if [ -d "/workspace/script/source_patches" ]; then
    echo "Copying source patches for single-thread mode..."
    cp -f /workspace/script/source_patches/*.cpp . 2>/dev/null || true
    cp -f /workspace/script/source_patches/*.h . 2>/dev/null || true
fi

# Build Function
build_variant() {
    local VARIANT=$1
    echo "--- Building variant: $VARIANT ---"
    
    make clean
    rm -f yaneuraou.*
    
    if [ "$VARIANT" = "sse42" ]; then
        EXTRA_FLAGS="-DUSE_WASM_SIMD -msimd128 -DUSE_SSE42 -msse4.2"
    else
        EXTRA_FLAGS=""
    fi
    
    # We use explicit environment variables for the Makefile
    make tournament EM_EXPORT_NAME=YaneuraOu_${VARIANT} EXTRA_CPPFLAGS="${EXTRA_FLAGS}"
    
    # Verify output
    if [ ! -f "yaneuraou.js" ]; then
        echo "ERROR: Build failed, yaneuraou.js not found."
        return 1
    fi
    
    # Move to output (not dist, to avoid extra folder in final path)
    mkdir -p /workspace/output/${VARIANT}
    cp yaneuraou.js /workspace/output/${VARIANT}/
    cp yaneuraou.wasm /workspace/output/${VARIANT}/
    echo "--- Finished variant: $VARIANT ---"
}

# Build both variants
build_variant "sse42"
build_variant "nosimd"

echo "=== Build Complete ==="
ls -R /workspace/output
