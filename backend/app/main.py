import json
import os
import re
import statistics
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import inspect, or_, select, text
from sqlalchemy.orm import Session, undefer

from . import embeddings, guidance
from .database import Base, SessionLocal, engine
from .models import Incident, Project, User, Workspace, WorkspaceMember
from .schemas import AuthCredentials, EmployeeCreate, ChatRequest, IncidentCreate, IncidentMatch, IncidentRead, PasswordChange, PriorityUpdate, ProjectCreate, ProjectRead, SearchResponse, TeamLeadSetup, UserStatusUpdate, WorkspaceAccess, WorkspaceCreate, WorkspaceRead
from .security import SESSION_COOKIE, SESSION_HOURS, hash_password, issue_token, read_token, verify_password


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
        new_columns = {
            "environment": "TEXT NOT NULL DEFAULT ''",
            "steps": "TEXT NOT NULL DEFAULT ''",
            "prevention": "TEXT NOT NULL DEFAULT ''",
            "reference_url": "VARCHAR(500) NOT NULL DEFAULT ''",
            "resolution_minutes": "INTEGER",
            "author_id": "INTEGER REFERENCES users(id)",
            "updated_at": "TIMESTAMP",
            "embedding": "TEXT",
            "embedding_model": "VARCHAR(80)",
        }
        for name, definition in new_columns.items():
            if name not in existing_columns:
                connection.execute(text(f"ALTER TABLE incidents ADD COLUMN {name} {definition}"))

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
    workspace = session.get(Workspace, workspace_id) if workspace_id is not None else None
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


