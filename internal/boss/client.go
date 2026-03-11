package boss

import (
	"encoding/json"
	"log"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/gorilla/websocket"
	"github.com/matthewroberts/parallelagents/internal/protocol"
)

// Tea messages bridged from WebSocket.
type (
	AgentListMsg   protocol.AgentList
	ProgressMsg    protocol.Progress
	StatusMsg      protocol.StatusChange
	ServerErrorMsg protocol.Error
	ConnectedMsg   struct{}
	DisconnectMsg  struct{ Err error }
)

// WSClient manages the WebSocket connection and bridges messages to bubbletea.
type WSClient struct {
	conn    *websocket.Conn
	program *tea.Program
}

// NewWSClient dials the server and returns a WSClient.
func NewWSClient(serverURL string) (*WSClient, error) {
	conn, _, err := websocket.DefaultDialer.Dial(serverURL, nil)
	if err != nil {
		return nil, err
	}
	return &WSClient{conn: conn}, nil
}

// SetProgram sets the bubbletea program for message bridging.
func (w *WSClient) SetProgram(p *tea.Program) {
	w.program = p
}

// ReadPump reads messages from the WebSocket and sends them as tea.Msg.
// Run this in a goroutine.
func (w *WSClient) ReadPump() {
	defer func() {
		w.conn.Close()
	}()

	w.program.Send(ConnectedMsg{})

	for {
		_, message, err := w.conn.ReadMessage()
		if err != nil {
			w.program.Send(DisconnectMsg{Err: err})
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("parse error: %v", err)
			continue
		}

		switch env.Type {
		case protocol.TypeAgentList:
			if env.AgentList != nil {
				w.program.Send(AgentListMsg(*env.AgentList))
			}
		case protocol.TypeProgress:
			if env.Progress != nil {
				w.program.Send(ProgressMsg(*env.Progress))
			}
		case protocol.TypeStatusChange:
			if env.StatusChange != nil {
				w.program.Send(StatusMsg(*env.StatusChange))
			}
		case protocol.TypeError:
			if env.Error != nil {
				w.program.Send(ServerErrorMsg(*env.Error))
			}
		}
	}
}

// SendCommand sends a command envelope to the server.
func (w *WSClient) SendCommand(cmd protocol.Command) error {
	env := protocol.Envelope{
		Type:    protocol.TypeCommand,
		Command: &cmd,
	}
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return w.conn.WriteMessage(websocket.TextMessage, data)
}

// Close closes the WebSocket connection.
func (w *WSClient) Close() error {
	return w.conn.Close()
}
