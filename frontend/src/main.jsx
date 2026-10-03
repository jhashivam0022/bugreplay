import React, { useEffect, useMemo, useRef, useState } from 'react';
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

const SECRET_PATTERNS = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['an API secret key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['a JWT or bearer token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['credentials inside a connection string', /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i],
  ['a password or secret value', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?(?!\*+|x+|<|\$\{|your|changeme|redacted)[^\s"',;]{6,}/i],
];
const findSecrets = (text) => SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
const titleWords = (text) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
const findSimilar = (title, incidents, ignoreId) => {
  const words = titleWords(title);
  if (words.size < 2) return [];
  return incidents
    .filter((item) => item.id !== ignoreId)
    .map((item) => {
      const other = titleWords(item.title);
      const shared = [...words].filter((word) => other.has(word)).length;
      return { item, score: shared / Math.min(words.size, other.size || 1), shared };
    })
    .filter(({ score, shared }) => shared >= 2 && score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item }) => item);
};
const readableError = (body, fallback) => {
  if (typeof body?.detail === 'string') return body.detail;
  const first = body?.detail?.[0];
  if (!first) return fallback;
  const field = first.loc?.[first.loc.length - 1];
  return `${field ? String(field).replace(/_/g, ' ') : 'Input'}: ${String(first.msg).replace(/^Value error, /, '')}`;
};
const formatMinutes = (minutes) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;

function inlineCode(text, keyPrefix) {
  return text.split(/(`[^`\n]+`)/).map((part, index) => part.length > 2 && part.startsWith('`') && part.endsWith('`')
    ? <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>
    : part);
}

function RichText({ text, className = '' }) {
  const chunks = text.split(/```[\w+-]*\n?([\s\S]*?)```/);
  return <div className="rich-text">{chunks.map((chunk, index) => index % 2
    ? <pre key={index}><code>{chunk.replace(/\n$/, '')}</code></pre>
    : chunk.trim() ? <p className={className} key={index}>{inlineCode(chunk.trim(), index)}</p> : null)}</div>;
}

function inlineMarkup(text, keyPrefix) {
  return text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function AnswerText({ text }) {
  const chunks = text.split(/```[\w+-]*\n?([\s\S]*?)```/);
  return <div className="answer-text">{chunks.map((chunk, chunkIndex) => {
    if (chunkIndex % 2) return <pre key={chunkIndex}><code>{chunk.replace(/\n$/, '')}</code></pre>;
    const blocks = [];
    let list = null;
    chunk.split('\n').forEach((raw, lineIndex) => {
      const line = raw.trim();
      const key = `${chunkIndex}-${lineIndex}`;
      const bullet = line.match(/^(?:[*-]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        const ordered = /^\d/.test(line);
        if (!list || list.ordered !== ordered) { list = { ordered, items: [], key, start: ordered ? parseInt(line, 10) || 1 : 1 }; blocks.push(list); }
        list.items.push(bullet[1]);
        return;
      }
      list = null;
      if (!line) return;
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      blocks.push(heading ? { heading: heading[1], key } : { paragraph: line, key });
    });
    return blocks.map((block) => block.items
      ? (block.ordered ? <ol key={block.key} start={block.start}>{block.items.map((item, i) => <li key={i}>{inlineMarkup(item, `${block.key}-${i}`)}</li>)}</ol> : <ul key={block.key}>{block.items.map((item, i) => <li key={i}>{inlineMarkup(item, `${block.key}-${i}`)}</li>)}</ul>)
      : block.heading ? <h4 key={block.key}>{inlineMarkup(block.heading, block.key)}</h4> : <p key={block.key}>{inlineMarkup(block.paragraph, block.key)}</p>);
  })}</div>;
}

function IncidentForm({ incident, incidents, projects, role, error, onSubmit, onClose }) {
  const editing = Boolean(incident);
  const [values, setValues] = useState(() => ({
    title: incident?.title || '',
    symptoms: incident?.symptoms || '',
    cause: incident?.cause || '',
    fix: incident?.fix || '',
    steps: incident?.steps || '',
    environment: incident?.environment || '',
    prevention: incident?.prevention || '',
    reference_url: incident?.reference_url || '',
    resolution_minutes: incident?.resolution_minutes ?? '',
    priority: incident?.priority || 'medium',
    project_id: incident?.project_id ? String(incident.project_id) : '',
    verified: incident?.verified || false,
  }));
  const [tags, setTags] = useState(incident?.tags || []);
  const [tagDraft, setTagDraft] = useState('');
  const [showMore, setShowMore] = useState(() => Boolean(incident && (incident.environment || incident.steps || incident.prevention || incident.reference_url || incident.resolution_minutes)));
  const [acknowledged, setAcknowledged] = useState(false);
  const change = (name) => (event) => setValues((current) => ({ ...current, [name]: event.target.value }));
  const secrets = useMemo(
    () => [...new Set(findSecrets([values.symptoms, values.cause, values.fix, values.steps, values.environment, values.prevention].join('\n')))],
    [values.symptoms, values.cause, values.fix, values.steps, values.environment, values.prevention],
  );
  const similar = useMemo(() => values.title.trim().length >= 8 ? findSimilar(values.title, incidents, incident?.id) : [], [values.title, incidents, incident]);
  const blocked = secrets.length > 0 && !acknowledged;
  const knownTags = useMemo(() => [...new Set(incidents.flatMap((item) => item.tags))].sort(), [incidents]);
  const addTags = (raw, current = tags) => {
    const next = [...current];
    raw.split(',').map((tag) => tag.trim().slice(0, 40)).filter(Boolean).forEach((tag) => {
      if (next.length < 12 && !next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) next.push(tag);
    });
    setTags(next);
    setTagDraft('');
    return next;
  };
  const onTagKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (tagDraft.trim()) addTags(tagDraft);
    } else if (event.key === 'Backspace' && !tagDraft && tags.length) {
      setTags(tags.slice(0, -1));
    }
  };

  function submit(event) {
    event.preventDefault();
    if (blocked) return;
    const tagList = tagDraft.trim() ? addTags(tagDraft) : tags;
    onSubmit({
      title: values.title.trim(),
      category: (tagList[0] || 'TEAM INCIDENT').toUpperCase(),
      symptoms: values.symptoms.trim(),
      cause: values.cause.trim(),
      fix: values.fix.trim(),
      steps: values.steps.trim(),
      environment: values.environment.trim(),
      prevention: values.prevention.trim(),
      reference_url: values.reference_url.trim(),
      resolution_minutes: values.resolution_minutes === '' ? null : Number(values.resolution_minutes),
      priority: values.priority,
      tags: tagList,
      verified: role === 'team_lead' && values.verified,
      project_id: values.project_id ? Number(values.project_id) : null,
    }, incident?.id);
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="incident-dialog incident-form-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><form onSubmit={submit}>
    <div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>{editing ? 'IMPROVE THE RECORD' : 'GIVE THE FIX A HOME'}</div><h2 id="dialog-title">{editing ? 'Edit incident' : 'Document an incident'}<span className="heading-period">.</span></h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></div>
    <p className="dialog-intro">{editing ? 'Update the details so the next person gets the full picture.' : 'Capture what happened so the next person can get back to building.'} Wrap stack traces or commands in <code>```</code> fences to keep their formatting.</p>
    <label>Incident title<input value={values.title} onChange={change('title')} required minLength="8" maxLength="160" placeholder="e.g. API requests timing out after deploy"/></label>
    {similar.length > 0 && <div className="similar-box" role="note"><strong>Similar incidents already exist</strong><span>Check these first. You may be able to improve one instead of adding a duplicate.</span><ul>{similar.map((item) => <li key={item.id}>{item.title}{item.verified && <span className="verified-badge">Verified</span>}</li>)}</ul></div>}
    <label>Error message or symptoms<textarea value={values.symptoms} onChange={change('symptoms')} required minLength="15" maxLength="10000" rows="4" placeholder="What did you see? Paste the relevant error or describe the symptoms (at least 15 characters)."/></label>
    <label>Root cause<textarea value={values.cause} onChange={change('cause')} required minLength="10" maxLength="10000" rows="3" placeholder="What was actually causing the issue?"/></label>
    <label>Resolution<textarea value={values.fix} onChange={change('fix')} required minLength="10" maxLength="10000" rows="4" placeholder="What steps resolved it?"/></label>
    <button type="button" className="more-toggle" aria-expanded={showMore} onClick={() => setShowMore((open) => !open)}><span>{showMore ? '−' : '＋'}</span> {showMore ? 'Hide extra details' : 'Add more context'} <small>Environment, steps to reproduce, prevention, link, time to resolve</small></button>
    {showMore && <div className="more-fields">
    <label>Environment and versions <span className="optional-label">Optional</span><input value={values.environment} onChange={change('environment')} maxLength="1000" placeholder="e.g. Node 20.11, Postgres 15, production on AWS ECS"/></label>
    <label>Steps to reproduce <span className="optional-label">Optional</span><textarea value={values.steps} onChange={change('steps')} maxLength="10000" rows="3" placeholder="How can someone trigger the same problem?"/></label>
    <label>How to prevent it next time <span className="optional-label">Optional</span><textarea value={values.prevention} onChange={change('prevention')} maxLength="10000" rows="2" placeholder="Monitoring, tests, or guardrails that would catch it earlier."/></label>
    <div className="form-row"><label>Reference link <span className="optional-label">Optional</span><input value={values.reference_url} onChange={change('reference_url')} type="url" maxLength="500" placeholder="https://github.com/org/repo/pull/123"/></label><label>Time to resolve (minutes) <span className="optional-label">Optional</span><input value={values.resolution_minutes} onChange={change('resolution_minutes')} type="number" min="1" max="100000" placeholder="e.g. 45"/></label></div>
    </div>}
    <div className="form-section-label">ORGANIZE</div>
    <div className="form-row"><label>Priority<select value={values.priority} onChange={change('priority')}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><label>Project scope<select value={values.project_id} onChange={change('project_id')}><option value="">Shared with the whole workspace</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div>
    <div className="tag-field"><span className="tag-field-label">Technology / tags <span className="optional-label">Press Enter or comma to add each tag</span></span><div className="tag-input" onClick={(event) => event.currentTarget.querySelector('input').focus()}>{tags.map((tag) => <span className="tag-chip" key={tag}>{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => setTags(tags.filter((item) => item !== tag))}>×</button></span>)}<input value={tagDraft} onChange={(event) => { const value = event.target.value; if (value.includes(',')) addTags(value); else setTagDraft(value); }} onKeyDown={onTagKeyDown} onBlur={() => tagDraft.trim() && addTags(tagDraft)} list="known-tags" disabled={tags.length >= 12 && !tagDraft} placeholder={tags.length ? '' : 'React, API, Postgres'}/></div></div>
    <datalist id="known-tags">{knownTags.filter((tag) => !tags.includes(tag)).map((tag) => <option value={tag} key={tag}/>)}</datalist>
    {role === 'team_lead' ? <label className="check-label"><input type="checkbox" checked={values.verified} onChange={(event) => setValues((current) => ({ ...current, verified: event.target.checked }))}/> Reviewed and verified by a mentor</label> : <p className="review-note">{editing && incident.verified ? 'Saving changes sends this fix back to a Team Lead for re-verification.' : 'A Team Lead can verify this incident after reviewing it.'}</p>}
    {secrets.length > 0 && <div className="secret-warning" role="alert"><strong>This may contain sensitive data</strong><span>It looks like {secrets.join(', ')}. Remove or redact it before sharing with the team.</span><label className="check-label"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/> I checked, and nothing here is a real secret</label></div>}
    {error && <p className="form-error">{error}</p>}
    <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={blocked}>{editing ? 'Save changes' : 'Save incident'} <span>→</span></button></div>
  </form></section></div>;
}

function BrandMark({ small = false }) {
  return <span className={small ? 'footer-mark' : 'brand-mark'} aria-hidden="true"><svg viewBox="0 0 36 36" focusable="false"><path d="M11.2 10.2a10.5 10.5 0 0 1 15.5 2.3l1.1 2.1" fill="none" stroke="#d9ebd3" strokeWidth="1.8" strokeLinecap="round"/><path d="m23.7 14.4 4.4.3-.6-4.2M24.8 25.8a10.5 10.5 0 0 1-15.5-2.3l-1.1-2.1" fill="none" stroke="#d9ebd3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="m12.3 21.6-4.4-.3.6 4.2" fill="none" stroke="#d9ebd3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><ellipse cx="18" cy="19" rx="4.8" ry="6.2" fill="#fff"/><circle cx="18" cy="12.1" r="2.6" fill="#d9ebd3"/><path d="M18 13.2v11.7M13.8 16.3l-2.2-1.4m10.6 1.4 2.2-1.4m-10.2 6.7-2.2 1.4m10.2-1.4 2.2 1.4" fill="none" stroke="#4b7650" strokeWidth="1.1" strokeLinecap="round"/><circle cx="16.9" cy="11.8" r=".35" fill="#3d6142"/><circle cx="19.1" cy="11.8" r=".35" fill="#3d6142"/></svg></span>;
}

const CHAT_EXAMPLES = [
  'API requests are timing out right after a deploy',
  'Error: getaddrinfo ENOTFOUND between two containers',
  'React hydration mismatch after a hard refresh',
];

function ChatPanel({ workspaceId, seed, onOpenIncident, onDocument, onUnauthorized }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const controllerRef = useRef(null);
  const messagesRef = useRef([]);
  const requestCounter = useRef(0);
  const handledSeed = useRef(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (!seed || handledSeed.current === seed.id) return;
    handledSeed.current = seed.id;
    startOver();
    if (seed.text) send(seed.text, []);
  }, [seed]);

  async function send(text, base = messagesRef.current) {
    const content = text.trim();
    if (!content) return;
    const history = [
      ...base.filter((message) => message.content && !message.error).map(({ role, content: body, grounded }) => role === 'assistant' ? { role, content: body, grounded } : { role, content: body }),
      { role: 'user', content },
    ].slice(-20);
    const requestId = ++requestCounter.current;
    const patchLast = (change) => {
      if (requestId === requestCounter.current) setMessages((current) => current.map((message, index) => index === current.length - 1 ? change(message) : message));
    };
    setMessages([...base, { role: 'user', content }, { role: 'assistant', content: '', streaming: true, sources: [], grounded: null }]);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch(`${API}/chat?workspace_id=${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error(readableError(await response.json().catch(() => ({})), 'Could not start the chat.'));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === 'meta') patchLast((message) => ({ ...message, sources: event.sources, grounded: event.grounded }));
          else if (event.type === 'token') patchLast((message) => ({ ...message, content: message.content + event.text }));
          else if (event.type === 'error') patchLast((message) => ({ ...message, error: event.message }));
        }
      }
    } catch (exception) {
      if (exception.name !== 'AbortError') patchLast((message) => ({ ...message, error: exception.message || 'Something went wrong. Please try again.' }));
    } finally {
      patchLast((message) => ({ ...message, streaming: false }));
      if (requestId === requestCounter.current) {
        setBusy(false);
        inputRef.current?.focus();
      }
    }
  }

  function startOver() {
    controllerRef.current?.abort();
    requestCounter.current += 1;
    messagesRef.current = [];
    setMessages([]);
    setInput('');
    setBusy(false);
    inputRef.current?.focus();
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy) send(input);
    }
  }

  function onInput(event) {
    setInput(event.target.value);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
  }

  return <section className="ai-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/>TROUBLESHOOTING ASSISTANT</div><h1>AI guidance<span className="heading-period">.</span></h1><p>Ask about an error. Answers start from your team’s resolved incidents.</p></div><div className="heading-actions">{messages.length > 0 && <button type="button" className="secondary-button" onClick={startOver}>＋ New chat</button>}</div></div>
    <div className="ai-chat">
      <div className="chat-scroll" ref={scrollRef} aria-live="polite">
        {messages.length === 0 && <div className="chat-empty"><span className="chat-empty-icon" aria-hidden="true">✦</span><strong>What are you trying to fix?</strong>Describe the error, paste a stack trace, or ask a question. I check your team’s resolved incidents first, and we keep talking until you find the answer.<div className="chat-examples">{CHAT_EXAMPLES.map((example) => <button type="button" key={example} onClick={() => send(example)}>{example}</button>)}</div></div>}
        {messages.map((message, index) => message.role === 'user'
          ? <div className="chat-row user" key={index}><div className="chat-bubble">{message.content}</div></div>
          : <div className="chat-row" key={index}><span className="chat-avatar" aria-hidden="true">✦</span><div className="chat-reply">
            {message.grounded !== null && <span className={`chat-origin ${message.grounded ? 'grounded' : 'general'}`}>{message.grounded ? 'Based on related team incidents' : 'General guidance · no matching team incident'}</span>}
            {message.content ? <AnswerText text={message.content}/> : message.streaming && !message.error ? <div className="chat-typing" aria-label="Thinking"><span/><span/><span/></div> : null}
            {message.error && <p className="chat-error">{message.error}</p>}
            {message.sources?.length > 0 && !message.streaming && <div className="guidance-sources"><small>BASED ON</small>{message.sources.map((source) => <button type="button" key={source.id} className="source-chip" onClick={() => onOpenIncident(source.id)}><span>[{source.number}]</span> {source.title}{source.verified ? <span className="verified-badge">Verified</span> : <span className="unverified-badge">Unverified</span>}</button>)}</div>}
            {message.grounded === false && !message.streaming && message.content && <p className="chat-document">Solved it? <button type="button" onClick={onDocument}>Document the fix</button> so your team finds it next time.</p>}
          </div></div>)}
      </div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); if (!busy) send(input); }}>
        <textarea ref={inputRef} rows="1" value={input} onChange={onInput} onKeyDown={onKeyDown} maxLength="4000" placeholder={messages.length ? 'Ask a follow-up…' : 'Describe the problem or paste an error…'} aria-label="Message"/>
        <button className="ai-button" type="submit" disabled={busy || !input.trim()}>{busy ? 'Thinking…' : 'Send'}</button>
      </form>
      <p className="chat-footnote">Enter to send, Shift+Enter for a new line. AI can be wrong, so verify before applying changes, and never paste secrets.</p>
    </div>
  </section>;
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
  const [searchResults, setSearchResults] = useState(null);
  const [searchMeta, setSearchMeta] = useState({ mode: '', unindexed: 0 });
  const [searching, setSearching] = useState(false);
  const [chatSeed, setChatSeed] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIncident, setEditingIncident] = useState(null);
  const [incidentToDelete, setIncidentToDelete] = useState(null);
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
    const query = searchTerm.trim();
    if (query.length < 3 || authStatus !== 'authenticated' || !activeWorkspaceId) {
      setSearchResults(null);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${API}/search?workspace_id=${activeWorkspaceId}&q=${encodeURIComponent(query.slice(0, 1500))}`, { signal: controller.signal });
        if (response.status === 401) { setAuthStatus('login'); return; }
        if (!response.ok) throw new Error();
        const body = await response.json();
        setSearchResults(body.results);
        setSearchMeta({ mode: body.mode, unindexed: body.unindexed });
        setSearching(false);
      } catch (exception) {
        if (exception.name === 'AbortError') return;
        setSearchResults(null);
        setSearching(false);
      }
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchTerm, activeWorkspaceId, authStatus]);
  useEffect(() => { setChatSeed(null); }, [activeWorkspaceId]);
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
    const passes = (item) => (!activeTag || item.tags.includes(activeTag))
      && (!activePriority || item.priority === activePriority)
      && (!projectFilter || item.project_id === Number(projectFilter));
    if (searchResults) {
      const byId = new Map(incidents.map((item) => [item.id, item]));
      const ranked = searchResults.map(({ incident }) => byId.get(incident.id)).filter((item) => item && passes(item));
      return sortNewest ? [...ranked].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : ranked;
    }
    const results = incidents.filter((item) => {
      const text = [item.title, item.category, item.symptoms, item.cause, item.fix, ...item.tags].join(' ').toLowerCase();
      return (!query || text.includes(query)) && passes(item);
    });
    return sortNewest ? [...results].reverse() : results;
  }, [incidents, searchResults, searchTerm, projectFilter, activeTag, activePriority, sortNewest]);
  const selected = incidents.find((item) => item.id === selectedId);
  const avgResolveMinutes = useMemo(() => {
    const times = incidents.map((item) => item.resolution_minutes).filter(Boolean);
    return times.length ? Math.round(times.reduce((sum, minutes) => sum + minutes, 0) / times.length) : 0;
  }, [incidents]);

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

  async function saveIncident(payload, id) {
    try {
      const response = await fetch(id ? `${API}/${id}?workspace_id=${activeWorkspaceId}` : `${API}?workspace_id=${activeWorkspaceId}`, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(readableError(body, 'Could not save this incident.'));
      setIncidents((items) => id ? items.map((item) => item.id === id ? body : item) : [body, ...items]);
      setSelectedId(body.id);
      if (!id) { setView('library'); setSearchTerm(''); setActiveTag(''); }
      setDialogOpen(false);
      setEditingIncident(null);
      setError('');
      setToast(id ? 'Incident updated.' : 'Incident added to the shared library.');
    } catch (exception) {
      setError(exception.message || 'Could not save this incident. Please try again.');
    }
  }

  async function confirmDeleteIncident() {
    if (!incidentToDelete) return;
    try {
      const response = await fetch(`${API}/${incidentToDelete.id}?workspace_id=${activeWorkspaceId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(readableError(await response.json(), 'Could not delete this incident.'));
      setIncidents((items) => items.filter((item) => item.id !== incidentToDelete.id));
      setNoteOpen(false);
      setSelectedId(null);
      setToast('Incident deleted.');
    } catch (exception) {
      setError(exception.message || 'Could not delete this incident.');
    }
    setIncidentToDelete(null);
  }

  function openIncidentForm(incident = null) {
    setError('');
    setEditingIncident(incident);
    setDialogOpen(true);
  }

  function closeIncidentForm() {
    setDialogOpen(false);
    setEditingIncident(null);
    setError('');
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
    const workspaceName = String(form.get('workspace_name') || '').trim();
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
        body: JSON.stringify(mode === 'setup' ? { name, workspace_name: workspaceName, email, password } : { email, password }),
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
        <button className={`nav-item ${view === 'ai' ? 'active' : ''}`} onClick={() => { setView('ai'); setNoteOpen(false); setSelectedId(null); }}><span className="nav-icon">✦</span>AI guidance</button>
        {activeWorkspace?.role === 'team_lead' && <button className={`nav-item ${view === 'team' ? 'active' : ''}`} onClick={openTeamMembers}><span className="nav-icon">♙</span>Team members<span className="nav-count">{teamMembers.length || ''}</span></button>}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-tip"><span className="tip-icon">✳</span><div><strong>Good fixes deserve<br/>to be remembered.</strong><p>Save the solution once.<br/>Find it the next time.</p></div></div><button className="profile" onClick={() => setLogoutConfirmationOpen(true)} title="Sign out"><span className="profile-avatar">{initials(user?.name || 'User')}</span><span><strong>{user?.name || 'Account'}</strong><small>{activeWorkspace?.role === 'team_lead' ? 'Team Lead' : 'Employee'}</small></span><span className="profile-dots">↪</span></button></div>
    </aside>
    <main className={`main-content ${view === 'team' ? 'team-view' : view === 'ai' ? 'ai-view' : ''}`}>
      <ChatPanel key={activeWorkspaceId} workspaceId={activeWorkspaceId} seed={chatSeed} onUnauthorized={() => setAuthStatus('login')} onOpenIncident={(id) => { setSelectedId(id); setNoteOpen(true); }} onDocument={() => { setView('library'); openIncidentForm(); }}/>
      {view === 'team' && <section className="team-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/>WORKSPACE ACCESS</div><h1>Team members<span className="heading-period">.</span></h1><p>Manage who can access {activeWorkspace?.name}. Team Leads can verify incident fixes.</p></div></div><p className="team-management-note">Deactivating an account prevents sign-in across all workspaces. Removing a member only removes them from this workspace. A workspace must keep one active Team Lead.</p><div className="team-page-grid"><section className="team-card"><div className="team-card-heading"><div><h2>People</h2><p>{teamMembers.length} {teamMembers.length === 1 ? 'member' : 'members'} in this workspace</p></div><span className="team-count">{teamMembers.length}</span></div><div className="team-member-list">{teamMembers.map((member) => { const canManage = member.id !== user?.id; return <div className="team-member-row" key={member.id}><span className="profile-avatar">{initials(member.name)}</span><span className="team-member-info"><strong>{member.name}{member.id === user?.id ? ' (you)' : ''}</strong><small>{member.email}</small></span><span className={`member-status ${member.is_active ? 'active' : 'inactive'}`}>{member.is_active ? 'Active' : 'Inactive'}</span><span className={`role-pill ${member.role === 'team_lead' ? 'lead' : ''}`}>{member.role === 'team_lead' ? 'Team Lead' : 'Employee'}</span>{canManage && <span className="member-actions"><button className={`member-action-button ${member.is_active ? 'deactivate' : 'activate'}`} type="button" title={member.is_active ? 'Deactivate account' : 'Activate account'} aria-label={`${member.is_active ? 'Deactivate' : 'Activate'} ${member.name}`} onClick={() => toggleEmployeeStatus(member)}>{member.is_active ? '⏻' : '◉'}</button><button className="member-action-button remove" type="button" title="Remove from workspace" aria-label={`Remove ${member.name} from workspace`} onClick={() => setMemberToRemove(member)}>⌫</button></span>}</div>; })}</div></section><section className="team-card team-add-card"><div className="team-card-heading"><div><h2>Add or update a team member</h2><p>Choose the role for new members or update an existing member by email.</p></div></div><form onSubmit={addEmployee} className="employee-form"><label>Full name<input name="name" required minLength="2" maxLength="120" placeholder="e.g. Alex Chen"/></label><label>Work email<input name="email" required type="email" maxLength="254" placeholder="alex@company.com"/></label><label>Workspace role<select name="role" defaultValue="employee"><option value="employee">Employee</option><option value="team_lead">Team Lead</option></select></label><label>Temporary password <span className="optional-label">Required for new accounts</span><input name="temporary_password" type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="At least 8 characters"/></label>{teamError && <p className="form-error">{teamError}</p>}<div className="dialog-actions"><button className="primary-button" type="submit">Save team member <span>→</span></button></div></form></section></div></section>}
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/>THE KNOWLEDGE BASE</div><h1>Incident library<span className="heading-period">.</span></h1><p>One shared library. Fixes linked to the projects they came from.</p></div><div className="heading-actions"><button className="secondary-button add-project-button" onClick={() => setProjectDialogOpen(true)}>＋ Project</button><button className="primary-button" onClick={() => openIncidentForm()}><span>＋</span> Add an incident</button></div></section>
      <section className="search-panel"><div className="search-row"><span className="search-icon">⌕</span><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} type="search" placeholder="Describe an error, symptom, or paste a stack trace…"/><kbd>⌕</kbd></div><div className="search-meta"><span><span className="sparkle">✳</span> Search your team’s resolved incidents</span><span className="shortcut-hint">Try <button onClick={() => setSearchTerm('connection timeout')}>“connection timeout”</button> or <button onClick={() => setSearchTerm('React hydration')}>“React hydration”</button></span></div><div className="ai-row"><button type="button" className="ai-button" onClick={() => { setChatSeed(searchTerm.trim().length >= 3 ? { id: Date.now(), text: searchTerm.trim().slice(0, 3500) } : null); setView('ai'); setNoteOpen(false); }}><span aria-hidden="true">✦</span> {searchTerm.trim().length >= 3 ? 'Get AI guidance' : 'Ask AI'}</button><span className="ai-hint">{searchTerm.trim().length >= 3 ? 'Chat about this problem. Answers use your team’s resolved incidents.' : 'Chat with an assistant that knows your team’s resolved incidents.'}</span></div></section>
      <section className="stats-row"><div className="stat"><span className="stat-icon purple">▦</span><div><strong>{incidents.length}</strong><span>documented fixes</span></div></div><div className="stat"><span className="stat-icon green">✓</span><div><strong>{incidents.filter((item) => item.verified).length}</strong><span>mentor verified</span></div></div><div className="stat"><span className="stat-icon amber">◷</span><div><strong>{avgResolveMinutes ? formatMinutes(avgResolveMinutes) : '0 min'}</strong><span>avg. time to resolve</span></div></div><div className="stat stat-note"><span className="note-quote">“</span><span>One good fix can save<br/>someone else an afternoon.</span></div></section>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => { setError(''); loadWorkspaces(); if (activeWorkspaceId) { loadIncidents(activeWorkspaceId); loadProjects(activeWorkspaceId); } }}>Retry</button></div>}
      {searchTerm.trim().length >= 3 && <p className="search-status" role="status">{searching ? 'Searching your team’s incidents…' : searchMeta.mode === 'semantic' ? `Ranked by meaning with AI search${searchMeta.unindexed ? ` · ${searchMeta.unindexed} incident${searchMeta.unindexed === 1 ? '' : 's'} not indexed yet` : ''}` : searchResults ? 'Keyword matches only. Start Ollama to rank by meaning.' : ''}</p>}<section className="results-header"><div><h2 title={searchTerm}>{searchTerm ? `Matches for “${searchTerm.trim().replace(/\s+/g, ' ').slice(0, 60)}${searchTerm.trim().length > 60 ? '…' : ''}”` : 'Recently resolved'}</h2><span className="result-count">{matches.length} {matches.length === 1 ? 'incident' : 'incidents'}</span></div><div className="filters"><button className="filter-button" onClick={() => setSortNewest((value) => !value)}>↕ <span>{sortNewest ? 'Recently added' : 'Most relevant'}</span>⌄</button><select className="filter-button filter-select" aria-label="Filter by priority" value={activePriority} onChange={(event) => setActivePriority(event.target.value)}><option value="">All priorities</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option></select><select className="filter-button filter-select" aria-label="Filter by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><select className="filter-button filter-select" aria-label="Filter by tag" value={activeTag} onChange={(event) => setActiveTag(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}</select></div></section>
      <section className="incident-list" aria-live="polite">{loading || (searching && !searchResults) ? <div className="empty-state"><div className="loading-spinner"/><h3>{loading ? 'Loading your incident library' : 'Searching your incidents'}</h3></div> : matches.length ? matches.map((item, index) => <button key={item.id} className={`incident-card ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setNoteOpen(true); }}><div className="card-topline"><span className="card-category">{item.category}</span><span className={`priority-badge priority-${item.priority}`}>{item.priority} priority</span>{item.verified && <span className="verified-badge">Verified fix</span>}{searchResults && searchMeta.mode === 'semantic' && index === 0 && !sortNewest && <span className="best-match-badge">Best match</span>}</div><h3>{item.title}</h3><p className="card-description">{item.symptoms.replace(/```[\w+-]*/g, " ").replace(/\s+/g, " ").trim()}</p><div className="card-bottom"><span className="tag-list">{item.project_name ? <span className="tag project-tag">{item.project_name}</span> : <span className="tag project-tag">Workspace-wide</span>}{item.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</span><span className="card-meta"><span className="mini-avatar">{initials(item.author)}</span>{item.author}<span>·</span>{shortDate(item.created_at)}</span></div><span className="card-arrow">↗</span></button>) : <div className="empty-state"><div className="empty-icon">{searchTerm ? '⌕' : '✳'}</div><h3>{searchTerm ? 'No matching fixes yet' : 'Nothing here yet'}</h3><p>{searchTerm ? 'Try another phrase, or document the fix once it’s solved.' : 'Filter incidents by priority to find the most urgent fixes first.'}</p><button className="text-button" onClick={() => openIncidentForm()}>＋ Document an incident</button></div>}</section>
      <footer className="page-footer"><span><BrandMark small/> A little less debugging from scratch.</span><span>Knowledge grows with every fix <span className="footer-sparkle">✳</span></span></footer>
    </main>
    {noteOpen && selected && <div className="reading-view" role="dialog" aria-modal="true" aria-labelledby="reading-title"><header className="reading-topbar"><button className="reading-back" onClick={() => { setNoteOpen(false); setSelectedId(null); }}><span aria-hidden="true">←</span> Back to incident library</button><div className="reading-workspace"><span>{activeWorkspace?.name || 'Workspace'}</span><span className="reading-separator">/</span><span>{selected.project_name || 'Shared knowledge'}</span></div><div className="reading-actions">{selected.can_edit && <><button className="verify-button" onClick={() => { setNoteOpen(false); openIncidentForm(selected); }}>✎ Edit</button><button className="delete-button" onClick={() => setIncidentToDelete(selected)}>Delete</button></>}{!selected.verified && activeWorkspace?.role === 'team_lead' && <button className="verify-button" onClick={() => setIncidentToVerify(selected)}>✓ Verify fix</button>}<label className="priority-control"><span>Priority</span><select className={`priority-select priority-${selected.priority}`} value={selected.priority} aria-label="Incident priority" onChange={(event) => updateIncidentPriority(selected.id, event.target.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label></div></header><article className="reading-content"><div className="reading-kicker"><span className="reading-kicker-dot"/>{selected.verified ? 'VERIFIED INCIDENT' : 'RESOLVED INCIDENT'}<span className="reading-kicker-separator">·</span>{selected.category}</div><h1 id="reading-title">{selected.title}</h1><div className="reading-meta"><span className="reading-author-avatar">{initials(selected.author)}</span><span className="reading-author"><strong>{selected.author}</strong><small>Resolved {shortDate(selected.created_at)}{selected.updated_at && ` · edited ${shortDate(selected.updated_at)}`}</small></span>{selected.verified && <span className="reading-verified">✓ Mentor verified</span>}</div><section className="reading-scope"><span className="reading-scope-icon">↗</span><div><small>KNOWLEDGE SCOPE</small><strong>{selected.project_name || 'Shared with the whole workspace'}</strong></div></section><div className="reading-sections">{[
          { title: 'What happened', text: selected.symptoms, className: 'reading-symptoms' },
          selected.environment && { title: 'Environment', text: selected.environment },
          selected.steps && { title: 'Steps to reproduce', text: selected.steps },
          { title: 'Root cause', text: selected.cause },
          { title: selected.verified ? 'Verified fix' : 'Resolution', text: selected.fix, fix: true },
          selected.prevention && { title: 'How to prevent it', text: selected.prevention },
        ].filter(Boolean).map((section, index) => <section className={`reading-section ${section.fix ? 'reading-fix' : ''}`} key={section.title}><div className="reading-section-heading"><span className="section-number">{String(index + 1).padStart(2, '0')}</span><h2>{section.title}</h2></div><RichText text={section.text} className={section.className}/></section>)}</div>{(selected.reference_url || selected.resolution_minutes) && <div className="reading-facts">{selected.resolution_minutes && <span><small>TIME TO RESOLVE</small><strong>{formatMinutes(selected.resolution_minutes)}</strong></span>}{selected.reference_url && <span><small>REFERENCE</small><a href={selected.reference_url} target="_blank" rel="noopener noreferrer">{selected.reference_url.replace(/^https?:\/\//i, '')}</a></span>}</div>}<footer className="reading-footer"><div className="reading-tags-label">RELATED TECHNOLOGIES</div><div className="detail-tags">{selected.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div><button className="reading-back reading-back-bottom" onClick={() => { setNoteOpen(false); setSelectedId(null); }}>← Back to incident library</button></footer></article></div>}
    {dialogOpen && <IncidentForm key={editingIncident?.id ?? 'new'} incident={editingIncident} incidents={incidents} projects={projects} role={activeWorkspace?.role} error={error} onSubmit={saveIncident} onClose={closeIncidentForm}/>}
    {incidentToDelete && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIncidentToDelete(null); }}><section className="incident-dialog remove-member-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-incident-title"><div className="dialog-top"><div><div className="eyebrow"><span className="eyebrow-dot"/>INCIDENT LIBRARY</div><h2 id="delete-incident-title">Delete this incident?</h2></div><button className="icon-button" type="button" onClick={() => setIncidentToDelete(null)} aria-label="Close">×</button></div><p className="dialog-intro">Permanently delete <strong>{incidentToDelete.title}</strong>? The team will no longer be able to find this fix.</p><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setIncidentToDelete(null)}>Cancel</button><button className="remove-confirm-button" type="button" onClick={confirmDeleteIncident}>Delete incident</button></div></section></div>}
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
  return <main className="auth-shell"><section className="auth-card"><a className="brand" href="#"><BrandMark/><span className="brand-wordmark">bug<span>replay</span></span></a><div className="auth-eyebrow"><span className="eyebrow-dot"/>{setup ? 'FIRST-TIME SETUP' : changingPassword ? 'ACCOUNT SECURITY' : 'TEAM KNOWLEDGE BASE'}</div><h1>{setup ? 'Create your workspace lead account.' : changingPassword ? 'Set a new password.' : 'Welcome back.'}</h1><p className="auth-description">{setup ? 'Name your workspace. The first account becomes its Team Lead and can invite the rest of your team.' : changingPassword ? `Hi ${user?.name || 'there'}, change your temporary password to continue.` : 'Sign in to search your team’s resolved incidents.'}</p><form className="auth-form" onSubmit={onSubmit}>{setup && <label>Workspace name<input name="workspace_name" required minLength="2" maxLength="120" placeholder="e.g. Your team or company"/></label>}{setup && <label>Your name<input name="name" required minLength="2" maxLength="120" autoComplete="name" placeholder="e.g. Shivam Jha"/></label>}{!changingPassword && <label>Work email<input name="email" required type="email" maxLength="254" autoComplete="email" placeholder="you@company.com"/></label>}{changingPassword && <label>Temporary / current password<input name="current_password" required type="password" autoComplete="current-password"/></label>}{!changingPassword && <label>Password<input name="password" required type="password" minLength="8" maxLength="256" autoComplete={setup ? 'new-password' : 'current-password'} placeholder={setup ? 'At least 8 characters' : 'Enter your password'}/></label>}{changingPassword && <label>New password<input name="new_password" required type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="At least 8 characters"/></label>}{(setup || changingPassword) && <label>Confirm {changingPassword ? 'new ' : ''}password<input name="confirm_password" required type="password" minLength="8" maxLength="256" autoComplete="new-password" placeholder="Enter it again"/></label>}{error && <div className="auth-error" role="alert">{error}{error.includes('connect') && <button type="button" onClick={onRetry}>Retry</button>}</div>}<button className="primary-button auth-submit" type="submit">{setup ? 'Create Team Lead account' : changingPassword ? 'Update password' : 'Sign in'} <span>→</span></button></form><div className="auth-footnote"><span>🔒</span><span>{setup ? 'Your password is securely hashed and never stored as plain text.' : changingPassword ? 'Your account will open once the password is updated.' : 'Your workspace data is available to authorized members only.'}</span></div></section><div className="auth-side-note">Solve it once. <strong>Save the fix.</strong><br/>Replay the learning.</div></main>;
}

function DetailSection({ title, className = '', children }) {
  return <section className={`detail-section ${title === 'Verified fix' ? 'fix-section' : ''}`}><h3>{title}</h3><p className={className}>{children}</p></section>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
