# =============================================================
#  Nova — Production Dockerfile
#  Builds a minimal image for Google Cloud Run.
#
#  Local build & run:
#    docker build -t nova .
#    docker run -p 5000:8080 --env-file .env nova
# =============================================================

FROM python:3.12-slim AS base

WORKDIR /app

# System libs needed by psycopg2-binary and cryptography
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (layer-cached separately from source code)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/ ./backend/
COPY web/ ./web/

# ── Runtime ────────────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1
# Cloud Run injects $PORT (default 8080); gunicorn binds to it.
EXPOSE 8080

# Health-check so Cloud Run marks the instance ready faster.
# Flask's /api/config route is lightweight and requires no auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/config')" \
    || exit 1

# Gunicorn: 2 workers × 4 threads on 2 vCPUs.
# --preload shares the connection pool and model cache across threads.
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "2", \
     "--threads", "4", \
     "--timeout", "300", \
     "--keep-alive", "5", \
     "--preload", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "backend.app:app"]
