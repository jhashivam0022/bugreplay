import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, or_, select, text
from sqlalchemy.orm import Session

from .database import Base, SessionLocal, engine
from .models import Incident, Project, User, Workspace, WorkspaceMember
from .schemas import AuthCredentials, EmployeeCreate, IncidentCreate, IncidentRead, PasswordChange, PriorityUpdate, ProjectCreate, ProjectRead, TeamLeadSetup, UserStatusUpdate, WorkspaceAccess, WorkspaceCreate, WorkspaceRead
from .security import SESSION_COOKIE, SESSION_HOURS, hash_password, issue_token, read_token, verify_password

WORKSPACE_NAME = "Acme Engineering"
WORKSPACE_SLUG = "acme-engineering"
STARTER_PROJECTS = [
    ("Web App", "Customer-facing web application."),
    ("API Service", "Backend APIs and data services."),
    ("Platform & DevEx", "Infrastructure, tooling, and developer experience."),
]

STARTER_INCIDENTS = [
    {
        "title": "API requests timing out after deployment",
        "category": "API & INFRASTRUCTURE",
        "symptoms": "Requests to /api/orders started timing out intermittently right after the production deploy. The app looked healthy, but p95 latency jumped from 180 ms to 8 seconds.",
        "cause": "The new release opened a database connection for each request and never returned it to the pool. Under normal traffic the leak was hard to spot.",
        "fix": "1. Reuse the shared connection pool instead of creating a client per request.\n2. Make sure every transaction returns its connection in a finally block.\n3. Watch the pool’s active connection count after deploying.",
        "tags": ["Postgres", "API", "Performance"],
        "author": "Aarav Mehta",
        "verified": True,
        "project_slug": "api-service",
    },
    {
        "title": "Hydration mismatch on the dashboard after refresh",
        "category": "FRONTEND",
        "symptoms": "The dashboard flashed, then React logged ‘Text content does not match server-rendered HTML.’ It only happened on a hard refresh for users in different time zones.",
        "cause": "A date was formatted using the server’s timezone during render and the browser’s local timezone during hydration.",
        "fix": "Format dates with an explicit timezone on both server and client, or render locale-specific values after hydration. We used Intl.DateTimeFormat with timeZone: UTC for the shared initial render.",
        "tags": ["React", "SSR", "Hydration"],
        "author": "Sofia Kim",
        "verified": True,
        "project_slug": "web-app",
    },
    {
        "title": "Docker services can’t resolve each other by name",
        "category": "DEVELOPMENT ENVIRONMENT",
        "symptoms": "The worker container returned getaddrinfo ENOTFOUND api, while both containers appeared to be running.",
        "cause": "The services were started separately with docker run, so they were attached to different default networks.",
        "fix": "Start both services from the same Compose project and use the Compose service name as the hostname. Confirm the shared network with docker network inspect.",
        "tags": ["Docker", "Networking", "Local dev"],
        "author": "Nikhil Rao",
        "verified": True,
        "project_slug": "platform-devex",
    },
    {
        "title": "Users get logged out after leaving a tab idle",
        "category": "AUTHENTICATION",
        "symptoms": "After leaving the app open for a while, the next API action returned 401 and sent users to the sign-in screen, even though their refresh token was still valid.",
        "cause": "The API client retried the original request before the asynchronous refresh-token call had completed.",
        "fix": "Queue requests while a token refresh is in flight. Update the shared access token once, then replay queued requests. Handle a failed refresh by clearing the session and prompting a fresh sign-in.",
        "tags": ["Auth", "API", "React"],
        "author": "Amara Okafor",
        "verified": False,
        "project_slug": "web-app",
    },
    {
        "title": "Database migration hangs on a table lock",
        "category": "DATABASE",
        "symptoms": "A routine migration appeared stuck in production and blocked writes to the accounts table.",
        "cause": "The migration added a non-null column with a default value in one operation, forcing a full table rewrite while holding an exclusive lock.",
        "fix": "Use an expand-and-contract migration: add the nullable column first, backfill in small batches, then add the constraint once the data is ready.",
        "tags": ["Postgres", "Migrations", "Production"],
        "author": "Luca Moretti",
        "verified": True,
        "project_slug": "api-service",
    },
]


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)

    # create_all does not add columns to an existing local database.
    existing_columns = {column["name"] for column in inspect(engine).get_columns("incidents")}
    with engine.begin() as connection:
        if "workspace_id" not in existing_columns:
            connection.execute(text("ALTER TABLE incidents ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id)"))
        if "project_id" not in existing_columns:
            connection.execute(text("ALTER TABLE incidents ADD COLUMN project_id INTEGER REFERENCES projects(id)"))
        if "priority" not in existing_columns:
            connection.execute(text("ALTER TABLE incidents ADD COLUMN priority VARCHAR(8) NOT NULL DEFAULT 'medium'"))

    with SessionLocal() as session:
        workspace = session.scalar(select(Workspace).where(Workspace.slug == WORKSPACE_SLUG))
        if workspace is None:
            workspace = Workspace(name=WORKSPACE_NAME, slug=WORKSPACE_SLUG)
            session.add(workspace)
            session.flush()
        projects_by_slug = {}
        for name, description in STARTER_PROJECTS:
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            project = session.scalar(select(Project).where(Project.workspace_id == workspace.id, Project.slug == slug))
            if project is None:
                project = Project(workspace_id=workspace.id, name=name, slug=slug, description=description)
                session.add(project)
                session.flush()
            projects_by_slug[slug] = project
        session.execute(
            text("UPDATE incidents SET workspace_id = :workspace_id WHERE workspace_id IS NULL"),
            {"workspace_id": workspace.id},
        )
        for sample in STARTER_INCIDENTS:
            existing = session.scalar(select(Incident).where(Incident.title == sample["title"]))
            if existing is not None and existing.project_id is None:
                existing.project_id = projects_by_slug[sample["project_slug"]].id
        if session.scalar(select(Incident.id).limit(1)) is None:
            for days_ago, item in enumerate(STARTER_INCIDENTS, start=2):
                seed = {
                    "workspace_id": workspace.id,
                    "project_id": projects_by_slug[item["project_slug"]].id,
                    "title": item["title"],
                    "category": item["category"],
                    "symptoms": item["symptoms"],
                    "cause": item["cause"],
                    "fix": item["fix"],
                    "tags": json.dumps(item["tags"]),
                    "author": item["author"],
                    "verified": item["verified"],
                    "created_at": datetime.now(timezone.utc) - timedelta(days=days_ago),
                }
                session.add(Incident(**seed))
        session.commit()
    yield


