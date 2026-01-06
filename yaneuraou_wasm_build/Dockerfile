FROM emscripten/emsdk:3.1.24

# Install tools
RUN apt-get update && apt-get install -y git zip unzip curl build-essential

# Create workspaces
WORKDIR /workspace

# Clone the usumerican repo to get scripts and patches
RUN git clone https://github.com/usumerican/yaneuraou-suisho-petite.git .

# Download YaneuraOu Release (SuishoPetite)
# We download to /src/source equivalent
RUN mkdir -p /src
WORKDIR /src
RUN curl -L -O https://github.com/mizar/YaneuraOu/releases/download/v7.6.3/SuishoPetite-YaneuraOu-v7.6.3-wasm.zip && \
    unzip -d . -UU SuishoPetite-YaneuraOu-v7.6.3-wasm.zip && \
    tar xvf wasm/source.tar.xz

# Now we need to prepare the source
# The build.sh in the repo assumes /src/source exists
# The tar extraction creates 'source' directory? Let's check.
# Mizar's zip structure usually has wasm/source.tar.xz which extracts to source/
# We assume 'source' is now in /src/source

# Copy our modified Makefile
COPY Makefile /workspace/script/Makefile

# Copy patched usi.cpp
COPY usi.cpp /workspace/script/usi.cpp

# Copy our custom wasm_pre.js (without PThread reference)
COPY wasm_pre.js /workspace/script/wasm_pre.js

# Copy source patches for single-thread mode
COPY source_patches/ /workspace/script/source_patches/

# Copy our custom build script
COPY custom_build.sh /workspace/custom_build.sh
RUN chmod +x /workspace/custom_build.sh

# Execute build using our custom script
WORKDIR /workspace
CMD ["/workspace/custom_build.sh"]
