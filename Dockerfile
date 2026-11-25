# syntax=docker/dockerfile:1
# Folio web app: the built reader, served by `vite preview`. It also provides the reader's server-side
# routes: /api/fetch (import a document from a link) and the /api/ai proxy to the backend container.
# Built and run by docker-compose.yml; see the README section "Run everything with Docker".

FROM node:22-bookworm-slim AS build
WORKDIR /app
# scripts/ is needed by the postinstall step (copies pdf.js fonts and character maps into public/).
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# Vite writes a compiled copy of vite.config.ts next to it on start, so the app user owns /app.
RUN chown node:node /app
ENV NODE_ENV=production \
    FOLIO_AI_URL=http://backend:8765
# vite preview needs Vite and the config's plugins (dev dependencies) next to the built files.
COPY --from=build --chown=node:node /app/package.json /app/vite.config.ts ./
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node_modules/.bin/vite", "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
