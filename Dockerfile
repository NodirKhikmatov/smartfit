# Smart Fit app image: Node 22, production deps only, runs as the non-root `node` user.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# better-sqlite3 is an optional dev/test dependency; production runs on PostgreSQL only.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY src ./src
COPY public ./public
# Demo product illustrations, copied to uploads by `npm run seed` on a test server (the seed refuses production).
COPY demo/images ./demo/images
# Product images (admin uploads) live on a volume; customer photos are never written anywhere.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
ENV PORT=3000 UPLOAD_DIR=/app/uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/server.js"]
