FROM node:18-alpine

WORKDIR /usr/src/app/services
COPY services/notify-service/package*.json ./
RUN npm install --production

COPY services/utility ./utility
COPY services/notify-service ./notify-service

WORKDIR /usr/src/app/services/notify-service
CMD ["node", "index.js"]
