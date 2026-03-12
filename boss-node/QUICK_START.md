# ParallelAgents Boss Node - Quick Start Guide

## What You've Got

A complete Electron-based boss application for ParallelAgents with:

✅ **Multi-console UI** - Each agent has its own dedicated console
✅ **Dark theme** - Beautiful dark interface optimized for long sessions
✅ **GitHub integration** - Clone repos directly from GitHub
✅ **Git output streaming** - Watch git clone progress in real-time
✅ **Terminal input** - Type prompts at the bottom of each console
✅ **Pinned prompts** - Current prompt shown at top of each console
✅ **WebSocket connection** - Connects to your existing server
✅ **File menu** - Easy agent creation from the menu bar

## File Structure

```
boss-node/
├── src/
│   ├── main.js         # Electron main process (window, menus, git)
│   └── preload.js      # Secure IPC bridge
├── public/
│   ├── index.html      # UI layout
│   ├── styles.css      # Dark theme
│   └── renderer.js     # WebSocket & UI logic
├── package.json        # Dependencies
├── start.sh           # Launch script
└── README.md          # Full documentation
```

## Quick Start

### 1. Make sure the server is running

```bash
# In the main project directory
cd /Users/matthewroberts/development/projects/pp7
./bin/parallelagents-server
```

### 2. Launch the Boss UI

```bash
cd boss-node
npm start
```

Or use the launch script:

```bash
./start.sh
```

### 3. Create an Agent

1. Click **File → New Agent from GitHub**
2. Enter a GitHub URL (e.g., `https://github.com/yourusername/your-repo.git`)
3. Optionally name your agent
4. Click **Clone & Create Agent**
5. Watch the process:
   - Git clone output streams to a temporary console
   - Repository is cloned to a timestamped directory
   - ParallelAgents agent process starts in the cloned directory
   - Agent connects to the server and registers
   - Console transitions from temporary to real agent
   - Input becomes enabled once agent is connected

### 4. Send Prompts

1. Wait for the agent console input to become enabled (no longer grayed out)
2. Type your prompt in the input at the bottom of the agent console
3. Press Enter or click Send
4. The prompt will be pinned to the top of the console
5. Claude will run in the agent's working directory (the cloned repo)
6. All Claude output streams back in real-time
7. Tool executions happen in the context of the repository

## Key Features

### Console Output Types

The console uses color-coded output:
- **Blue** - User prompts
- **Yellow** - Tool invocations
- **Green** - System messages and completions
- **Red** - Errors
- **Gray** - Tool results and git output

### Agent Status

Each agent shows its status in the header:
- **IDLE** - Ready for commands
- **BUSY** - Processing a task
- **ERROR** - Something went wrong

### Repository Storage

Cloned repos are stored in:
```
~/Library/Application Support/parallelagents-boss-node/repos/
```

Each repo gets a timestamped directory for uniqueness.

## Architecture

```
┌─────────────────────────────────────────────┐
│         Electron Main Process               │
│  - Window Management                        │
│  - File Menu                                │
│  - Git Clone Operations                     │
│  - Agent Process Spawning                   │
│  - IPC Communication                        │
└─────────────────┬───────────────────────────┘
                  │
                  │ IPC (git output)
                  │
┌─────────────────▼───────────────────────────┐
│       Electron Renderer Process             │
│  - Multi-Console UI                         │
│  - WebSocket Client (Boss)                  │
│  - Real-time Output Display                 │
│  - User Input Handling                      │
└─────────────────┬───────────────────────────┘
                  │
                  │ WebSocket
                  │
┌─────────────────▼───────────────────────────┐
│      ParallelAgents Server (Go)             │
│  - WebSocket Hub (/ws/agent, /ws/boss)      │
│  - Agent Management                         │
│  - Message Routing                          │
│  - Command Distribution                     │
└───────┬─────────────────────────────────┬───┘
        │                                 │
        │ WebSocket                       │ WebSocket
        │ /ws/agent                       │ /ws/agent
        │                                 │
┌───────▼─────────────────┐   ┌───────────▼─────────────┐
│ ParallelAgents Agent 1  │   │ ParallelAgents Agent 2  │
│ (spawned by Boss Node)  │   │ (spawned by Boss Node)  │
│ Working dir: repo-1/    │   │ Working dir: repo-2/    │
│  - Receives prompts     │   │  - Receives prompts     │
│  - Executes Claude CLI  │   │  - Executes Claude CLI  │
│  - Streams output back  │   │  - Streams output back  │
└─────────────────────────┘   └─────────────────────────┘
```

### Data Flow

1. **Agent Creation**:
   - User enters GitHub URL in Boss UI
   - Main process clones repo → streams git output to renderer
   - Main process spawns `parallelagents-agent` in cloned directory
   - Agent connects to server via WebSocket
   - Server notifies Boss UI of new agent
   - UI transitions temp console to real agent console

2. **Sending Prompts**:
   - User types prompt in agent console
   - Renderer sends command to server via WebSocket
   - Server routes command to specific agent
   - Agent executes Claude CLI in its working directory
   - Claude output streams back: Agent → Server → Boss UI
   - UI displays output in real-time

## WebSocket Protocol

The app uses the existing ParallelAgents protocol:

### Sent Messages
```json
{
  "type": "command",
  "command": {
    "command_id": "uuid",
    "agent_id": "agent-123",
    "prompt": "your prompt here"
  }
}
```

### Received Messages
```json
{
  "type": "agent_list",
  "agent_list": {
    "agents": [...]
  }
}

{
  "type": "progress",
  "progress": {
    "agent_id": "agent-123",
    "line": {...},
    "is_final": false
  }
}

{
  "type": "status_change",
  "status_change": {
    "agent_id": "agent-123",
    "status": "busy"
  }
}
```

## Troubleshooting

### "Not connected to server"
- Make sure `parallelagents-server` is running on port 8080
- Check the connection status indicator in the top-left

### Git clone fails
- Verify the GitHub URL is correct
- Check your internet connection
- Ensure git is installed: `git --version`

### No agents showing up
- Make sure agents are registered with the server
- Check the WebSocket connection (top-left indicator should be green)
- Look for errors in the console (View → Toggle Dev Tools)

## Development

### Enable Dev Tools
Click **View → Toggle Dev Tools** to see console logs and debug

### File Locations
- Main process logs: Terminal where you ran `npm start`
- Renderer logs: Dev Tools console
- WebSocket traffic: Dev Tools Network tab → WS

## Next Steps

1. **Start the server**: `./bin/parallelagents-server`
2. **Launch the UI**: `cd boss-node && npm start`
3. **Clone a repo**: File → New Agent from GitHub
4. **Send prompts**: Type in the console input and press Enter

Enjoy your new ParallelAgents Boss UI! 🚀
