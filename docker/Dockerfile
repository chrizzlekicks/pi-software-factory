FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @earendil-works/pi-coding-agent@1.5.2 \
    && mkdir -p /workspace /opt/factory \
    && chown node:node /workspace
COPY docker/entrypoint.sh /usr/local/bin/factory-entrypoint
RUN chmod 755 /usr/local/bin/factory-entrypoint
USER node
ENV HOME=/home/node PI_FACTORY_SUBAGENTS_PATH=/home/node/.pi/agent/npm/node_modules/pi-subagents
RUN pi install npm:pi-subagents@0.88.0
WORKDIR /opt/factory
COPY --chown=node:node package.json README.md COMPATIBILITY.md ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node docker/Dockerfile docker/entrypoint.sh docker/live-smoke.mjs docker/probe-events.mjs ./docker/
COPY --chown=node:node .dockerignore ./.dockerignore
ENTRYPOINT ["/usr/local/bin/factory-entrypoint"]
CMD ["test"]
