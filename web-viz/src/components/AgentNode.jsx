import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import './AgentNode.css';

function AgentNode({ data }) {
  const { name, status, agentId } = data;

  const getStatusColor = (status) => {
    switch (status) {
      case 'idle':
        return '#10b981'; // green
      case 'busy':
        return '#fbbf24'; // yellow
      case 'error':
        return '#ef4444'; // red
      default:
        return '#6b7280'; // gray
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'idle':
        return 'IDLE';
      case 'busy':
        return 'BUSY';
      case 'error':
        return 'ERROR';
      default:
        return 'UNKNOWN';
    }
  };

  return (
    <div className="agent-node" style={{ borderColor: getStatusColor(status) }}>
      <Handle type="target" position={Position.Top} />

      <div className="agent-node-header">
        <div
          className="agent-node-status"
          style={{ backgroundColor: getStatusColor(status) }}
        >
          {getStatusLabel(status)}
        </div>
      </div>

      <div className="agent-node-body">
        <div className="agent-node-name">{name}</div>
        <div className="agent-node-id">{agentId.slice(0, 8)}...</div>
      </div>

      {status === 'busy' && (
        <div className="agent-node-footer">
          <div className="agent-node-spinner"></div>
          <span>Working...</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(AgentNode);
