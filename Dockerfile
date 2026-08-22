# Build the web client and compile the TypeScript packages.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
RUN npm ci && npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
# ripgrep makes vault search fast; Quire falls back to an in-process scan without it.
RUN apk add --no-cache git ripgrep
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages ./packages
RUN npm ci --omit=dev

# Mount your Markdown folder here.
VOLUME ["/vault"]
EXPOSE 4321
# 0.0.0.0 so the container is reachable; keep the published port on a trusted network.
CMD ["node", "packages/cli/bin/quire.js", "/vault", "--host", "0.0.0.0", "--port", "4321"]
