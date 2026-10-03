import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = '/api/incidents';
const shortDate = (value) => {
  const date = new Date(value);
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  if (days === 0) return 'Just now';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days >= 14 ? 's' : ''} ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const initials = (name = 'Team') => name.split(/\s+/).map((part) => part[0] || '').join('').slice(0, 2).toUpperCase();

function BrandMark({ small = false }) {
  return <span className={small ? 'footer-mark' : 'brand-mark'} aria-hidden="true"><svg viewBox="0 0 36 36" focusable="false"><path d="M11.2 10.2a10.5 10.5 0 0 1 15.5 2.3l1.1 2.1" fill="none" stroke="#d9ebd3" strokeWidth="1.8" strokeLinecap="round"/><path d="m23.7 14.4 4.4.3-.6-4.2M24.8 25.8a10.5 10.5 0 0 1-15.5-2.3l-1.1-2.1" fill="none" stroke="#d9ebd3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="m12.3 21.6-4.4-.3.6 4.2" fill="none" stroke="#d9ebd3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><ellipse cx="18" cy="19" rx="4.8" ry="6.2" fill="#fff"/><circle cx="18" cy="12.1" r="2.6" fill="#d9ebd3"/><path d="M18 13.2v11.7M13.8 16.3l-2.2-1.4m10.6 1.4 2.2-1.4m-10.2 6.7-2.2 1.4m10.2-1.4 2.2 1.4" fill="none" stroke="#4b7650" strokeWidth="1.1" strokeLinecap="round"/><circle cx="16.9" cy="11.8" r=".35" fill="#3d6142"/><circle cx="19.1" cy="11.8" r=".35" fill="#3d6142"/></svg></span>;
}

