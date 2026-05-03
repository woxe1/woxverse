from __future__ import annotations

import os
import secrets
import sqlite3
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


app = FastAPI(title="Auth Service")

database_path = Path(os.getenv("SQLITE_PATH", "/data/graphs.sqlite"))
documents_path = Path(os.getenv("DOCUMENTS_PATH", "/data/documents"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class GraphNode(BaseModel):
    id: str
    label: str
    x: float
    y: float
    document_section_id: str | None = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str = "Relation"


class GraphData(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge] = []


class DocSection(BaseModel):
    id: str
    title: str
    content: str = ""
    children: list[DocSection] = []


class DocumentData(BaseModel):
    sections: list[DocSection] = []


class LoginRequest(BaseModel):
    login: str
    password: str


class LoginResponse(BaseModel):
    authenticated: bool
    token: str


def get_connection() -> sqlite3.Connection:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    return connection


def init_database() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS graphs (
                name TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                name TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


def get_document_directory(document_name: str) -> Path:
    document_directory = documents_path / document_name
    document_directory.mkdir(parents=True, exist_ok=True)
    return document_directory


def get_section_file(document_name: str, section_id: str) -> Path:
    return get_document_directory(document_name) / f"{section_id}.md"


def strip_section_content(sections: list[DocSection]) -> list[dict[str, Any]]:
    return [
        {
            "id": section.id,
            "title": section.title,
            "children": strip_section_content(section.children),
        }
        for section in sections
    ]


def write_markdown_files(document_name: str, sections: list[DocSection]) -> set[str]:
    written_section_ids: set[str] = set()

    for section in sections:
        section_file = get_section_file(document_name, section.id)
        section_file.write_text(section.content, encoding="utf-8")
        written_section_ids.add(section.id)
        written_section_ids.update(write_markdown_files(document_name, section.children))

    return written_section_ids


def remove_stale_markdown_files(document_name: str, active_section_ids: set[str]) -> None:
    document_directory = get_document_directory(document_name)

    for section_file in document_directory.glob("*.md"):
        if section_file.stem not in active_section_ids:
            section_file.unlink()


def hydrate_section_content(document_name: str, sections: list[DocSection]) -> list[DocSection]:
    hydrated_sections: list[DocSection] = []

    for section in sections:
        section_file = get_section_file(document_name, section.id)
        content = section_file.read_text(encoding="utf-8") if section_file.exists() else section.content
        hydrated_sections.append(
            DocSection(
                id=section.id,
                title=section.title,
                content=content,
                children=hydrate_section_content(document_name, section.children),
            )
        )

    return hydrated_sections


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    if authorization != "Bearer hardcoded-token":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )


@app.on_event("startup")
def startup() -> None:
    init_database()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest) -> LoginResponse:
    expected_login = os.getenv("AUTH_LOGIN", "")
    expected_password = os.getenv("AUTH_PASSWORD", "")

    login_matches = secrets.compare_digest(payload.login, expected_login)
    password_matches = secrets.compare_digest(payload.password, expected_password)

    if not login_matches or not password_matches:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid login or password",
        )

    return LoginResponse(authenticated=True, token="hardcoded-token")


@app.get(
    "/graphs/{graph_name}",
    response_model=GraphData,
    dependencies=[Depends(require_token)],
)
def get_graph(graph_name: str) -> GraphData:
    with get_connection() as connection:
        row = connection.execute(
            "SELECT data FROM graphs WHERE name = ?",
            (graph_name,),
        ).fetchone()

    if row is None:
        return GraphData(nodes=[], edges=[])

    return GraphData.model_validate_json(row["data"])


@app.put(
    "/graphs/{graph_name}",
    response_model=GraphData,
    dependencies=[Depends(require_token)],
)
def save_graph(graph_name: str, graph: GraphData) -> GraphData:
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO graphs (name, data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(name) DO UPDATE SET
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
            """,
            (graph_name, graph.model_dump_json()),
        )

    return graph


@app.get(
    "/documents/{document_name}",
    response_model=DocumentData,
    dependencies=[Depends(require_token)],
)
def get_document(document_name: str) -> DocumentData:
    with get_connection() as connection:
        row = connection.execute(
            "SELECT data FROM documents WHERE name = ?",
            (document_name,),
        ).fetchone()

    if row is None:
        return DocumentData(sections=[])

    document = DocumentData.model_validate_json(row["data"])
    return DocumentData(
        sections=hydrate_section_content(document_name, document.sections),
    )


@app.put(
    "/documents/{document_name}",
    response_model=DocumentData,
    dependencies=[Depends(require_token)],
)
def save_document(document_name: str, document: DocumentData) -> DocumentData:
    active_section_ids = write_markdown_files(document_name, document.sections)
    remove_stale_markdown_files(document_name, active_section_ids)
    document_tree = {
        "sections": strip_section_content(document.sections),
    }

    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO documents (name, data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(name) DO UPDATE SET
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
            """,
            (document_name, DocumentData.model_validate(document_tree).model_dump_json()),
        )

    return document
