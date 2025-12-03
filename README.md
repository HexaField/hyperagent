# Hyperagent

Hyperagent is a collaborative command center for teams that rely on AI agents to ship software. It brings workflows, logs, terminals, and code views onto a single canvas so you can see what the agents are doing, guide them when needed, and keep work moving without juggling tools.

## Overview: Intent & Functionality

- **One canvas for everything**: Arrange widgets for workflows, terminals, narration, and code wherever you want and save your preferred layout per workspace.
- **Agent-aware operations**: Launch automated runs, watch live narration, and jump in with manual fixes when the agents need a hand.
- **Repository-focused**: Each workspace maps to a repo so status, commits, and history stay visible while automations run.

## Getting Started

1. **Install dependencies**: `npm install`
2. **Start the workspace**: `npm run dev` launches both the webapp and API for local exploration.
3. **Open the canvas**: Visit the printed URL (usually `http://localhost:5173`) to pick a workspace, add widgets, and try a sample workflow.
4. **Explore automations**: Use the Workflows widget to kick off a run, open the Narrator feed for context, and drop into the Terminal or Code widget if you want to assist.

## Simple Architecture Overview

- **Webapp (SolidJS + Vite)**: Lives in `src/client`, renders the canvas UI, and hosts the widget registry so features load only when you need them.
- **Server (Node + Express)**: Resides in `src/server` and `src/modules`, exposes REST and streaming endpoints for workflows, terminals, narration, and code sync.
- **Widgets + Services**: Every widget has a matching server module (e.g., Workflows, Terminal, Narrator) so UI interactions map directly to focused APIs.
- **Automation Runners**: Workflow executors and agent loops run jobs, send status updates back through the server, and surface them on the canvas in near real time.
