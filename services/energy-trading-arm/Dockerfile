FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ET_DATA_DIR=/app/data \
    ET_STATE_DIR=/app/state \
    ET_SCHEDULER_ENABLED=true

WORKDIR /app

RUN adduser --disabled-password --gecos "" trader

COPY pyproject.toml README.md ./
COPY src ./src
COPY static ./static
COPY templates ./templates
COPY data ./data

RUN pip install --no-cache-dir . \
    && mkdir -p /app/state \
    && chown -R trader:trader /app

USER trader
EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "energy_trading.api:app", "--host", "0.0.0.0", "--port", "8000"]