app = FastAPI(title="BugReplay API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)


def get_session():
    with SessionLocal() as session:
        yield session


def resolve_workspace(session: Session, workspace_id: int | None) -> Workspace:
    if workspace_id is None:
        workspace = session.scalar(select(Workspace).where(Workspace.slug == WORKSPACE_SLUG))
    else:
        workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


def get_current_user(request: Request, session: Session = Depends(get_session)) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    user_id = read_token(token) if token else None
    user = session.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Please sign in")
    allowed_during_password_change = {"/api/auth/me", "/api/auth/change-password", "/api/auth/logout"}
    if user.must_change_password and request.url.path not in allowed_during_password_change:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Change your temporary password to continue")
    return user


def require_workspace_member(session: Session, user: User, workspace_id: int | None):
    workspace = resolve_workspace(session, workspace_id)
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not belong to this workspace")
    return workspace, membership


def require_team_lead(session: Session, user: User, workspace_id: int | None):
    workspace, membership = require_workspace_member(session, user, workspace_id)
    if membership.role != "team_lead":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Team Lead access is required")
    return workspace, membership


def set_session_cookie(response: Response, user: User):
    secure = os.getenv("BUGREPLAY_COOKIE_SECURE", "false").lower() == "true"
    response.set_cookie(
        key=SESSION_COOKIE,
        value=issue_token(user.id),
        max_age=SESSION_HOURS * 60 * 60,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )


def user_payload(user: User):
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "must_change_password": user.must_change_password,
        "is_active": user.is_active,
    }


def serialize(incident: Incident) -> IncidentRead:
    return IncidentRead(
        id=incident.id,
        workspace_id=incident.workspace_id,
        project_id=incident.project_id,
        project_name=incident.project.name if incident.project else None,
        title=incident.title,
        category=incident.category,
        symptoms=incident.symptoms,
        cause=incident.cause,
        fix=incident.fix,
        tags=json.loads(incident.tags),
        author=incident.author,
        verified=incident.verified,
        priority=incident.priority,
        created_at=incident.created_at,
    )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/auth/setup-status")
def setup_status(session: Session = Depends(get_session)):
    return {"setup_required": session.scalar(select(User.id).limit(1)) is None}


@app.post("/api/auth/setup")
def setup_team_lead(payload: TeamLeadSetup, response: Response, session: Session = Depends(get_session)):
    if session.scalar(select(User.id).limit(1)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Initial setup has already been completed")
    workspace = session.scalar(select(Workspace).where(Workspace.slug == WORKSPACE_SLUG))
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Default workspace is not initialized")
    user = User(name=payload.name, email=payload.email, password_hash=hash_password(payload.password))
    session.add(user)
    session.flush()
    session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="team_lead"))
    session.commit()
    session.refresh(user)
    set_session_cookie(response, user)
    return {"user": user_payload(user)}


