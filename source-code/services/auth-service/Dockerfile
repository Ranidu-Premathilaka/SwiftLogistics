FROM node:18-alpine

WORKDIR /usr/src/app/services
COPY services/auth-service/package*.json ./
RUN npm install --production

COPY services/utility ./utility
COPY services/auth-service ./auth-service

WORKDIR /usr/src/app/services/auth-service
CMD ["node", "index.js"]
