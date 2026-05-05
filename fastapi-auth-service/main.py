from __future__ import annotations

import asyncio
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

import paramiko
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel


app = FastAPI(title="Auth Service")

database_path = Path(os.getenv("SQLITE_PATH", "/data/graphs.sqlite"))
documents_path = Path(os.getenv("DOCUMENTS_PATH", "/data/documents"))
local_document_root = os.getenv("WOXVERSE_LOCAL_DOCUMENT_ROOT", "").lower() in {"1", "true", "yes"}
local_mode = os.getenv("WOXVERSE_LOCAL_MODE", "").lower() in {"1", "true", "yes"}

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


class AssetUploadResponse(BaseModel):
    relative_path: str
    url: str


class PlaygroundRunRequest(BaseModel):
    code: str


class PlaygroundRunResponse(BaseModel):
    success: bool
    exit_code: int
    stdout: str
    stderr: str


class TerminalOpenRequest(BaseModel):
    connection_string: str = ""
    host: str = ""
    port: int = 22
    username: str = ""
    password: str = ""


class TerminalOpenResponse(BaseModel):
    session_id: str
    host: str
    port: int
    username: str


@dataclass
class TerminalSession:
    client: paramiko.SSHClient
    channel: paramiko.Channel


terminal_sessions: dict[str, TerminalSession] = {}


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


def get_document_directory(document_name: str) -> Path:
    document_directory = documents_path if local_document_root and document_name == "default" else documents_path / document_name
    document_directory.mkdir(parents=True, exist_ok=True)
    return document_directory


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ]+", "-", value.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "section"


def get_section_directory(parent_directory: Path, section: DocSection, index: int) -> Path:
    return parent_directory / f"{index:02d}-{slugify(section.title)}--{section.id}"


def find_section_directory(parent_directory: Path, section_id: str) -> Path | None:
    matches = sorted(parent_directory.glob(f"*--{section_id}"))
    return matches[0] if matches else None


def find_section_directory_recursive(document_name: str, section_id: str) -> Path | None:
    document_directory = get_document_directory(document_name)
    matches = sorted(document_directory.rglob(f"*--{section_id}"))
    return matches[0] if matches else None


def sanitize_filename(filename: str) -> str:
    path = Path(filename)
    stem = slugify(path.stem)
    suffix = re.sub(r"[^a-zA-Z0-9.]", "", path.suffix.lower()) or ".bin"
    return f"{stem}{suffix}"


def parse_section_directory_name(directory: Path) -> tuple[int, str, str]:
    match = re.match(r"^(\d+)-(.+)--(.+)$", directory.name)

    if not match:
        return (9999, directory.name.replace("-", " "), directory.name)

    order = int(match.group(1))
    title = match.group(2).replace("-", " ")
    section_id = match.group(3)
    return (order, title, section_id)


def scan_document_sections(parent_directory: Path) -> list[DocSection]:
    sections: list[DocSection] = []

    for section_directory in sorted(
        [
            path
            for path in parent_directory.iterdir()
            if path.is_dir()
            and path.name != "assets"
            and parse_section_directory_name(path)[0] != 9999
        ],
        key=lambda path: parse_section_directory_name(path)[0],
    ):
        _, title, section_id = parse_section_directory_name(section_directory)
        section_file = section_directory / "index.md"
        sections.append(
            DocSection(
                id=section_id,
                title=title,
                content=section_file.read_text(encoding="utf-8") if section_file.exists() else "",
                children=scan_document_sections(section_directory),
            )
        )

    for markdown_file in sorted(parent_directory.glob("*.md")):
        if markdown_file.name == "index.md":
            continue

        section_id = markdown_file.stem
        if any(section.id == section_id for section in sections):
            continue

        sections.append(
            DocSection(
                id=section_id,
                title=section_id.replace("-", " "),
                content=markdown_file.read_text(encoding="utf-8"),
                children=[],
            )
        )

    return sections


def write_markdown_files(
    document_name: str,
    sections: list[DocSection],
    parent_directory: Path | None = None,
) -> set[Path]:
    document_directory = get_document_directory(document_name)
    current_directory = parent_directory or document_directory
    active_paths: set[Path] = set()

    for index, section in enumerate(sections, start=1):
        previous_directory = find_section_directory(current_directory, section.id)
        section_directory = get_section_directory(current_directory, section, index)

        if previous_directory and previous_directory != section_directory:
            previous_directory.rename(section_directory)

        section_directory.mkdir(parents=True, exist_ok=True)
        section_file = section_directory / "index.md"
        section_file.write_text(section.content, encoding="utf-8")
        active_paths.add(section_directory)
        active_paths.add(section_file)
        active_paths.update(write_markdown_files(document_name, section.children, section_directory))

    return active_paths


def remove_stale_markdown_files(document_name: str, active_paths: set[Path]) -> None:
    document_directory = get_document_directory(document_name)

    def remove_stale_in_directory(directory: Path) -> None:
        for markdown_file in sorted(directory.glob("*.md"), reverse=True):
            if markdown_file not in active_paths:
                markdown_file.unlink()

        section_directories = [
            child
            for child in directory.iterdir()
            if child.is_dir() and parse_section_directory_name(child)[0] != 9999
        ]

        for section_directory in sorted(section_directories, key=lambda path: len(path.parts), reverse=True):
            remove_stale_in_directory(section_directory)

            if section_directory not in active_paths and not any(section_directory.iterdir()):
                section_directory.rmdir()

    remove_stale_in_directory(document_directory)


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    if local_mode:
        return

    if authorization != "Bearer hardcoded-token":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )


