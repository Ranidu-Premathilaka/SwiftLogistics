# Use official Node.js LTS image
FROM node:18-alpine

WORKDIR /usr/src/app

# 1. Copy package.json to the correct subdirectory to match local structure
COPY services/wms-service/package*.json ./services/wms-service/

# 2. Install dependencies inside that subdirectory
WORKDIR /usr/src/app/services/wms-service
RUN npm install --production

# 3. Move back to root to copy source files
WORKDIR /usr/src/app

# 4. Copy the shared utility folder to the correct relative location
COPY services/utility ./services/utility

# 5. Copy the service code to the correct relative location
COPY services/wms-service ./services/wms-service

# 6. Set working directory to the service folder for runtime
WORKDIR /usr/src/app/services/wms-service

CMD ["node", "index.js"]
