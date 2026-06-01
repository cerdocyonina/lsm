FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install root deps (chalk, winston, etc. used by shared src/)
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Copy shared source files imported by lsm-node
COPY src/3x-ui.ts src/logger.ts src/

# Copy lsm-node source
COPY lsmnode/package.json lsmnode/
COPY lsmnode/src/ lsmnode/src/

WORKDIR /app/lsmnode

EXPOSE 9000

CMD ["bun", "run", "src/index.ts"]
