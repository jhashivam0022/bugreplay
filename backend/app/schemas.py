from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class IncidentCreate(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    category: str = Field(default="TEAM INCIDENT", max_length=80)
    symptoms: str = Field(min_length=3)
    cause: str = Field(min_length=3)
    fix: str = Field(min_length=3)
    tags: list[str] = Field(default_factory=list, max_length=12)
    author: str = Field(default="Team member", max_length=100)
    verified: bool = False
    priority: Literal["high", "medium", "low"] = "medium"
    project_id: int | None = None

    @field_validator("title", "category", "symptoms", "cause", "fix", "author")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

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
    tags: list[str]
    author: str
    verified: bool
    priority: Literal["high", "medium", "low"]
    created_at: datetime


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

    @field_validator("name")
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
