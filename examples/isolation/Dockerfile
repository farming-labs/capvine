FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build
COPY examples/isolation ./examples/isolation
USER 10002:10000
