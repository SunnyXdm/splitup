FROM node:24 AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# Full image so better-sqlite3 can compile if no prebuild matches.
FROM node:24 AS serverdeps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=serverdeps /app/server/node_modules ./node_modules
COPY server/ .
COPY --from=webbuild /app/web/dist /app/web/dist
EXPOSE 8790
# node is PID 1 directly (no npm/npx wrapper) so SIGTERM reaches the app.
CMD ["node", "--import", "tsx", "src/index.ts"]
