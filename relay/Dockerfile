FROM node:24-alpine

WORKDIR /app

COPY relay/package.json ./relay/package.json
RUN cd /app/relay && npm install --omit=dev --no-audit --no-fund

COPY relay/src ./relay/src
COPY web/frontend ./web/frontend

ENV NODE_ENV=production
ENV SUMMON_RELAY_HOST=0.0.0.0
ENV SUMMON_RELAY_PORT=8790
ENV SUMMON_RELAY_DATA_DIR=/data
ENV SUMMON_RELAY_FRONTEND=/app/web/frontend
ENV SUMMON_RELAY_MAX_UPLOAD_MB=20
ENV SUMMON_RELAY_MAX_CONCURRENT_LARGE=2

VOLUME ["/data"]
EXPOSE 8790

CMD ["node", "/app/relay/src/cli.mjs", "start"]
