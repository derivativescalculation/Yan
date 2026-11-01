FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_CHAIN_ID
ARG VITE_GATEWAY_URL
ARG VITE_RPC_URL
RUN bun x vite build

FROM oven/bun:1.4-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.ts ./
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "server.ts"]
