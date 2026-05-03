# FastAPI Auth Service

Minimal FastAPI service with hardcoded credentials provided through `docker-compose.yml`.

## Run

```bash
docker compose up --build
```

## Login

```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login":"admin","password":"password123"}'
```

## Health

```bash
curl http://localhost:8000/health
```
