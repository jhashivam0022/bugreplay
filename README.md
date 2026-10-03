# 🐛 BugReplay

### Helping Developers Learn from Bugs Their Team Has Already Solved

**BugReplay** is an AI-powered debugging knowledge assistant designed to help development teams find previously resolved bugs, understand their root causes, and reuse verified solutions instead of starting from scratch.

Ever spent hours debugging an issue, only to find out your teammate had already fixed it? BugReplay aims to solve this problem by turning a team's past debugging experience into reusable knowledge.

> 🚀 Solve it once. Save the fix. Replay the learning.

---

## 💡 The Problem

In software development, teams often encounter similar bugs repeatedly.

* 🐛 Developers spend time investigating issues that teammates have already solved.
* 💬 Solutions get buried in chat conversations, GitHub issues, and documentation.
* 🧠 Technical knowledge often stays with the developer who fixed the issue.
* 🔄 Teams repeat debugging efforts instead of learning from previous experiences.

Existing AI coding assistants can provide general debugging suggestions, but they may not have access to a team's own verified debugging history.

## 🎯 The Solution

BugReplay aims to make a team's debugging experience searchable and reusable.

Developers can submit an error message, stack trace, or relevant log. BugReplay searches previously resolved incidents for similar problems and uses relevant verified solutions to provide contextual troubleshooting guidance.

The goal is not to replace developers or mentors, but to help teams debug smarter and share knowledge.

## ✨ Key Features

* 🔍 **Semantic Bug Search**
  Find similar, previously resolved bugs using semantic search rather than relying only on exact keyword matches.

* 🧠 **Root Cause Insights**
  Explore the root causes and fixes documented in similar incidents.

* 🤖 **AI-Powered Troubleshooting**
  Get AI-generated debugging guidance grounded in the team's previous verified solutions.

* 📚 **Shared Debugging Knowledge**
  Store resolved incidents in a searchable knowledge base accessible to the team.

* 🤝 **Mentor Verification**
  Allow mentors or authorized team members to review and approve solutions before they become trusted knowledge.

* 🔄 **Continuous Learning**
  Add newly resolved bugs to the knowledge base so the team can benefit from future discoveries.

## ⚙️ How It Works

1. **Submit an Error**
   A developer pastes an error message, stack trace, or relevant log into BugReplay.

2. **Search Similar Incidents**
   The system uses semantic search to retrieve relevant incidents from the team's knowledge base.

3. **Review Previous Solutions**
   Developers can inspect the symptoms, verified root causes, and solutions from matching incidents.

4. **Get AI Guidance**
   The AI uses the retrieved incidents to suggest possible troubleshooting steps while recognizing that similar errors can have different causes.

5. **Verify and Save**
   Once the new issue is resolved, the solution can be reviewed and approved before being added to the shared knowledge base.

## 🏗️ Planned Tech Stack

| Component       | Technology                           |
| --------------- | ------------------------------------ |
| Frontend        | React                                |
| Backend         | Python, FastAPI                      |
| AI Model        | Qwen (open-weight model)             |
| Database        | PostgreSQL                           |
| Vector Search   | pgvector                             |
| AI Architecture | Retrieval-Augmented Generation (RAG) |

## 🚀 Getting Started

BugReplay runs locally with a React/Vite frontend and a FastAPI backend. The backend creates a SQLite database at `backend/bugreplay.db` on first run and adds starter incidents and projects.

### Prerequisites

* Python 3.10 or newer
* Node.js 20 or newer and npm

### Install and run the backend

Clone the repository:

```bash
git clone https://github.com/jhashivam0022/bugreplay.git
cd bugreplay
```

Create a virtual environment in `backend`, install dependencies, and start the API.

**Windows PowerShell**

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

**macOS or Linux**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

### Install and run the frontend

Open a second terminal from the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API runs at [http://localhost:8000](http://localhost:8000), and its interactive documentation is at [http://localhost:8000/docs](http://localhost:8000/docs). Keep both servers running while using the app.

On first run, create the Team Lead account from the setup screen. The first account becomes Team Lead for the default workspace; there is no default password. Team Leads can add employees or other Team Leads from the **Team members** sidebar tab.

## 🔐 Privacy and Security

BugReplay is intended to work with approved, non-sensitive debugging incidents.

* Avoid submitting passwords, API keys, access tokens, personal information, or confidential production data.
* Review logs and stack traces before adding them to the knowledge base.
* Apply appropriate access controls to team-specific incidents.
* Verify AI-generated suggestions before applying them to any environment.

## 🗺️ Roadmap

* [x] Build the React frontend
* [x] Develop the FastAPI backend
* [x] Support SQLite and PostgreSQL databases
* [ ] Add pgvector semantic search
* [x] Implement incident submission and local database storage
* [ ] Add semantic search for resolved bugs
* [ ] Integrate the Qwen model for AI-assisted troubleshooting
* [x] Add Team Lead review and incident verification
* [x] Add workspace and project organization
* [x] Add team accounts, multiple Team Leads, and member management
* [x] Add incident priorities and library filters
* [ ] Test with real-world debugging scenarios
* [ ] Deploy a working demo

## 🌱 Why Open-Weight AI?

BugReplay explores how open-weight AI models can be used to build practical, team-focused developer tools.

Using Qwen provides an opportunity to experiment with model deployment, retrieval-augmented generation, and AI-assisted workflows while retaining flexibility over the model and infrastructure.

## 🤝 Contributing

Contributions, suggestions, and feedback are welcome!

If you're interested in improving BugReplay, feel free to:

* Open an issue to report a bug or suggest a feature.
* Share ideas for improving the debugging workflow.
* Submit a pull request with improvements.

Please ensure that contributions do not include confidential code, credentials, or sensitive incident data.

## 🎯 Project Goal

BugReplay is being built to help developers learn from their team's collective experience, reduce repeated debugging efforts, and make technical knowledge easier to access.

**Solve it once. Save the fix. Replay the learning.** 🐛

---

## 📌 Challenge

This project is a submission for the **[Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01)**.

## 📄 License

A license will be added to the repository.