function App() {
  const [authStatus, setAuthStatus] = useState('checking');
  const [authError, setAuthError] = useState('');
  const [user, setUser] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => Number(localStorage.getItem('bugreplay-workspace-id')) || null);
  const [incidents, setIncidents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [view, setView] = useState('library');
  const [searchTerm, setSearchTerm] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [activeTag, setActiveTag] = useState('');
  const [activePriority, setActivePriority] = useState('');
  const [sortNewest, setSortNewest] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [teamMembers, setTeamMembers] = useState([]);
  const [teamError, setTeamError] = useState('');
  const [memberToRemove, setMemberToRemove] = useState(null);
  const [incidentToVerify, setIncidentToVerify] = useState(null);
  const [logoutConfirmationOpen, setLogoutConfirmationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  async function loadWorkspaces() {
    try {
      const response = await fetch('/api/auth/me');
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('Could not load your account.');
      const identity = await response.json();
      const items = identity.workspaces;
      setUser(identity.user);
      setWorkspaces(items);
      const savedId = Number(localStorage.getItem('bugreplay-workspace-id'));
      const chosen = items.find((workspace) => workspace.id === savedId) || items[0];
      if (chosen) {
        localStorage.setItem('bugreplay-workspace-id', String(chosen.id));
        setActiveWorkspaceId(chosen.id);
      }
      return identity;
    } catch {
      setAuthError('Could not connect to BugReplay. Check that the backend is running, then retry.');
      return null;
    }
  }

  async function checkAuthentication() {
    try {
      const response = await fetch('/api/auth/setup-status');
      if (!response.ok) throw new Error();
      const setup = await response.json();
      if (setup.setup_required) {
        setAuthStatus('setup');
        return;
      }
      const identity = await loadWorkspaces();
      if (!identity) {
        setAuthStatus('login');
        return;
      }
      setAuthStatus(identity.user.must_change_password ? 'change-password' : 'authenticated');
    } catch {
      setAuthError('Could not connect to BugReplay. Check that the backend is running, then retry.');
      setAuthStatus('login');
    }
  }

  async function loadIncidents(workspaceId = activeWorkspaceId) {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const response = await fetch(`${API}?workspace_id=${workspaceId}`);
      if (response.status === 401) { setAuthStatus('login'); return; }
      if (!response.ok) throw new Error('The incident service could not load your library.');
      const items = await response.json();
      setIncidents(items);
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
      setError('');
    } catch {
      setError('Could not connect to the BugReplay API. Start the backend, then refresh this page.');
    } finally {
      setLoading(false);
    }
  }

  async function loadProjects(workspaceId = activeWorkspaceId) {
    if (!workspaceId) return;
    try {
      const response = await fetch(`/api/projects?workspace_id=${workspaceId}`);
      if (response.status === 401) { setAuthStatus('login'); return; }
      if (!response.ok) throw new Error();
      setProjects(await response.json());
    } catch {
      setError('Could not load workspace projects. Start the backend, then refresh this page.');
    }
  }

  useEffect(() => { checkAuthentication(); }, []);
  useEffect(() => {
    if (authStatus === 'authenticated' && activeWorkspaceId) {
      loadIncidents(activeWorkspaceId);
      loadProjects(activeWorkspaceId);
    }
  }, [authStatus, activeWorkspaceId]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!noteOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') { setNoteOpen(false); setSelectedId(null); } };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [noteOpen]);

  const tags = useMemo(() => [...new Set(incidents.flatMap((item) => item.tags))].sort(), [incidents]);
  const matches = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    let results = incidents.filter((item) => {
      const text = [item.title, item.category, item.symptoms, item.cause, item.fix, ...item.tags].join(' ').toLowerCase();
      return (!query || text.includes(query))
        && (!activeTag || item.tags.includes(activeTag))
        && (!activePriority || item.priority === activePriority)
        && (!projectFilter || item.project_id === Number(projectFilter))
    });
    if (sortNewest) results = [...results].reverse();
    return results;
  }, [incidents, searchTerm, projectFilter, activeTag, activePriority, sortNewest]);
  const selected = incidents.find((item) => item.id === selectedId);

  async function updateIncidentPriority(id, priority) {
    try {
      const response = await fetch(`${API}/${id}/priority?workspace_id=${activeWorkspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail || 'Could not update incident priority.');
      }
      const updated = await response.json();
      setIncidents((items) => items.map((item) => item.id === id ? updated : item));
      setToast(`Priority changed to ${priority}.`);
    } catch (exception) {
      setError(exception.message || 'Could not update incident priority.');
    }
  }

  async function createIncident(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const tagList = String(form.get('tags')).split(',').map((tag) => tag.trim()).filter(Boolean);
    const payload = {
      title: String(form.get('title')).trim(),
      category: (tagList[0] || 'TEAM INCIDENT').toUpperCase(),
      symptoms: String(form.get('symptoms')).trim(),
      cause: String(form.get('cause')).trim(),
      fix: String(form.get('fix')).trim(),
      priority: String(form.get('priority') || 'medium'),
      tags: tagList,
      author: String(form.get('author')).trim() || 'Team member',
      verified: form.get('verified') === 'on',
      project_id: form.get('project_id') ? Number(form.get('project_id')) : null,
    };
    try {
      const response = await fetch(`${API}?workspace_id=${activeWorkspaceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail?.[0]?.msg || 'Could not save this incident.');
      }
      const created = await response.json();
      setIncidents((items) => [created, ...items]);
      setSelectedId(created.id);
      setView('library');
      setSearchTerm('');
      setActiveTag('');
      setDialogOpen(false);
      formElement.reset();
      setToast('Incident added to the shared library.');
    } catch (exception) {
      setError(exception.message || 'Could not save this incident. Please try again.');
    }
  }

  async function createProject(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/projects?workspace_id=${activeWorkspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(form.get('name')).trim(), description: String(form.get('description')).trim() }),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.detail || 'Could not create this project.');
      setProjects((items) => [...items, created].sort((a, b) => a.name.localeCompare(b.name)));
      setProjectFilter(String(created.id));
      setProjectDialogOpen(false);
      setError('');
      setToast(`${created.name} added to this workspace.`);
    } catch (exception) {
      setError(exception.message || 'Could not create this project. Please try again.');
    }
  }

  function changeView(nextView) {
    setView(nextView);
    if (nextView === 'library') setSelectedId(incidents[0]?.id ?? null);
  }

  function switchWorkspace(workspaceId) {
    localStorage.setItem('bugreplay-workspace-id', String(workspaceId));
    setActiveWorkspaceId(workspaceId);
    setWorkspaceMenuOpen(false);
    setIncidents([]);
    setProjects([]);
    setSelectedId(null);
    setProjectFilter('');
    setActiveTag('');
    setActivePriority('');
    setSearchTerm('');
    setView('library');
  }

  async function createWorkspace(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(form.get('name')).trim() }),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.detail || 'Could not create this workspace.');
      setWorkspaces((items) => [...items, { ...created, role: 'team_lead' }].sort((a, b) => a.name.localeCompare(b.name)));
      setWorkspaceDialogOpen(false);
      setError('');
      switchWorkspace(created.id);
      setToast(`${created.name} workspace created.`);
    } catch (exception) {
      setError(exception.message || 'Could not create this workspace. Please try again.');
    }
  }

  async function submitAuthentication(event, mode) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim();
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const confirmPassword = String(form.get('confirm_password') || '');
    if (mode === 'setup' && password !== confirmPassword) {
      setAuthError('The passwords do not match.');
      return;
    }
    setAuthError('');
    try {
      const response = await fetch(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'setup' ? { name, email, password } : { email, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Please check your details and try again.');
      setUser(result.user);
      const identity = await loadWorkspaces();
      if (!identity) throw new Error('Signed in, but could not load workspace access.');
      setAuthStatus(identity.user.must_change_password ? 'change-password' : 'authenticated');
    } catch (exception) {
      setAuthError(exception.message || 'Could not sign in. Please try again.');
    }
  }

  async function submitPasswordChange(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('current_password') || '');
    const newPassword = String(form.get('new_password') || '');
    if (newPassword !== String(form.get('confirm_password') || '')) {
      setAuthError('The new passwords do not match.');
      return;
    }
    setAuthError('');
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not change password.');
      setUser(result.user);
      setAuthStatus('authenticated');
      setToast('Password updated. Welcome to BugReplay.');
    } catch (exception) {
      setAuthError(exception.message || 'Could not change password. Please try again.');
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthStatus('login');
    setUser(null);
    setIncidents([]);
    setProjects([]);
    setSelectedId(null);
    setNoteOpen(false);
  }

  async function openTeamMembers() {
    setTeamError('');
    setNoteOpen(false);
    setSelectedId(null);
    setView('team');
    try {
      const response = await fetch(`/api/users?workspace_id=${activeWorkspaceId}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not load workspace members.');
      setTeamMembers(result);
    } catch (exception) {
      setTeamError(exception.message || 'Could not load workspace members.');
    }
  }

  async function addEmployee(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const requestedRole = String(form.get('role') || 'employee');
    const existingMember = teamMembers.find((member) => member.email.toLowerCase() === String(form.get('email')).trim().toLowerCase());
    setTeamError('');
    try {
      const response = await fetch(`/api/users?workspace_id=${activeWorkspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(form.get('name')).trim(),
          email: String(form.get('email')).trim(),
          temporary_password: String(form.get('temporary_password') || '').trim() || null,
          role: requestedRole,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not add this employee.');
      setTeamMembers((members) => [...members.filter((member) => member.id !== result.id), result].sort((a, b) => a.name.localeCompare(b.name)));
      formElement.reset();
      setToast(existingMember ? `${result.name}'s role is now ${result.role === 'team_lead' ? 'Team Lead' : 'Employee'}.` : result.must_change_password ? `${result.name} added as ${result.role === 'team_lead' ? 'a Team Lead' : 'an employee'}. They must change the temporary password at sign-in.` : `${result.name} added as ${result.role === 'team_lead' ? 'a Team Lead' : 'an employee'}.`);
    } catch (exception) {
      setTeamError(exception.message || 'Could not add this employee.');
    }
  }

  async function toggleEmployeeStatus(member) {
    const nextStatus = !member.is_active;
    try {
      const response = await fetch(`/api/users/${member.id}/status?workspace_id=${activeWorkspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: nextStatus }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not update this account.');
      setTeamMembers((members) => members.map((item) => item.id === result.id ? result : item));
      setToast(nextStatus ? `${member.name} can sign in again.` : `${member.name}'s account is deactivated across all workspaces.`);
    } catch (exception) {
      setTeamError(exception.message || 'Could not update this account.');
    }
  }

  async function confirmRemoveEmployee() {
    if (!memberToRemove) return;
    try {
      const response = await fetch(`/api/users/${memberToRemove.id}?workspace_id=${activeWorkspaceId}`, { method: 'DELETE' });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.detail || 'Could not remove this team member.');
      }
      setTeamMembers((members) => members.filter((item) => item.id !== memberToRemove.id));
      setToast(`${memberToRemove.name} was removed from this workspace.`);
      setMemberToRemove(null);
    } catch (exception) {
      setTeamError(exception.message || 'Could not remove this team member.');
      setMemberToRemove(null);
    }
  }

  async function confirmVerifyIncident() {
    if (!incidentToVerify) return;
    try {
      const response = await fetch(`${API}/${incidentToVerify.id}/verification?workspace_id=${activeWorkspaceId}`, { method: 'PATCH' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not verify this incident.');
      setIncidents((items) => items.map((item) => item.id === result.id ? result : item));
      setToast('Incident verified and added to the trusted fixes.');
      setIncidentToVerify(null);
    } catch (exception) {
      setError(exception.message || 'Could not verify this incident.');
      setIncidentToVerify(null);
    }
  }

  if (authStatus !== 'authenticated') {
    return <AuthScreen
      mode={authStatus}
      error={authError}
      onSubmit={authStatus === 'change-password' ? submitPasswordChange : (event) => submitAuthentication(event, authStatus)}
      onRetry={checkAuthentication}
      user={user}
    />;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#"><BrandMark/><span className="brand-wordmark">bug<span>replay</span></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <div className="workspace-picker"><button className="workspace-switch" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}><span className="workspace-avatar">{activeWorkspace ? initials(activeWorkspace.name).slice(0, 1) : '…'}</span><span className="workspace-copy"><strong>{activeWorkspace?.name || 'Loading workspace…'}</strong><small>{activeWorkspace ? 'Shared incident library' : 'Workspace'}</small></span><span className="chevron">⌄</span></button>{workspaceMenuOpen && <div className="workspace-menu" role="menu">{workspaces.map((workspace) => <button key={workspace.id} role="menuitem" className={`workspace-option ${workspace.id === activeWorkspaceId ? 'current' : ''}`} onClick={() => switchWorkspace(workspace.id)}><span className="workspace-option-avatar">{initials(workspace.name).slice(0, 1)}</span><span>{workspace.name}</span>{workspace.id === activeWorkspaceId && <span className="workspace-check">✓</span>}</button>)}{workspaces.some((workspace) => workspace.role === 'team_lead') && <button className="workspace-create-option" onClick={() => { setWorkspaceMenuOpen(false); setWorkspaceDialogOpen(true); }}>＋ Create workspace</button>}</div>}</div>
      <nav className="nav-list" aria-label="Main navigation">
        <button className={`nav-item ${view === 'library' ? 'active' : ''}`} onClick={() => changeView('library')}><span className="nav-icon">▦</span>Incident library<span className="nav-count">{incidents.length}</span></button>
        {activeWorkspace?.role === 'team_lead' && <button className={`nav-item ${view === 'team' ? 'active' : ''}`} onClick={openTeamMembers}><span className="nav-icon">♙</span>Team members<span className="nav-count">{teamMembers.length || ''}</span></button>}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-tip"><span className="tip-icon">✳</span><div><strong>Good fixes deserve<br/>to be remembered.</strong><p>Save the solution once.<br/>Find it the next time.</p></div></div><button className="profile" onClick={() => setLogoutConfirmationOpen(true)} title="Sign out"><span className="profile-avatar">{initials(user?.name || 'User')}</span><span><strong>{user?.name || 'Account'}</strong><small>{activeWorkspace?.role === 'team_lead' ? 'Team Lead' : 'Employee'}</small></span><span className="profile-dots">↪</span></button></div>
    </aside>
    <main className={`main-content ${view === 'team' ? 'team-view' : ''}`}>
      {view === 'team' && <section className="team-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/>WORKSPACE ACCESS</div><h1>Team members<span className="heading-period">.</span></h1><p>Manage who can access {activeWorkspace?.name}. Team Leads can verify incident fixes.</p></div></div><p className="team-management-note">Deactivating an account prevents sign-in across all workspaces. Removing a member only removes them from this workspace. A workspace must keep one active Team Lead.</p><div className="team-page-grid"><section className="team-card"><div className="team-card-heading"><div><h2>People</h2><p>{teamMembers.length} {teamMembers.length === 1 ? 'member' : 'members'} in this workspace</p></div><span className="team-count">{teamMembers.length}</span></div><div className="team-member-list">{teamMembers.map((member) => { const canManage = member.id !== user?.id; return <div className="team-member-row" key={member.id}><span className="profile-avatar">{initials(member.name)}</span><span className="team-member-info"><strong>{member.name}{member.id === user?.id ? ' (you)' : ''}</strong><small>{member.email}</small></span><span className={`member-status ${member.is_active ? 'active' : 'inactive'}`}>{member.is_active ? 'Active' : 'Inactive'}</span><span className={`role-pill ${member.role === 'team_lead' ? 'lead' : ''}`}>{member.role === 'team_lead' ? 'Team Lead' : 'Employee'}</span>{canManage && <span className="member-actions"><button className={`member-action-button ${member.is_active ? 'deactivate' : 'activate'}`} type="button" title={member.is_active ? 'Deactivate account' : 'Activate account'} aria-label={`${member.is_active ? 'Deactivate' : 'Activate'} ${member.name}`} onClick={() => toggleEmployeeStatus(member)}>{member.is_active ? '⏻' : '◉'}</button><button className="member-action-button remove" type="button" title="Remove from workspace" aria-label={`Remove ${member.name} from workspace`} onClick={() => setMemberToRemove(member)}>⌫</button></span>}</div>; })}</div></section><section className="team-card team-add-card"><div className="team-card-heading"><div><h2>Add or update a team member</h2><p>Choose the role for new members or update an existing member by email.</p></div></div><form onSubmit={addEmployee} className="employee-form"><label>Full name<input name="name" required minLength="2" maxLength="120" placeholder="e.g. Alex Chen"/></label><label>Work email<input name="email" required type="email" maxLength="254" placeholder="alex@company.com"/></label><label>Workspace role<select name="role" defaultValue="employee"><option value="employee">Employee</option><option value="team_lead">Team Lead</option></select></label><label>Temporary password <span className="optional-label">Required for new accounts</span><input name="temporary_password" type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="At least 8 characters"/></label>{teamError && <p className="form-error">{teamError}</p>}<div className="dialog-actions"><button className="primary-button" type="submit">Save team member <span>→</span></button></div></form></section></div></section>}
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/>THE KNOWLEDGE BASE</div><h1>Incident library<span className="heading-period">.</span></h1><p>One shared library. Fixes linked to the projects they came from.</p></div><div className="heading-actions"><button className="secondary-button add-project-button" onClick={() => setProjectDialogOpen(true)}>＋ Project</button><button className="primary-button" onClick={() => setDialogOpen(true)}><span>＋</span> Add an incident</button></div></section>
      <section className="search-panel"><div className="search-row"><span className="search-icon">⌕</span><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} type="search" placeholder="Describe an error, symptom, or paste a stack trace…"/><kbd>⌕</kbd></div><div className="search-meta"><span><span className="sparkle">✳</span> Search your team’s resolved incidents</span><span className="shortcut-hint">Try <button onClick={() => setSearchTerm('connection timeout')}>“connection timeout”</button> or <button onClick={() => setSearchTerm('React hydration')}>“React hydration”</button></span></div></section>
      <section className="stats-row"><div className="stat"><span className="stat-icon purple">▦</span><div><strong>{incidents.length}</strong><span>documented fixes</span></div></div><div className="stat"><span className="stat-icon green">✓</span><div><strong>{incidents.filter((item) => item.verified).length}</strong><span>mentor verified</span></div></div><div className="stat"><span className="stat-icon amber">◷</span><div><strong>12 min</strong><span>avg. time saved</span></div></div><div className="stat stat-note"><span className="note-quote">“</span><span>One good fix can save<br/>someone else an afternoon.</span></div></section>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => { setError(''); loadWorkspaces(); if (activeWorkspaceId) { loadIncidents(activeWorkspaceId); loadProjects(activeWorkspaceId); } }}>Retry</button></div>}
      <section className="results-header"><div><h2>{searchTerm ? `Matches for “${searchTerm}”` : 'Recently resolved'}</h2><span className="result-count">{matches.length} {matches.length === 1 ? 'incident' : 'incidents'}</span></div><div className="filters"><button className="filter-button" onClick={() => setSortNewest((value) => !value)}>↕ <span>{sortNewest ? 'Recently added' : 'Most relevant'}</span>⌄</button><select className="filter-button filter-select" aria-label="Filter by priority" value={activePriority} onChange={(event) => setActivePriority(event.target.value)}><option value="">All priorities</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option></select><select className="filter-button filter-select" aria-label="Filter by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><select className="filter-button filter-select" aria-label="Filter by tag" value={activeTag} onChange={(event) => setActiveTag(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}</select></div></section>
      <section className="incident-list" aria-live="polite">{loading ? <div className="empty-state"><div className="loading-spinner"/><h3>Loading your incident library</h3></div> : matches.length ? matches.map((item) => <button key={item.id} className={`incident-card ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setNoteOpen(true); }}><div className="card-topline"><span className="card-category">{item.category}</span><span className={`priority-badge priority-${item.priority}`}>{item.priority} priority</span>{item.verified && <span className="verified-badge">Verified fix</span>}</div><h3>{item.title}</h3><p className="card-description">{item.symptoms}</p><div className="card-bottom"><span className="tag-list">{item.project_name ? <span className="tag project-tag">{item.project_name}</span> : <span className="tag project-tag">Workspace-wide</span>}{item.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</span><span className="card-meta"><span className="mini-avatar">{initials(item.author)}</span>{item.author}<span>·</span>{shortDate(item.created_at)}</span></div><span className="card-arrow">↗</span></button>) : <div className="empty-state"><div className="empty-icon">{searchTerm ? '⌕' : '✳'}</div><h3>{searchTerm ? 'No matching fixes yet' : 'Nothing here yet'}</h3><p>{searchTerm ? 'Try another phrase, or document the fix once it’s solved.' : 'Filter incidents by priority to find the most urgent fixes first.'}</p><button className="text-button" onClick={() => setDialogOpen(true)}>＋ Document an incident</button></div>}</section>
      <footer className="page-footer"><span><BrandMark small/> A little less debugging from scratch.</span><span>Knowledge grows with every fix <span className="footer-sparkle">✳</span></span></footer>
    </main>
    {noteOpen && selected && <div className="reading-view" role="dialog" aria-modal="true" aria-labelledby="reading-title"><header className="reading-topbar"><button className="reading-back" onClick={() => { setNoteOpen(false); setSelectedId(null); }}><span aria-hidden="true">←</span> Back to incident library</button><div className="reading-workspace"><span>{activeWorkspace?.name || 'Workspace'}</span><span className="reading-separator">/</span><span>{selected.project_name || 'Shared knowledge'}</span></div><div className="reading-actions">{!selected.verified && activeWorkspace?.role === 'team_lead' && <button className="verify-button" onClick={() => setIncidentToVerify(selected)}>✓ Verify fix</button>}<label className="priority-control"><span>Priority</span><select className={`priority-select priority-${selected.priority}`} value={selected.priority} aria-label="Incident priority" onChange={(event) => updateIncidentPriority(selected.id, event.target.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label></div></header><article className="reading-content"><div className="reading-kicker"><span className="reading-kicker-dot"/>{selected.verified ? 'VERIFIED INCIDENT' : 'RESOLVED INCIDENT'}<span className="reading-kicker-separator">·</span>{selected.category}</div><h1 id="reading-title">{selected.title}</h1><div className="reading-meta"><span className="reading-author-avatar">{initials(selected.author)}</span><span className="reading-author"><strong>{selected.author}</strong><small>Resolved {shortDate(selected.created_at)}</small></span>{selected.verified && <span className="reading-verified">✓ Mentor verified</span>}</div><section className="reading-scope"><span className="reading-scope-icon">↗</span><div><small>KNOWLEDGE SCOPE</small><strong>{selected.project_name || 'Shared with the whole workspace'}</strong></div></section><div className="reading-sections"><section className="reading-section"><div className="reading-section-heading"><span className="section-number">01</span><h2>What happened</h2></div><p className="reading-symptoms">{selected.symptoms}</p></section><section className="reading-section"><div className="reading-section-heading"><span className="section-number">02</span><h2>Root cause</h2></div><p>{selected.cause}</p></section><section className="reading-section reading-fix"><div className="reading-section-heading"><span className="section-number">03</span><h2>{selected.verified ? 'Verified fix' : 'Resolution'}</h2></div><p>{selected.fix}</p></section></div><footer className="reading-footer"><div className="reading-tags-label">RELATED TECHNOLOGIES</div><div className="detail-tags">{selected.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div><button className="reading-back reading-back-bottom" onClick={() => { setNoteOpen(false); setSelectedId(null); }}>← Back to incident library</button></footer></article></div>}
    {dialogOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialogOpen(false); }}><section className="incident-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><form onSubmit={createIncident}><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>GIVE THE FIX A HOME</div><h2 id="dialog-title">Document an incident<span className="heading-period">.</span></h2></div><button className="icon-button" type="button" onClick={() => setDialogOpen(false)} aria-label="Close">×</button></div><p className="dialog-intro">Capture what happened so the next person can get back to building.</p><label>Incident title<input name="title" required minLength="3" maxLength="160" placeholder="e.g. API requests timing out after deploy"/></label><label>Error message or symptoms<textarea name="symptoms" required minLength="3" rows="3" placeholder="What did you see? Paste the relevant error or describe the symptoms."/></label><label>Root cause<textarea name="cause" required minLength="3" rows="2" placeholder="What was actually causing the issue?"/></label><label>Resolution<textarea name="fix" required minLength="3" rows="3" placeholder="What steps resolved it?"/></label><label>Priority<select name="priority" defaultValue="medium"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><div className="form-row"><label>Project scope<select name="project_id" defaultValue=""><option value="">Shared with the whole workspace</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label>Technology / tags<input name="tags" placeholder="React, API, Postgres"/></label></div><label>Resolved by<input name="author" placeholder="Your name" defaultValue={user?.name || ''}/></label>{activeWorkspace?.role === 'team_lead' ? <label className="check-label"><input name="verified" type="checkbox"/> Reviewed and verified by a mentor</label> : <p className="review-note">A Team Lead can verify this incident after reviewing it.</p>}{error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setDialogOpen(false)}>Cancel</button><button className="primary-button" type="submit">Save incident <span>→</span></button></div></form></section></div>}
    {projectDialogOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false); }}><section className="incident-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"><form onSubmit={createProject}><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>ORGANIZE THE SHARED LIBRARY</div><h2 id="project-dialog-title">Add a project<span className="heading-period">.</span></h2></div><button className="icon-button" type="button" onClick={() => setProjectDialogOpen(false)} aria-label="Close">×</button></div><p className="dialog-intro">Projects group fixes by product, repository, or service. Workspace-wide incidents stay visible across all projects.</p><label>Project name<input name="name" required minLength="2" maxLength="120" placeholder="e.g. Payments API"/></label><label>Description <span className="optional-label">Optional</span><textarea name="description" maxLength="300" rows="2" placeholder="What does this project cover?"/></label>{error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setProjectDialogOpen(false)}>Cancel</button><button className="primary-button" type="submit">Create project <span>→</span></button></div></form></section></div>}
    {workspaceDialogOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setWorkspaceDialogOpen(false); }}><section className="incident-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title"><form onSubmit={createWorkspace}><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>START A SHARED SPACE</div><h2 id="workspace-dialog-title">Create a workspace<span className="heading-period">.</span></h2></div><button className="icon-button" type="button" onClick={() => setWorkspaceDialogOpen(false)} aria-label="Close">×</button></div><p className="dialog-intro">A workspace has its own shared incident library and its own projects.</p><label>Workspace name<input name="name" required minLength="2" maxLength="120" placeholder="e.g. Acme Engineering"/></label>{error && <p className="form-error">{error}</p>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setWorkspaceDialogOpen(false)}>Cancel</button><button className="primary-button" type="submit">Create workspace <span>→</span></button></div></form></section></div>}
    {memberToRemove && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMemberToRemove(null); }}><section className="incident-dialog remove-member-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-member-title"><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>WORKSPACE ACCESS</div><h2 id="remove-member-title">Remove team member?</h2></div><button className="icon-button" type="button" onClick={() => setMemberToRemove(null)} aria-label="Close">×</button></div><p className="dialog-intro">Remove <strong>{memberToRemove.name}</strong> from {activeWorkspace?.name}? They will lose access to this workspace, but their account and access to other workspaces will remain.</p><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setMemberToRemove(null)}>Cancel</button><button className="remove-confirm-button" type="button" onClick={confirmRemoveEmployee}>Remove from workspace</button></div></section></div>}
    {incidentToVerify && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIncidentToVerify(null); }}><section className="incident-dialog remove-member-dialog" role="dialog" aria-modal="true" aria-labelledby="verify-incident-title"><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>TEAM LEAD REVIEW</div><h2 id="verify-incident-title">Verify this fix?</h2></div><button className="icon-button" type="button" onClick={() => setIncidentToVerify(null)} aria-label="Close">×</button></div><p className="dialog-intro">Mark <strong>{incidentToVerify.title}</strong> as verified? This signals that the fix has been reviewed and can be trusted by the team.</p><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setIncidentToVerify(null)}>Cancel</button><button className="primary-button" type="button" onClick={confirmVerifyIncident}>Verify fix <span>✓</span></button></div></section></div>}
    {logoutConfirmationOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogoutConfirmationOpen(false); }}><section className="incident-dialog remove-member-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title"><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>ACCOUNT</div><h2 id="logout-title">Sign out?</h2></div><button className="icon-button" type="button" onClick={() => setLogoutConfirmationOpen(false)} aria-label="Close">×</button></div><p className="dialog-intro">You’ll need to sign in again to access your workspace.</p><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setLogoutConfirmationOpen(false)}>Cancel</button><button className="remove-confirm-button" type="button" onClick={signOut}>Sign out</button></div></section></div>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function AuthScreen({ mode, error, onSubmit, onRetry, user }) {
  if (mode === 'checking') {
    return <main className="auth-shell"><section className="auth-card auth-loading"><a className="brand" href="#"><BrandMark/><span className="brand-wordmark">bug<span>replay</span></span></a><div className="loading-spinner"/><p>Checking your workspace…</p></section></main>;
  }

  const setup = mode === 'setup';
  const changingPassword = mode === 'change-password';
  return <main className="auth-shell"><section className="auth-card"><a className="brand" href="#"><BrandMark/><span className="brand-wordmark">bug<span>replay</span></span></a><div className="auth-eyebrow"><span className="eyebrow-dot"/>{setup ? 'FIRST-TIME SETUP' : changingPassword ? 'ACCOUNT SECURITY' : 'TEAM KNOWLEDGE BASE'}</div><h1>{setup ? 'Create your workspace lead account.' : changingPassword ? 'Set a new password.' : 'Welcome back.'}</h1><p className="auth-description">{setup ? 'The first account becomes Team Lead for Acme Engineering. Use this account to invite your team.' : changingPassword ? `Hi ${user?.name || 'there'}, change your temporary password to continue.` : 'Sign in to search your team’s resolved incidents.'}</p><form className="auth-form" onSubmit={onSubmit}>{setup && <label>Your name<input name="name" required minLength="2" maxLength="120" autoComplete="name" placeholder="e.g. Shivam Jha"/></label>}{!changingPassword && <label>Work email<input name="email" required type="email" maxLength="254" autoComplete="email" placeholder="you@company.com"/></label>}{changingPassword && <label>Temporary / current password<input name="current_password" required type="password" autoComplete="current-password"/></label>}{!changingPassword && <label>Password<input name="password" required type="password" minLength="8" maxLength="256" autoComplete={setup ? 'new-password' : 'current-password'} placeholder={setup ? 'At least 8 characters' : 'Enter your password'}/></label>}{changingPassword && <label>New password<input name="new_password" required type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="At least 8 characters"/></label>}{(setup || changingPassword) && <label>Confirm {changingPassword ? 'new ' : ''}password<input name="confirm_password" required type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="Enter it again"/></label>}{error && <div className="auth-error" role="alert">{error}{error.includes('connect') && <button type="button" onClick={onRetry}>Retry</button>}</div>}<button className="primary-button auth-submit" type="submit">{setup ? 'Create Team Lead account' : changingPassword ? 'Update password' : 'Sign in'} <span>→</span></button></form><div className="auth-footnote"><span>🔒</span><span>{setup ? 'Your password is securely hashed and never stored as plain text.' : changingPassword ? 'Your account will open once the password is updated.' : 'Your workspace data is available to authorized members only.'}</span></div></section><div className="auth-side-note">Solve it once. <strong>Save the fix.</strong><br/>Replay the learning.</div></main>;
}

function DetailSection({ title, className = '', children }) {
  return <section className={`detail-section ${title === 'Verified fix' ? 'fix-section' : ''}`}><h3>{title}</h3><p className={className}>{children}</p></section>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
