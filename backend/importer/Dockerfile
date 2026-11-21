FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -r /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tender_import ./tender_import
ENV PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
ENTRYPOINT ["python", "-m", "tender_import"]