def require_token_value(authorization: str | None) -> None:
    if local_mode:
        return

    if authorization != "Bearer hardcoded-token":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )


def parse_terminal_target(payload: TerminalOpenRequest) -> tuple[str, int, str, str]:
    host = payload.host.strip()
    port = payload.port
    username = payload.username.strip()
    password = payload.password

    if payload.connection_string.strip():
        parsed = urlparse(payload.connection_string.strip())

        if parsed.scheme and parsed.scheme != "ssh":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only ssh:// connections are supported")

        host = parsed.hostname or host
        port = parsed.port or port
        username = parsed.username or username
        password = parsed.password or password

    if not host or not username or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Host, username and password are required",
        )

    return host, port, username, password


def close_terminal_session(session_id: str) -> None:
    session = terminal_sessions.pop(session_id, None)

    if session is None:
        return

    try:
        session.channel.close()
    finally:
        session.client.close()


@app.on_event("startup")
def startup() -> None:
    init_database()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest) -> LoginResponse:
    if local_mode:
        return LoginResponse(authenticated=True, token="hardcoded-token")

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
    return DocumentData(sections=scan_document_sections(get_document_directory(document_name)))


@app.put(
    "/documents/{document_name}",
    response_model=DocumentData,
    dependencies=[Depends(require_token)],
)
def save_document(document_name: str, document: DocumentData) -> DocumentData:
    active_paths = write_markdown_files(document_name, document.sections)
    remove_stale_markdown_files(document_name, active_paths)
    return document


@app.post(
    "/documents/{document_name}/sections/{section_id}/assets",
    response_model=AssetUploadResponse,
    dependencies=[Depends(require_token)],
)
def upload_document_asset(
    document_name: str,
    section_id: str,
    file: Annotated[UploadFile, File()],
) -> AssetUploadResponse:
    section_directory = find_section_directory_recursive(document_name, section_id)

    if section_directory is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Section directory not found. Save the document before uploading assets.",
        )

    safe_filename = sanitize_filename(file.filename or "image")
    assets_directory = section_directory / "assets"
    assets_directory.mkdir(parents=True, exist_ok=True)
    destination = assets_directory / safe_filename

    counter = 1
    while destination.exists():
        destination = assets_directory / f"{Path(safe_filename).stem}-{counter}{Path(safe_filename).suffix}"
        counter += 1

    with destination.open("wb") as output:
        shutil.copyfileobj(file.file, output)

    return AssetUploadResponse(
        relative_path=f"assets/{destination.name}",
        url=f"/documents/{document_name}/sections/{section_id}/assets/{destination.name}",
    )


@app.get("/documents/{document_name}/sections/{section_id}/assets/{filename}")
def get_document_asset(document_name: str, section_id: str, filename: str) -> FileResponse:
    section_directory = find_section_directory_recursive(document_name, section_id)

    if section_directory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")

    asset_path = section_directory / "assets" / sanitize_filename(filename)

    if not asset_path.exists() or not asset_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

    return FileResponse(asset_path)


@app.post(
    "/playground/run",
    response_model=PlaygroundRunResponse,
    dependencies=[Depends(require_token)],
)
def run_playground_code(payload: PlaygroundRunRequest) -> PlaygroundRunResponse:
    try:
        completed = subprocess.run(
            [sys.executable, "-c", payload.code],
            capture_output=True,
            text=True,
            cwd=documents_path,
            timeout=5,
        )
    except subprocess.TimeoutExpired as error:
        return PlaygroundRunResponse(
            success=False,
            exit_code=124,
            stdout=error.stdout or "",
            stderr=(error.stderr or "") + ("\nExecution timed out after 5 seconds." if error.stderr else "Execution timed out after 5 seconds."),
        )

    return PlaygroundRunResponse(
        success=completed.returncode == 0,
        exit_code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


@app.post(
    "/terminal/sessions/open",
    response_model=TerminalOpenResponse,
    dependencies=[Depends(require_token)],
)
def open_terminal_session(payload: TerminalOpenRequest) -> TerminalOpenResponse:
    host, port, username, password = parse_terminal_target(payload)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            timeout=8,
        )
        channel = client.invoke_shell(term="xterm", width=140, height=36)
        channel.settimeout(0.0)
    except Exception as error:
        client.close()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unable to open terminal session: {error}",
        ) from error

    session_id = secrets.token_urlsafe(18)
    terminal_sessions[session_id] = TerminalSession(client=client, channel=channel)
    return TerminalOpenResponse(session_id=session_id, host=host, port=port, username=username)


@app.post(
    "/terminal/sessions/{session_id}/close",
    dependencies=[Depends(require_token)],
)
def close_terminal_session_route(session_id: str) -> dict[str, bool]:
    close_terminal_session(session_id)
    return {"closed": True}


@app.websocket("/terminal/sessions/{session_id}/ws")
async def terminal_session_ws(websocket: WebSocket, session_id: str, token: str | None = None) -> None:
    if token != "hardcoded-token":
        await websocket.close(code=4401)
        return

    session = terminal_sessions.get(session_id)

    if session is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()

    async def pump_terminal_output() -> None:
        while True:
            if session.channel.closed or session.channel.exit_status_ready():
                break

            if session.channel.recv_ready():
                data = session.channel.recv(4096)

                if not data:
                    break

                await websocket.send_text(data.decode("utf-8", errors="ignore"))
            else:
                await asyncio.sleep(0.03)

    output_task = asyncio.create_task(pump_terminal_output())

    try:
        while True:
            data = await websocket.receive_text()
            session.channel.send(data)
    except WebSocketDisconnect:
        pass
    finally:
        output_task.cancel()
        close_terminal_session(session_id)
