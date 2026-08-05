# syntax=docker/dockerfile:1

# Node.js 24 LTS on Debian bookworm-slim, pinned by digest for reproducibility.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

WORKDIR /app

# Install dependencies against the committed lockfile before copying sources so
# the dependency layer is cached independently of application code.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Build the TypeScript sources into dist/, then strip dev dependencies so the
# runtime stage receives production dependencies only.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Copy only production dependencies, compiled output, and package metadata.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Run as the unprivileged user provided by the base image.
USER node

# Documented default port; the process binds HOST/PORT supplied via environment.
EXPOSE 8787

CMD ["node", "dist/index.js"]
