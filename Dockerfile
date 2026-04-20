# =============================================================
#  Nova — Production Dockerfile
#  Builds a minimal image for Google Cloud Run.
#
#  Local build & run:
#    docker build -t nova .
#    docker run -p 5000:8080 --env-file server/.env nova
# =============================================================

FROM python:3.12-slim AS base

WORKDIR /app

# System libs needed by psycopg2-binary and cryptography
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (layer-cached separately from source code)
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY server/ ./server/
COPY static/ ./static/

# ── Runtime ────────────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1
# Cloud Run injects $PORT (default 8080); gunicorn binds to it.
EXPOSE 8080

# Health-check so Cloud Run marks the instance ready faster.
# Flask's /api/config route is lightweight and requires no auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/config')" \
    || exit 1

# Gunicorn: 1 worker + 8 threads is optimal for Cloud Run's single vCPU.
# --preload shares the model cache across threads inside the worker.
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "1", \
     "--threads", "8", \
     "--timeout", "120", \
     "--preload", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "server.app:app"]
