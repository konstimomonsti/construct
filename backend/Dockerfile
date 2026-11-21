# API backend: JSON API under /api, built-in data tools under /admin. Build context is the repository root.
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY importer/requirements.txt /app/importer-requirements.txt
COPY requirements.txt /app/analysis-requirements.txt
RUN pip install --no-cache-dir -r importer-requirements.txt -r analysis-requirements.txt \
    "python-docx==1.2.0" "reportlab==4.5.1" "anthropic>=2.12,<3"
COPY importer/tender_import /app/tender_import
COPY analysis /app/analysis
COPY backend/server.py backend/mvp.py backend/exports.py backend/analysis_api.py schema-dashboard.html /app/
COPY backend/admin /app/admin
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
RUN install -d -o 65532 -g 65532 -m 0700 /var/cache/tenderdesk/layer3
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"]
CMD ["python", "server.py"]
