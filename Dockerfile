FROM node:24-slim

# ffmpeg for cutting / caption burn-in, python3 + pip for yt-dlp.
# fonts-noto-core provides Noto Sans Bengali (burned-in Bengali captions);
# fonts-dejavu-core provides DejaVu for Latin/monospace caption styles.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip fonts-noto-core fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Render sets PORT; the server reads it and listens on 0.0.0.0.
ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm", "start"]
