# Build context is the repository root (see docker-compose.yml), because
# this is an npm workspaces monorepo: the API depends on the sibling
# @signage-crm/db and @signage-crm/shared packages.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/db packages/db
COPY packages/shared packages/shared
RUN npm run build --workspace @signage-crm/shared \
 && npm run build --workspace @signage-crm/db \
 && npm run build --workspace @signage-crm/api

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json

COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/generated ./packages/db/generated
COPY --from=build /app/packages/db/prisma ./packages/db/prisma
COPY --from=build /app/packages/db/package.json ./packages/db/package.json

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

COPY apps/api/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
