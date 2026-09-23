FROM python@sha256:94c50be2dc994b873b55bc123e95e6dbade08095b3dfd790f51c34de3f08cbb7
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py task_inbox.py relay_transport.py isolation_proxy.py healthcheck.py /app/
USER 10001:10001
CMD ["python", "-u", "/app/main.py"]
