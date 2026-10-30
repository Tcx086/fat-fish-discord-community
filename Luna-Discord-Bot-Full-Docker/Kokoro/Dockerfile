FROM python:3.11-slim

ARG ALLOW_EXTERNAL_ASSETS=false
RUN test "$ALLOW_EXTERNAL_ASSETS" = true || (echo "Review asset rights and explicitly set --build-arg ALLOW_EXTERNAL_ASSETS=true" >&2; exit 1)
ENV ALLOW_EXTERNAL_ASSETS=${ALLOW_EXTERNAL_ASSETS}

RUN apt-get update && apt-get install -y \
    espeak-ng \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Kokoro model at build time so the container is self-contained
RUN python -c "from kokoro import KPipeline; KPipeline(lang_code='a')"

COPY kokoro_server.py .

EXPOSE 8880

CMD ["python", "kokoro_server.py"]
