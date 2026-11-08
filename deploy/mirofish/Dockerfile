# MiroFish backend only (no frontend/node). Build context = services/mirofish.
FROM python:3.11-slim

RUN pip install --no-cache-dir uv \
  && apt-get update \
  && apt-get install -y --no-install-recommends gcc python3-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/ .
# runtime reads ../../locales/languages.json relative to backend/app/utils
COPY locales/ /app/locales/

ENV FLASK_HOST=0.0.0.0 \
    FLASK_PORT=5001 \
    PYTHONUNBUFFERED=1

EXPOSE 5001
CMD ["uv", "run", "--no-sync", "python", "run.py"]
