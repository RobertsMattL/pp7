import { useEffect, useState, useRef } from 'react';

/**
 * Custom hook to connect to ParallelAgents WebSocket server
 * and receive real-time agent updates
 */
export default function useWebSocket(url) {
  const [agents, setAgents] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    let ws = null;

    const connect = () => {
      console.log('Connecting to WebSocket:', url);
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data);
          console.log('Received message:', envelope);

          switch (envelope.type) {
            case 'agent_list':
              if (envelope.agent_list && envelope.agent_list.agents) {
                setAgents(envelope.agent_list.agents);
              }
              break;

            case 'status_change':
              if (envelope.status_change) {
                setAgents((prevAgents) =>
                  prevAgents.map((agent) =>
                    agent.agent_id === envelope.status_change.agent_id
                      ? { ...agent, status: envelope.status_change.status }
                      : agent
                  )
                );
              }
              break;

            case 'progress':
              // Could add progress visualization here
              break;

            case 'error':
              console.error('Server error:', envelope.error);
              break;

            default:
              console.log('Unknown message type:', envelope.type);
          }
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          connect();
        }, 3000);
      };
    };

    connect();

    // Cleanup on unmount
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]);

  return {
    agents,
    isConnected,
    ws: wsRef.current,
  };
}
