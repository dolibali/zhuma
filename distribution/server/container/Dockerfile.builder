# syntax=docker/dockerfile:1
# Linux build tools only; source, credentials and data are not part of this image.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 build-essential pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable \
    && corepack prepare pnpm@12.4.2 \
    && corepack prepare pnpm@11.28.5
ENV npm_config_nodedir=/usr/local
WORKDIR /workspace
