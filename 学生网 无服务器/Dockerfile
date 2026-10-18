FROM node:22-alpine

WORKDIR /app

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "server.js"]
