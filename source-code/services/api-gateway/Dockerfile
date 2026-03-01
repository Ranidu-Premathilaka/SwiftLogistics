FROM node:18-alpine

WORKDIR /usr/src/app/services/api-gateway

COPY services/api-gateway/package*.json ./
RUN npm install --production

COPY services/api-gateway ./

CMD ["node", "index.js"]
