FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY apps ./apps
COPY packages ./packages

ENV NODE_ENV=production
ENV HOST=0.0.0.0
CMD ["npm", "start"]
