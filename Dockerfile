FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY prisma ./prisma

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build

# Default: web app. The worker service overrides CMD with `npm run worker`.
CMD ["npm", "run", "start"]
