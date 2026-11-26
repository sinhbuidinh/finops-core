# --- Stage 1: Build (nếu cần tái sử dụng cho prod) ---
FROM node:26-alpine AS builder

ENV HUSKY=0
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Stage 2: Development (đầy đủ devDependencies + Husky) ---
FROM node:26-alpine AS dev

ENV NODE_ENV=development
WORKDIR /app

# Husky cần git để thiết lập hooksPath khi chạy prepare
RUN apk add --no-cache git \
    && chown -R node:node /app

COPY --chown=node:node package*.json ./

USER node

EXPOSE 3000

# Chạy mỗi khi start service để đảm bảo deps & husky đồng bộ rồi bật watch mode
CMD ["sh", "-c", "npm install && npx husky && npm run start:dev"]