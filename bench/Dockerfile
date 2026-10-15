# Benchmark image: Bun, aria2 and qBittorrent (qbittorrent-nox) for comparison, and this project.
#   docker build -f bench/Dockerfile -t tinytorrent-bench .
#   docker run --rm --network container:<vpn> --tmpfs /work:size=6g -e TT_BENCH_DIR=/work tinytorrent-bench real <url>
FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends aria2 qbittorrent-nox ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
ENTRYPOINT ["bun", "bench/cli.ts"]
