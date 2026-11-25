# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=38471 \
    DATA_DIR=/data \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist
# Admin helpers: docker exec -it setryx reset-password <username>
RUN printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts reset-password "$@"\n' > /usr/local/bin/reset-password \
 && printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts list-users\n' > /usr/local/bin/list-users \
 && chmod +x /usr/local/bin/reset-password /usr/local/bin/list-users \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 38471
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]
