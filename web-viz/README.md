# ParallelAgents Visualization

Real-time web-based visualization of ParallelAgents using React Flow. See all your agents and their current status in an interactive, draggable graph.

![ParallelAgents Viz](screenshot.png)

## Features

- 🎯 **Real-time Updates** - WebSocket connection shows live agent status
- 🎨 **Interactive Graph** - Drag nodes, zoom, pan with React Flow
- 📊 **Visual Status** - Color-coded agents (green=idle, yellow=busy, red=error)
- 🔄 **Auto-reconnect** - Automatically reconnects if connection drops
- 📡 **Live Connections** - Animated edges show active data flow

## Installation

```bash
cd web-viz
npm install
```

## Usage

### 1. Start the ParallelAgents Server

```bash
cd ..
./bin/parallelagents-server
```

The server must be running on `ws://localhost:8080` for the visualization to connect.

### 2. Start Agents

```bash
# Terminal 2
./bin/parallelagents-agent --name agent1

# Terminal 3
./bin/parallelagents-agent --name agent2

# Add more agents as needed...
```

### 3. Start the Visualization

```bash
cd web-viz
npm run dev
```

Open your browser to `http://localhost:3000`

## What You'll See

### Server Node
- Purple gradient node in the center
- Shows "running" status with pulsing indicator
- Connects to all agents

### Agent Nodes
- **Green** - Agent is IDLE (ready for tasks)
- **Yellow** - Agent is BUSY (working on a task)
- **Red** - Agent has ERROR

Each agent node shows:
- Agent name
- Agent ID (first 8 characters)
- Current status
- Working indicator (when busy)

### Connections
- Static gray lines - Agent is idle
- Animated yellow lines - Agent is busy

## Architecture

```
┌─────────────────────────────────────┐
│   React Flow Visualization          │
│   (Browser - Port 3000)              │
└────────────┬────────────────────────┘
             │ WebSocket
             ↓
┌─────────────────────────────────────┐
│   ParallelAgents Server              │
│   (Go - Port 8080)                   │
└──────┬──────────────┬────────────────┘
       │              │
       ↓              ↓
   Agent 1        Agent 2 ...
```

The visualization connects to the same WebSocket endpoint (`/ws/boss`) that the boss TUI uses, receiving:

- `agent_list` - Complete list of agents on connect
- `status_change` - Individual agent status updates
- `progress` - Task progress (could be visualized in future)
- `error` - Error messages

## Development

### Project Structure

```
web-viz/
├── src/
│   ├── components/
│   │   ├── AgentNode.jsx      # Agent node component
│   │   ├── AgentNode.css
│   │   ├── ServerNode.jsx     # Server node component
│   │   └── ServerNode.css
│   ├── hooks/
│   │   └── useWebSocket.js    # WebSocket connection hook
│   ├── App.jsx                # Main app with React Flow
│   ├── App.css
│   ├── main.jsx               # Entry point
│   └── index.css
├── index.html
├── vite.config.js
└── package.json
```

### Customization

**Change Server URL:**

Edit `src/App.jsx`:
```javascript
const { agents, isConnected } = useWebSocket('ws://your-server:8080/ws/boss');
```

**Adjust Node Layout:**

Modify the radius in `src/App.jsx`:
```javascript
const radius = 250;  // Increase for larger circle
```

**Change Colors:**

Edit component CSS files:
- `src/components/AgentNode.css`
- `src/components/ServerNode.css`

## Technologies Used

- **React** - UI framework
- **React Flow** - Graph visualization
- **Vite** - Build tool
- **WebSocket** - Real-time communication

## Troubleshooting

### "WebSocket connection failed"
- Ensure ParallelAgents server is running on port 8080
- Check browser console for errors

### "No agents showing"
- Make sure at least one agent is connected
- Check server logs for agent registration

### "Nodes overlap"
- Zoom out with mouse wheel
- Use React Flow controls (bottom-left)
- Try dragging nodes to better positions

## Future Enhancements

- [ ] Show current task in agent node
- [ ] Display task progress bar
- [ ] Add filtering/searching agents
- [ ] Show performance metrics
- [ ] Export graph as image
- [ ] Custom node layouts (tree, grid, etc.)
- [ ] Task history timeline
- [ ] Agent-to-agent collaboration visualization

## License

Same as ParallelAgents project