@app.post("/api/auth/login")
def login(payload: AuthCredentials, response: Response, session: Session = Depends(get_session)):
    user = session.scalar(select(User).where(User.email == payload.email))
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Email or password is incorrect")
    set_session_cookie(response, user)
    return {"user": user_payload(user)}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(key=SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return {"status": "signed out"}


@app.get("/api/auth/me")
def current_user(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.name)
    ).all()
    return {
        "user": user_payload(user),
        "workspaces": [
            {"id": workspace.id, "name": workspace.name, "slug": workspace.slug, "role": role}
            for workspace, role in rows
        ],
    }


@app.post("/api/auth/change-password")
def change_password(
    payload: PasswordChange,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    session.commit()
    return {"user": user_payload(user)}


@app.get("/api/workspaces", response_model=list[WorkspaceRead])
def list_workspaces(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    return session.scalars(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.name)
    ).all()


@app.post("/api/workspaces", response_model=WorkspaceRead, status_code=status.HTTP_201_CREATED)
def create_workspace(
    payload: WorkspaceCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    can_create = session.scalar(
        select(WorkspaceMember.id).where(
            WorkspaceMember.user_id == user.id,
            WorkspaceMember.role == "team_lead",
        ).limit(1)
    )
    if can_create is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a Team Lead can create a workspace")
    if not payload.name:
        raise HTTPException(status_code=422, detail="Workspace name is required")
    slug = re.sub(r"[^a-z0-9]+", "-", payload.name.lower()).strip("-")
    if not slug:
        raise HTTPException(status_code=422, detail="Workspace name must include a letter or number")
    exists = session.scalar(select(Workspace.id).where(Workspace.slug == slug))
    if exists:
        raise HTTPException(status_code=409, detail="A workspace with that name already exists")
    workspace = Workspace(name=payload.name, slug=slug)
    session.add(workspace)
    session.flush()
    session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="team_lead"))
    session.commit()
    session.refresh(workspace)
    return workspace


@app.get("/api/users")
def list_workspace_users(
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_team_lead(session, user, workspace_id)
    rows = session.execute(
        select(User, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == workspace.id)
        .order_by(User.name)
    ).all()
    return [{**user_payload(member), "role": role} for member, role in rows]


@app.post("/api/users", status_code=status.HTTP_201_CREATED)
def add_employee(
    payload: EmployeeCreate,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_team_lead(session, user, workspace_id)
    if payload.role not in {"employee", "team_lead"}:
        raise HTTPException(status_code=422, detail="Choose Employee or Team Lead")
    employee = session.scalar(select(User).where(User.email == payload.email))
    existing_member = None
    if employee is not None:
        existing_member = session.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.user_id == employee.id,
            )
        )
        if existing_member is not None and employee.id == user.id:
            raise HTTPException(status_code=403, detail="You cannot change your own workspace role")
        if existing_member is not None and existing_member.role == payload.role:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This user already has that role in the workspace")
        if existing_member is not None and existing_member.role == "team_lead" and payload.role == "employee":
            other_team_lead = session.scalar(
                select(WorkspaceMember.id).where(
                    WorkspaceMember.workspace_id == workspace.id,
                    WorkspaceMember.role == "team_lead",
                    WorkspaceMember.user_id != employee.id,
                ).join(User, User.id == WorkspaceMember.user_id).where(User.is_active.is_(True)).limit(1)
            )
            if other_team_lead is None:
                raise HTTPException(status_code=409, detail="The workspace must keep at least one Team Lead")
    else:
        if not payload.temporary_password:
            raise HTTPException(status_code=422, detail="A temporary password is required for a new account")
        employee = User(
            name=payload.name,
            email=payload.email,
            password_hash=hash_password(payload.temporary_password),
            must_change_password=True,
        )
        session.add(employee)
        session.flush()
    if existing_member is not None:
        existing_member.role = payload.role
    else:
        existing_member = WorkspaceMember(workspace_id=workspace.id, user_id=employee.id, role=payload.role)
        session.add(existing_member)
    session.commit()
    session.refresh(employee)
    return {**user_payload(employee), "role": payload.role}


@app.patch("/api/users/{member_id}/status")
def update_employee_status(
    member_id: int,
    payload: UserStatusUpdate,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_team_lead(session, user, workspace_id)
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.user_id == member_id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="This user is not in the workspace")
    if member_id == user.id:
        raise HTTPException(status_code=403, detail="You cannot change your own account status")
    if membership.role == "team_lead" and not payload.is_active:
        other_team_lead = session.scalar(
            select(WorkspaceMember.id).join(User, User.id == WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.role == "team_lead",
                WorkspaceMember.user_id != member_id,
                User.is_active.is_(True),
            ).limit(1)
        )
        if other_team_lead is None:
            raise HTTPException(status_code=409, detail="The workspace must keep at least one active Team Lead")
    employee = session.get(User, member_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="User not found")
    employee.is_active = payload.is_active
    session.commit()
    session.refresh(employee)
    return {**user_payload(employee), "role": membership.role}


