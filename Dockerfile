# Minimal Node image — no native deps now (we use built-in node:sqlite),
# so plain Alpine is enough.
FROM node:24-alpine

WORKDIR /app

# Install only prod deps. devDependencies (wrangler etc.) live in cf-worker/.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Persistent SQLite goes here — Fly volume mounts at /data
ENV DB_PATH=/data/unmatched.db
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "src/server.js"]
