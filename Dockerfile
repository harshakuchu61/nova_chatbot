# =============================================================
#  Nova — React + FastAPI + Vertex AI (ADK) Dockerfile
# =============================================================

FROM node:20-alpine AS frontend-build
WORKDIR /ui
COPY frontend/package.json ./package.json
COPY frontend/tsconfig.json ./tsconfig.json
COPY frontend/tsconfig.app.json ./tsconfig.app.json
COPY frontend/vite.config.ts ./vite.config.ts
COPY frontend/index.html ./index.html
COPY frontend/src ./src
RUN npm install && npm run build

FROM python:3.12-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY --from=frontend-build /ui/dist ./frontend/dist

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/config')" || exit 1

CMD ["gunicorn", \
  "--bind", "0.0.0.0:8080", \
  "--workers", "2", \
  "--threads", "4", \
  "--timeout", "300", \
  "--keep-alive", "5", \
  "--access-logfile", "-", \
  "--error-logfile", "-", \
  "-k", "uvicorn.workers.UvicornWorker", \
  "backend.main:app"]
