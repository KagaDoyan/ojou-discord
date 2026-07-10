FROM oven/bun:1

WORKDIR /app

# - build-essential + python3: @discordjs/opus (native Opus encoder, needed for
#   non-garbled voice audio) tries to download a prebuilt binary first and only compiles
#   from source (via node-gyp, which needs both) if none matches this platform. Prebuilds
#   exist for standard x64/arm64, so this is a safety net, but without it that fallback
#   path would fail the whole build.
# - ffmpeg: the distro build. music.js prefers this over the ffmpeg-static npm package's
#   bundled binary when it's on PATH — the static build has been observed to segfault on
#   real network streams under emulation, the distro package hasn't.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    build-essential \
    python3 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "index.js"]
