# A Dockerfile this linter has nothing to say about. It is a fixture, not an example of a
# good application image -- it exists so CI fails loudly if any rule starts firing on a
# file that is genuinely fine.
FROM --platform=$BUILDPLATFORM node:20.11-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20.11-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
