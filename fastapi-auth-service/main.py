import os
import secrets

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


app = FastAPI(title="Auth Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    login: str
    password: str


class LoginResponse(BaseModel):
    authenticated: bool
    token: str


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
