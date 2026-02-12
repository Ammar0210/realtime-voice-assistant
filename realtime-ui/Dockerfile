# -------- Build stage --------
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# -------- Serve stage --------
FROM nginx:alpine
COPY --from=build /app/dist/realtime-ui/browser /usr/share/nginx/html

# Nginx config to support SPA routes + proxy /api to backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
