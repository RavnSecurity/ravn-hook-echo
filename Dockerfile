# ravn-hook-echo: a reference Ravn Hook.
#   docker build -t ravn-hook-echo .
#   docker run --rm -p 8080:8080 -e RAVN_HOOK_SECRET=... ravn-hook-echo
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN pnpm run build && pnpm prune --prod --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist/src ./dist/src
COPY --chown=node:node package.json LICENSE README.md SECURITY.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node schema ./schema
# The service account's refresh token lives here. Mount a volume on it, or a
# restart has a spent unwrap token and nothing to renew with.
RUN mkdir -p /home/node/.ravn-hook-echo && chown node:node /home/node/.ravn-hook-echo && chmod 700 /home/node/.ravn-hook-echo
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "bin/ravn-hook-echo.js"]
