# syntax=docker/dockerfile:1
# Context must be the verified Linux portable stage, never a source checkout or profile.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 zhuma \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /data/home zhuma \
    && mkdir /data \
    && chown 10001:10001 /data
WORKDIR /app
COPY --chown=10001:10001 sdk/ ./sdk/
COPY --chown=10001:10001 workbench/ ./workbench/
COPY --chown=10001:10001 start.mjs member-gateway.mjs runtime-manifest.mjs SOURCE.json LICENSE THIRD_PARTY_LICENSES.txt ./
USER 10001:10001
EXPOSE 3080
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/start.mjs"]
