import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


MAX_BODY = 10000


class IncidentCreate(BaseModel):
    title: str = Field(min_length=8, max_length=160)
    category: str = Field(default="TEAM INCIDENT", max_length=80)
    symptoms: str = Field(min_length=15, max_length=MAX_BODY)
    cause: str = Field(min_length=10, max_length=MAX_BODY)
    fix: str = Field(min_length=10, max_length=MAX_BODY)
    environment: str = Field(default="", max_length=1000)
    steps: str = Field(default="", max_length=MAX_BODY)
    prevention: str = Field(default="", max_length=MAX_BODY)
    reference_url: str = Field(default="", max_length=500)
    resolution_minutes: int | None = Field(default=None, ge=1, le=100000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    author: str = Field(default="Team member", max_length=100)
    verified: bool = False
    priority: Literal["high", "medium", "low"] = "medium"
    project_id: int | None = None

    @field_validator("title", "category", "symptoms", "cause", "fix", "environment", "steps", "prevention", "reference_url", "author")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("reference_url")
    @classmethod
    def check_reference_url(cls, value: str) -> str:
        if value and not re.match(r"^https?://\S+$", value, re.IGNORECASE):
            raise ValueError("Reference link must start with http:// or https://")
        return value

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(tag.strip()[:40] for tag in values if tag.strip()))


class IncidentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_id: int
    project_id: int | None
    project_name: str | None
    title: str
    category: str
    symptoms: str
    cause: str
    fix: str
    environment: str
    steps: str
    prevention: str
    reference_url: str
    resolution_minutes: int | None
    tags: list[str]
    author: str
    author_id: int | None
    verified: bool
    priority: Literal["high", "medium", "low"]
    created_at: datetime
    updated_at: datetime | None
    can_edit: bool = False


class PriorityUpdate(BaseModel):
    priority: Literal["high", "medium", "low"]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=300)

    @field_validator("name", "description")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_id: int
    name: str
    slug: str
    description: str
    created_at: datetime


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return value.strip()


class WorkspaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str


class AuthCredentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        return value.strip().lower()


class TeamLeadSetup(AuthCredentials):
    name: str = Field(min_length=2, max_length=120)
    workspace_name: str = Field(min_length=2, max_length=120)

    @field_validator("name", "workspace_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return value.strip()


class EmployeeCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    temporary_password: str | None = Field(default=None, min_length=8, max_length=256)
    role: Literal["employee", "team_lead"] = "employee"

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return value.strip()

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        return value.strip().lower()


class UserStatusUpdate(BaseModel):
    is_active: bool


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


class UserRead(BaseModel):
    id: int
    name: str
    email: str
    must_change_password: bool


class WorkspaceAccess(BaseModel):
    id: int
    name: str
    slug: str
    role: str


class IncidentMatch(BaseModel):
    incident: IncidentRead
    score: float


class SearchResponse(BaseModel):
    mode: Literal["semantic", "keyword"]
    unindexed: int
    results: list[IncidentMatch]


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)
    grounded: bool | None = None  # assistant messages only: whether the reply was based on team incidents

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str) -> str:
        return value.strip()


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)

    @field_validator("messages")
    @classmethod
    def must_end_with_question(cls, value: list[ChatMessage]) -> list[ChatMessage]:
        if value[-1].role != "user":
            raise ValueError("The last message must come from the user")
        if not value[-1].content:
            raise ValueError("Write a question first")
        return value
