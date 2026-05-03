# FastAPI Auth Service

Minimal FastAPI service with hardcoded credentials provided through `docker-compose.yml`.
Graphs are stored in local SQLite at `./data/graphs.sqlite`.
Documentation structure is stored in SQLite, while every documentation page body is stored as a markdown file in `./data/documents/<document-name>/<section-id>.md`.

## Run

```bash
docker compose up --build
```

## Login

```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login":"admin@mail.ru","password":"123"}'
```

## Health

```bash
curl http://localhost:8000/health
```

## Graphs

```bash
curl http://localhost:8000/graphs/default \
  -H "Authorization: Bearer hardcoded-token"
```

```bash
curl -X PUT http://localhost:8000/graphs/default \
  -H "Authorization: Bearer hardcoded-token" \
  -H "Content-Type: application/json" \
  -d '{"nodes":[{"id":"node-1","label":"Node 1","x":180,"y":130}],"edges":[]}'
```

## Documentation

```bash
curl http://localhost:8000/documents/default \
  -H "Authorization: Bearer hardcoded-token"
```

```bash
curl -X PUT http://localhost:8000/documents/default \
  -H "Authorization: Bearer hardcoded-token" \
  -H "Content-Type: application/json" \
  -d '{"sections":[{"id":"chapter-1","title":"Chapter 1","content":"# Chapter 1\n\nText","children":[]}]}'
```
