# FastAPI Auth Service

Minimal FastAPI service with hardcoded credentials provided through `docker-compose.yml`.
Graphs are stored in local SQLite at `./data/graphs.sqlite`.
Documentation is stored only on disk under `./data/documents/<document-name>/`.
Chapters are folders, nested chapters are nested folders, and every page body is stored as `index.md`.

Example:

```text
data/documents/default/
  01-chapter-1--chapter-id/
    index.md
    01-subchapter--subchapter-id/
      index.md
      assets/
        image.png
```

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
