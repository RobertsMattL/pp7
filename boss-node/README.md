# ParallelAgents Boss - Node.js Edition

A modern Electron-based UI for managing distributed Claude agents in the ParallelAgents system.

## Features

- **Multi-Console Interface**: Each agent gets its own dedicated console window with real-time output
- **GitHub Integration**: Clone repositories directly from GitHub and automatically start agents in fresh project directories
- **Agent Process Management**: Automatically spawns and manages ParallelAgents agent processes in cloned repositories
- **Git Output Display**: All git clone operations stream their output to the agent's console in real-time
- **Terminal-like Input**: Type prompts directly in each agent's console with a terminal-style input at the bottom
- **Pinned Prompts**: Current user prompts are pinned at the top of each console during execution
- **Context-Aware Execution**: Claude runs in the agent's working directory with full access to the repository
- **Dark Theme**: Beautiful dark UI optimized for long coding sessions
- **WebSocket Connection**: Connects to the existing ParallelAgents server infrastructure
- **Real-time Status**: Live status updates for each agent (idle, busy, error)
- **Seamless Transitions**: Temporary consoles for git output automatically transition to active agent consoles

## Architecture

The boss-node application consists of:

- **Electron Main Process** (`src/main.js`): Handles window management, menus, and git operations
- **Preload Script** (`src/preload.js`): Secure bridge between main and renderer processes
- **Renderer Process** (`public/renderer.js`): UI logic and WebSocket communication
- **HTML/CSS** (`public/index.html`, `public/styles.css`): Modern dark-themed interface

## Installation

```bash
cd boss-node
npm install
```

## Usage

### Starting the Boss UI

```bash
npm start
```

Or for development mode:

```bash
npm run dev
```

### Creating a New Agent

1. Click **File → New Agent from GitHub** in the menu
2. Enter the GitHub repository URL (e.g., `https://github.com/username/repo.git`)
3. Optionally provide a custom agent name
4. Click **Clone & Create Agent**
5. Watch the process:
   - A temporary console appears showing git clone progress
   - The repository is cloned to a timestamped directory
   - The ParallelAgents agent process starts in the cloned directory
   - The agent connects to the server and registers itself
   - The console transitions from temporary (disabled input) to active agent
   - Input becomes enabled once the agent is fully connected

### Sending Prompts to Agents

1. Wait for the agent console input to become enabled (no longer grayed out)
2. Type your prompt in the input field at the bottom of the console
3. Press Enter or click the Send button
4. The prompt will be pinned at the top of the console during execution
5. Claude executes in the agent's working directory (the cloned repository)
6. All tool executions happen in the context of that repository
7. Agent responses stream in real-time to the console output area

### Navigation

- Each agent console is displayed side-by-side
- Consoles automatically adjust their width based on the number of agents
- Scroll within each console independently
- Input fields are always visible at the bottom of each console

## WebSocket Protocol

The application connects to the ParallelAgents server at `ws://localhost:8080/ws/boss` and uses the existing protocol:

### Messages Received from Server

- `agent_list`: List of connected agents
- `status_change`: Agent status updates (idle, busy, error)
- `progress`: Streaming output from agent's Claude process
- `error`: Error messages

### Messages Sent to Server

- `command`: User prompts directed to specific agents

## Console Output Formatting

The console displays different types of messages with distinct styling:

- **[user]**: User prompts (blue)
- **[tool]**: Tool invocations (yellow)
- **[tool_result]**: Tool execution results (gray)
- **[system]**: System messages (green)
- **[error]**: Errors (red)
- **[done]**: Task completion (green)
- **git output**: Git clone progress (gray)

## Directory Structure

```
boss-node/
├── src/
│   ├── main.js         # Electron main process
│   └── preload.js      # Preload script for IPC
├── public/
│   ├── index.html      # Main UI
│   ├── styles.css      # Dark theme styles
│   └── renderer.js     # Renderer process logic
├── package.json
└── README.md
```

## Repository Storage

Cloned repositories are stored in the Electron user data directory:

- macOS: `~/Library/Application Support/parallelagents-boss-node/repos/`
- Linux: `~/.config/parallelagents-boss-node/repos/`
- Windows: `%APPDATA%/parallelagents-boss-node/repos/`

Each repository is cloned into a timestamped directory to ensure uniqueness.

## Requirements

- Node.js 18+
- Running ParallelAgents server (port 8080)
- Git installed and available in PATH

## Development

The application uses standard Electron architecture with:

- Main process for system operations (git, file system)
- Renderer process for UI and WebSocket communication
- IPC for secure communication between processes
- Context isolation enabled for security

## Future Enhancements

- Agent process management (start/stop Claude agents)
- Tabs or workspace management for many agents
- Console output search and filtering
- Export console logs
- Agent performance metrics
- Custom themes
