# syntax=docker/dockerfile:1
# Alpine keeps the image small; node:sqlite and crypto.argon2 are built into Node.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# Runtime packages for the server only: the web app is already compiled into dist.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @setryx/server --include-workspace-root=false && rm -rf /root/.npm

# Final image: plain Alpine plus the Node binary. npm, corepack and yarn from the
# Node image are only needed to build, so they're left behind.
FROM alpine:3.24
RUN apk add --no-cache libstdc++ libgcc \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    PORT=38471 \
    DATA_DIR=/data \
    IMAGES_DIR=/images \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/src apps/server/src
COPY --from=build /app/apps/server/seed apps/server/seed
COPY --from=build /app/apps/web/dist apps/web/dist
COPY LICENSE THIRD_PARTY_LICENSES.md ./
# Admin helpers: docker exec -it setryx reset-password <username>
RUN printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts reset-password "$@"\n' > /usr/local/bin/reset-password \
 && printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts list-users\n' > /usr/local/bin/list-users \
 && chmod +x /usr/local/bin/reset-password /usr/local/bin/list-users \
 && mkdir -p /data /images && chown node:node /data /images
USER node
VOLUME /data /images
EXPOSE 38471
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]
