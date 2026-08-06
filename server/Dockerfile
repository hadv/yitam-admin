FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Create uploads directory
RUN mkdir -p uploads

EXPOSE 3001

CMD ["npm", "start"] 