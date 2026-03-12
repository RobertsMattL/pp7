package protocol

import "encoding/json"

// Message types.
const (
	TypeRegister     = "register"
	TypeAgentList    = "agent_list"
	TypeCommand      = "command"
	TypeProgress     = "progress"
	TypeStatusChange = "status_change"
	TypeError        = "error"
)

// Agent statuses.
const (
	StatusIdle  = "idle"
	StatusBusy  = "busy"
	StatusError = "error"
)

// Envelope is the wire format for all WebSocket messages.
type Envelope struct {
	Type         string        `json:"type"`
	Register     *Register     `json:"register,omitempty"`
	AgentList    *AgentList    `json:"agent_list,omitempty"`
	Command      *Command      `json:"command,omitempty"`
	Progress     *Progress     `json:"progress,omitempty"`
	StatusChange *StatusChange `json:"status_change,omitempty"`
	Error        *Error        `json:"error,omitempty"`
}

// Register is sent by an agent to announce itself.
type Register struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
	WorkDir string `json:"workdir,omitempty"`
}

// AgentInfo describes a single agent in the agent list.
type AgentInfo struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	WorkDir string `json:"workdir,omitempty"`
}

// AgentList is sent by the server to the boss with current agents.
type AgentList struct {
	Agents []AgentInfo `json:"agents"`
}

// Command is sent by the boss to dispatch a prompt to an agent.
type Command struct {
	CommandID string `json:"command_id"`
	AgentID   string `json:"agent_id"`
	Prompt    string `json:"prompt"`
}

// Progress is a streaming output line from an agent's claude process.
type Progress struct {
	CommandID string          `json:"command_id"`
	AgentID   string          `json:"agent_id"`
	Line      json.RawMessage `json:"line"`
	IsFinal   bool            `json:"is_final,omitempty"`
}

// StatusChange indicates an agent's status transition.
type StatusChange struct {
	AgentID string `json:"agent_id"`
	Status  string `json:"status"`
}

// Error carries a protocol-level error.
type Error struct {
	AgentID string `json:"agent_id,omitempty"`
	Message string `json:"message"`
}