@app.delete("/api/users/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_employee(
    member_id: int,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_team_lead(session, user, workspace_id)
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.user_id == member_id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="This user is not in the workspace")
    if member_id == user.id:
        raise HTTPException(status_code=403, detail="You cannot remove yourself from the workspace")
    if membership.role == "team_lead":
        other_team_lead = session.scalar(
            select(WorkspaceMember.id).join(User, User.id == WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.role == "team_lead",
                WorkspaceMember.user_id != member_id,
                User.is_active.is_(True),
            ).limit(1)
        )
        if other_team_lead is None:
            raise HTTPException(status_code=409, detail="The workspace must keep at least one Team Lead")
    session.delete(membership)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/incidents", response_model=list[IncidentRead])
def list_incidents(
    q: str = Query(default="", max_length=500),
    tag: str | None = Query(default=None, max_length=40),
    project_id: int | None = Query(default=None, gt=0),
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_workspace_member(session, user, workspace_id)
    statement = select(Incident).where(Incident.workspace_id == workspace.id)
    if q.strip():
        pattern = f"%{q.strip()}%"
        statement = statement.where(or_(Incident.title.ilike(pattern), Incident.symptoms.ilike(pattern), Incident.cause.ilike(pattern), Incident.fix.ilike(pattern), Incident.tags.ilike(pattern)))
    if tag:
        statement = statement.where(Incident.tags.ilike(f"%{tag.strip()}%"))
    if project_id is not None:
        statement = statement.where(Incident.project_id == project_id)
    incidents = session.scalars(statement.order_by(Incident.created_at.desc(), Incident.id.desc())).all()
    return [serialize(incident) for incident in incidents]


@app.post("/api/incidents", response_model=IncidentRead, status_code=status.HTTP_201_CREATED)
def create_incident(
    payload: IncidentCreate,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not payload.title or not payload.symptoms or not payload.cause or not payload.fix:
        raise HTTPException(status_code=422, detail="Title, symptoms, root cause, and fix are required.")
    workspace, membership = require_workspace_member(session, user, workspace_id)
    if payload.verified and membership.role != "team_lead":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a Team Lead can verify an incident")
    if payload.project_id is not None:
        project = session.get(Project, payload.project_id)
        if project is None or project.workspace_id != workspace.id:
            raise HTTPException(status_code=422, detail="Choose a project from this workspace")
    category = payload.category or (payload.tags[0].upper() if payload.tags else "TEAM INCIDENT")
    incident = Incident(
        workspace_id=workspace.id,
        project_id=payload.project_id,
        title=payload.title,
        category=category,
        symptoms=payload.symptoms,
        cause=payload.cause,
        fix=payload.fix,
        tags=json.dumps(payload.tags),
        author=user.name,
        verified=payload.verified,
        priority=payload.priority,
        created_at=datetime.now(timezone.utc),
    )
    session.add(incident)
    session.commit()
    session.refresh(incident)
    return serialize(incident)


@app.get("/api/projects", response_model=list[ProjectRead])
def list_projects(
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_workspace_member(session, user, workspace_id)
    projects = session.scalars(
        select(Project).where(Project.workspace_id == workspace.id).order_by(Project.name)
    ).all()
    return projects


@app.post("/api/projects", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_workspace_member(session, user, workspace_id)
    if not payload.name:
        raise HTTPException(status_code=422, detail="Project name is required")
    slug = re.sub(r"[^a-z0-9]+", "-", payload.name.lower()).strip("-")
    if not slug:
        raise HTTPException(status_code=422, detail="Project name must include a letter or number")
    exists = session.scalar(select(Project.id).where(Project.workspace_id == workspace.id, Project.slug == slug))
    if exists:
        raise HTTPException(status_code=409, detail="A project with that name already exists")
    project = Project(workspace_id=workspace.id, name=payload.name, slug=slug, description=payload.description)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@app.patch("/api/incidents/{incident_id}/priority", response_model=IncidentRead)
def update_incident_priority(
    incident_id: int,
    payload: PriorityUpdate,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    incident = session.get(Incident, incident_id)
    workspace, _ = require_workspace_member(session, user, workspace_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    incident.priority = payload.priority
    session.commit()
    session.refresh(incident)
    return serialize(incident)


@app.patch("/api/incidents/{incident_id}/verification", response_model=IncidentRead)
def verify_incident(
    incident_id: int,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_team_lead(session, user, workspace_id)
    incident = session.get(Incident, incident_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    incident.verified = True
    session.commit()
    session.refresh(incident)
    return serialize(incident)


@app.get("/api/incidents/{incident_id}", response_model=IncidentRead)
def get_incident(
    incident_id: int,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    incident = session.get(Incident, incident_id)
    workspace, _ = require_workspace_member(session, user, workspace_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    return serialize(incident)