def serialize(incident: Incident, user: User | None = None, role: str | None = None) -> IncidentRead:
    can_edit = user is not None and (role == "team_lead" or (incident.author_id is not None and incident.author_id == user.id))
    return IncidentRead(
        can_edit=can_edit,
        environment=incident.environment,
        steps=incident.steps,
        prevention=incident.prevention,
        reference_url=incident.reference_url,
        resolution_minutes=incident.resolution_minutes,
        author_id=incident.author_id,
        updated_at=incident.updated_at,
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
    slug = re.sub(r"[^a-z0-9]+", "-", payload.workspace_name.lower()).strip("-")
    if not slug:
        raise HTTPException(status_code=422, detail="Workspace name must include a letter or number")
    workspace = Workspace(name=payload.workspace_name, slug=slug)
    session.add(workspace)
    session.flush()
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


def index_incident(incident: Incident) -> bool:
    """Store an embedding for the incident. Saving must never fail because Ollama is down."""
    try:
        vector = embeddings.embed_text(embeddings.incident_text(incident.title, incident.symptoms, incident.cause, json.loads(incident.tags)))
    except embeddings.EmbeddingUnavailable:
        incident.embedding = None
        incident.embedding_model = None
        return False
    incident.embedding = json.dumps(vector)
    incident.embedding_model = embeddings.EMBED_MODEL
    return True


LAZY_INDEX_LIMIT = 25
MAX_RESULTS = 20


def rank_incidents(session: Session, workspace: Workspace, q: str):
    """Return (mode, unindexed, ranked) where ranked is [(incident, score, cosine, keyword)] best first."""
    incidents = session.scalars(
        select(Incident).options(undefer(Incident.embedding)).where(Incident.workspace_id == workspace.id)
    ).all()

    def full_text(item: Incident) -> str:
        return " ".join([item.title, item.symptoms, item.cause, item.fix, item.environment, " ".join(json.loads(item.tags))])

    unindexed = 0
    try:
        query_vector = embeddings.embed_text(q)
    except embeddings.EmbeddingUnavailable:
        scored = [(item, embeddings.keyword_score(q, full_text(item)), 0.0, 0.0) for item in incidents]
        ranked = sorted((row for row in scored if row[1] > 0), key=lambda row: row[1], reverse=True)
        return "keyword", unindexed, ranked[:MAX_RESULTS]

    scored = []
    budget = LAZY_INDEX_LIMIT
    for item in incidents:
        if (item.embedding is None or item.embedding_model != embeddings.EMBED_MODEL) and budget > 0:
            budget -= 1
            index_incident(item)
        if item.embedding is None:
            unindexed += 1
            continue
        similarity = embeddings.cosine(query_vector, json.loads(item.embedding))
        keyword = embeddings.keyword_score(q, full_text(item))
        # Blend in keyword overlap so exact error strings still rank well.
        scored.append((item, similarity + 0.3 * keyword, similarity, keyword))
    session.commit()
    similarities = [row[2] for row in scored]
    best = max(similarities, default=0.0)
    # Error-shaped text scores 0.5+ against every incident, so a fixed cutoff is not enough: a real
    # match must also stand out from the library's typical score. (Skipped for tiny libraries.)
    baseline = statistics.median(similarities) if len(similarities) >= embeddings.MIN_LIBRARY_FOR_MARGIN else None
    # Keep real matches only: close to the best semantic match and clear of the pack, or sharing the query's own words.
    relevant = [
        row for row in scored
        if (
            row[2] >= embeddings.MIN_RELEVANCE
            and row[2] >= best - embeddings.RELEVANCE_WINDOW
            and (baseline is None or row[2] - baseline >= embeddings.MIN_MARGIN)
        )
        or row[3] >= embeddings.KEYWORD_MATCH
    ]
    ranked = sorted(relevant, key=lambda row: row[1], reverse=True)
    return "semantic", unindexed, ranked[:MAX_RESULTS]


@app.get("/api/incidents/search", response_model=SearchResponse)
def search_incidents(
    q: str = Query(min_length=2, max_length=4000),
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, membership = require_workspace_member(session, user, workspace_id)
    mode, unindexed, ranked = rank_incidents(session, workspace, q)
    return SearchResponse(
        mode=mode,
        unindexed=unindexed,
        results=[IncidentMatch(incident=serialize(item, user, membership.role), score=round(score, 4)) for item, score, _, _ in ranked],
    )


CHAT_SOURCES = 3
CHAT_UNAVAILABLE = "The local AI model did not respond. Check that Ollama is running and the model is installed, then try again."


def ndjson(event: dict) -> str:
    return json.dumps(event) + "\n"


@app.post("/api/incidents/chat")
def incident_chat(
    payload: ChatRequest,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, _ = require_workspace_member(session, user, workspace_id)
    question = payload.messages[-1].content
    earlier_questions = [message.content for message in payload.messages[:-1] if message.role == "user"]
    last_reply = next((message for message in reversed(payload.messages) if message.role == "assistant"), None)
    # A follow-up like "what about the pool size?" only makes sense together with the previous question,
    # and so does any follow-up in a conversation that is already grounded in team incidents.
    in_grounded_chat = last_reply is not None and last_reply.grounded is True
    combine = bool(earlier_questions) and (len(question) < 40 or in_grounded_chat)
    retrieval_query = f"{earlier_questions[-1][:600]}\n{question}" if combine else question
    mode, _, ranked = rank_incidents(session, workspace, retrieval_query)
    if mode == "keyword":
        ranked = [row for row in ranked if row[1] >= 0.5]
    if last_reply is not None and last_reply.grounded is False:
        ranked = [row for row in ranked if row[2] >= embeddings.FOLLOWUP_RELEVANCE]
    # Trusted fixes first: verified incidents, then unverified ones (clearly labelled in the prompt).
    ranked.sort(key=lambda row: (not row[0].verified, -row[1]))
    chosen = [row[0] for row in ranked[:CHAT_SOURCES]]
    system = guidance.build_system(
        [{"title": i.title, "symptoms": i.symptoms, "cause": i.cause, "fix": i.fix, "verified": i.verified} for i in chosen],
        first_turn=len(payload.messages) == 1,
    )
    sources = [{"number": n, "id": i.id, "title": i.title, "verified": i.verified} for n, i in enumerate(chosen, start=1)]
    history = [{"role": message.role, "content": message.content} for message in payload.messages]

    def stream():
        # All database work is finished above; this generator only talks to Ollama.
        yield ndjson({"type": "meta", "grounded": bool(chosen), "sources": sources})
        try:
            for chunk in guidance.stream_chat(system, history):
                yield ndjson({"type": "token", "text": chunk})
        except embeddings.EmbeddingUnavailable:
            yield ndjson({"type": "error", "message": CHAT_UNAVAILABLE})
        yield ndjson({"type": "done"})

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/incidents", response_model=list[IncidentRead])
def list_incidents(
    q: str = Query(default="", max_length=500),
    tag: str | None = Query(default=None, max_length=40),
    project_id: int | None = Query(default=None, gt=0),
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, membership = require_workspace_member(session, user, workspace_id)
    statement = select(Incident).where(Incident.workspace_id == workspace.id)
    if q.strip():
        pattern = f"%{q.strip()}%"
        statement = statement.where(or_(Incident.title.ilike(pattern), Incident.symptoms.ilike(pattern), Incident.cause.ilike(pattern), Incident.fix.ilike(pattern), Incident.tags.ilike(pattern)))
    if tag:
        statement = statement.where(Incident.tags.ilike(f"%{tag.strip()}%"))
    if project_id is not None:
        statement = statement.where(Incident.project_id == project_id)
    incidents = session.scalars(statement.order_by(Incident.created_at.desc(), Incident.id.desc())).all()
    return [serialize(incident, user, membership.role) for incident in incidents]


def apply_incident_fields(incident: Incident, payload: IncidentCreate):
    incident.title = payload.title
    incident.category = payload.category or (payload.tags[0].upper() if payload.tags else "TEAM INCIDENT")
    incident.symptoms = payload.symptoms
    incident.cause = payload.cause
    incident.fix = payload.fix
    incident.environment = payload.environment
    incident.steps = payload.steps
    incident.prevention = payload.prevention
    incident.reference_url = payload.reference_url
    incident.resolution_minutes = payload.resolution_minutes
    incident.tags = json.dumps(payload.tags)
    incident.priority = payload.priority
    incident.project_id = payload.project_id


def check_project(session: Session, workspace: Workspace, project_id: int | None):
    if project_id is not None:
        project = session.get(Project, project_id)
        if project is None or project.workspace_id != workspace.id:
            raise HTTPException(status_code=422, detail="Choose a project from this workspace")


@app.post("/api/incidents", response_model=IncidentRead, status_code=status.HTTP_201_CREATED)
def create_incident(
    payload: IncidentCreate,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, membership = require_workspace_member(session, user, workspace_id)
    if payload.verified and membership.role != "team_lead":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a Team Lead can verify an incident")
    check_project(session, workspace, payload.project_id)
    incident = Incident(
        workspace_id=workspace.id,
        author=user.name,
        author_id=user.id,
        verified=payload.verified,
        created_at=datetime.now(timezone.utc),
    )
    apply_incident_fields(incident, payload)
    index_incident(incident)
    session.add(incident)
    session.commit()
    session.refresh(incident)
    return serialize(incident, user, membership.role)


def load_editable_incident(session: Session, user: User, workspace_id: int, incident_id: int):
    workspace, membership = require_workspace_member(session, user, workspace_id)
    incident = session.get(Incident, incident_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    is_author = incident.author_id is not None and incident.author_id == user.id
    if membership.role != "team_lead" and not is_author:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author or a Team Lead can change this incident")
    return workspace, membership, incident


@app.put("/api/incidents/{incident_id}", response_model=IncidentRead)
def update_incident(
    incident_id: int,
    payload: IncidentCreate,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, membership, incident = load_editable_incident(session, user, workspace_id, incident_id)
    check_project(session, workspace, payload.project_id)
    apply_incident_fields(incident, payload)
    # Only a Team Lead can keep or grant verification; an employee's edit sends the fix back for review.
    incident.verified = payload.verified if membership.role == "team_lead" else False
    incident.updated_at = datetime.now(timezone.utc)
    index_incident(incident)
    session.commit()
    session.refresh(incident)
    return serialize(incident, user, membership.role)


@app.delete("/api/incidents/{incident_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_incident(
    incident_id: int,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _, _, incident = load_editable_incident(session, user, workspace_id, incident_id)
    session.delete(incident)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    workspace, membership = require_workspace_member(session, user, workspace_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    incident.priority = payload.priority
    session.commit()
    session.refresh(incident)
    return serialize(incident, user, membership.role)


@app.patch("/api/incidents/{incident_id}/verification", response_model=IncidentRead)
def verify_incident(
    incident_id: int,
    workspace_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    workspace, membership = require_team_lead(session, user, workspace_id)
    incident = session.get(Incident, incident_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    incident.verified = True
    session.commit()
    session.refresh(incident)
    return serialize(incident, user, membership.role)


@app.get("/api/incidents/{incident_id}", response_model=IncidentRead)
def get_incident(
    incident_id: int,
    workspace_id: int | None = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    incident = session.get(Incident, incident_id)
    workspace, membership = require_workspace_member(session, user, workspace_id)
    if incident is None or incident.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    return serialize(incident, user, membership.role)
