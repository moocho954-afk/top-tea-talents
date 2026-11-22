FROM oven/bun:1.3-slim
WORKDIR /app
COPY server/package.json server/tsconfig.json ./
COPY server/src ./src
COPY server/seed ./seed
RUN mkdir -p /data
ENV PORT=3000 DATABASE_PATH=/data/top-tea-talents.db
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
