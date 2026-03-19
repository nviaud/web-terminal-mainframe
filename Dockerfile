FROM node:20-slim

RUN apt-get update \
    && apt-get install -y c3270 python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/server.js"]
