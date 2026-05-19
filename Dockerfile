#
# Multi-stage Dockerfile for Pentest Agent
# Uses node:22-slim for wide mirror availability (works behind GFW)
# Chromium is OPTIONAL — install via CHROMIUM=true build arg
#

# ============================================================
# Builder stage — Install tools and build dependencies
# ============================================================
FROM node:22-slim AS builder

# Install system build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@10.33.0

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/worker/package.json ./apps/worker/
COPY apps/cli/package.json ./apps/cli/

RUN pnpm install --frozen-lockfile

COPY . .

# Build worker only (CLI not needed in Docker)
RUN pnpm --filter @shannon/worker run build

# Production-only deps
RUN rm -rf node_modules apps/*/node_modules && pnpm install --frozen-lockfile --prod

# ============================================================
# Runtime stage — Minimal production image
# ============================================================
FROM node:22-slim AS runtime

# Runtime system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Optional Chromium for Playwright browser automation
ARG CHROMIUM=false
RUN if [ "$CHROMIUM" = "true" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            chromium \
            fonts-noto-color-emoji \
            libnss3 \
            libfreetype6 \
            libharfbuzz0b \
            libx11-6 \
            libxcomposite1 \
            libxdamage1 \
            libxext6 \
            libxfixes3 \
            libxrandr2 \
            libgbm1 \
            fontconfig \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Create non-root user
RUN groupadd -g 1001 pentest && \
    useradd -u 1001 -g pentest -s /bin/bash -m pentest

# System-level git config
RUN git config --system user.email "agent@localhost" && \
    git config --system user.name "Pentest Agent" && \
    git config --system --add safe.directory '*'

WORKDIR /app

# Copy only what the worker needs
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/.npmrc /app/
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/worker /app/apps/worker
COPY --from=builder /app/apps/cli/package.json /app/apps/cli/package.json

# No Claude Code CLI needed — we use our own LLM executor

# Symlink custom scripts
RUN ln -s /app/apps/worker/dist/scripts/save-deliverable.js /usr/local/bin/save-deliverable && \
    chmod +x /app/apps/worker/dist/scripts/save-deliverable.js && \
    ln -s /app/apps/worker/dist/scripts/generate-totp.js /usr/local/bin/generate-totp && \
    chmod +x /app/apps/worker/dist/scripts/generate-totp.js

# Create data directories
RUN mkdir -p /app/sessions /app/repos /app/workspaces && \
    mkdir -p /tmp/.cache /tmp/.config /tmp/.npm && \
    chmod 777 /app && \
    chmod 777 /tmp/.cache /tmp/.config /tmp/.npm && \
    chown -R pentest:pentest /app

# Optional Playwright config
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Environment
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:$PATH"
ENV SHANNON_DOCKER=true
ENV npm_config_cache=/tmp/.npm
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache
ENV XDG_CONFIG_HOME=/tmp/.config

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "apps/worker/dist/temporal/worker.js"]
