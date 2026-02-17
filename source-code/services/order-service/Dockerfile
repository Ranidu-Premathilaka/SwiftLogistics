FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Expose port (if service exposes an HTTP API)
EXPOSE 3000

CMD [ "npm", "start" ]
