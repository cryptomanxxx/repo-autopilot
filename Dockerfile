FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
USER node
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node", "src/chat-server.js"]
