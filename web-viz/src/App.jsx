import { useCallback, useEffect, useState } from 'react';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
} from 'reactflow';
import 'reactflow/dist/style.css';

import AgentNode from './components/AgentNode';
import ServerNode from './components/ServerNode';
import useWebSocket from './hooks/useWebSocket';
import './App.css';

const nodeTypes = {
  agent: AgentNode,
  server: ServerNode,
};

const initialNodes = [
  {
    id: 'server',
    type: 'server',
    position: { x: 400, y: 50 },
    data: { label: 'ParallelAgents Server', status: 'running' },
  },
];

const initialEdges = [];

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  const { agents, isConnected } = useWebSocket('ws://localhost:8080/ws/boss');

  useEffect(() => {
    setConnectionStatus(isConnected ? 'connected' : 'disconnected');
  }, [isConnected]);

  // Update nodes when agents change
  useEffect(() => {
    if (!agents || agents.length === 0) {
      setNodes([initialNodes[0]]);
      setEdges([]);
      return;
    }

    // Create agent nodes in a circle around the server
    const radius = 250;
    const centerX = 400;
    const centerY = 300;

    const agentNodes = agents.map((agent, index) => {
      const angle = (index / agents.length) * 2 * Math.PI - Math.PI / 2;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);

      return {
        id: agent.agent_id,
        type: 'agent',
        position: { x, y },
        data: {
          name: agent.name,
          status: agent.status,
          agentId: agent.agent_id,
        },
      };
    });

    // Create edges from server to each agent
    const agentEdges = agents.map((agent) => ({
      id: `server-${agent.agent_id}`,
      source: 'server',
      target: agent.agent_id,
      type: 'smoothstep',
      animated: agent.status === 'busy',
      style: {
        stroke: agent.status === 'busy' ? '#fbbf24' : '#9ca3af',
        strokeWidth: 2,
      },
    }));

    setNodes([initialNodes[0], ...agentNodes]);
    setEdges(agentEdges);
  }, [agents, setNodes, setEdges]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <div className="connection-status" data-status={connectionStatus}>
        {connectionStatus === 'connected' ? '● Connected' : '○ Disconnected'}
      </div>
      <div className="agent-count">
        Agents: {agents?.length || 0}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
      >
        <Controls />
        <MiniMap />
        <Background variant="dots" gap={12} size={1} />
      </ReactFlow>
    </div>
  );
}

export default App;
