FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install chromium
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
