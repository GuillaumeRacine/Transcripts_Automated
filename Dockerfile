FROM node:18-alpine AS base
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src ./src
COPY bin ./bin
COPY README.md ./README.md
COPY playlists.md ./playlists.md

# Runtime env
ENV NODE_ENV=production

# Default command (can be overridden)
CMD ["node", "src/index.js", "--playlists", "playlists.md"]

