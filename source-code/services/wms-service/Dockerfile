# Use official Node.js LTS image
FROM node:18-alpine

# Install deps at the /services level so node_modules is visible to utility/
WORKDIR /usr/src/app/services
COPY services/wms-service/package*.json ./
RUN npm install --production

# Copy shared utility and service source
COPY services/utility ./utility
COPY services/wms-service ./wms-service

# Set working directory to the service folder for runtime
WORKDIR /usr/src/app/services/wms-service

CMD ["node", "index.js"]
