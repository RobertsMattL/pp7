package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/matthewroberts/parallelagents/internal/protocol"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 1 << 20 // 1 MB
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// Client represents a single WebSocket connection (agent or boss).
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// Only set for agent clients.
	agentID string
	name    string
	status  string

	isBoss bool
}

// Hub maintains the set of active clients and routes messages.
type Hub struct {
	mu     sync.RWMutex
	agents map[string]*Client // keyed by agentID
	boss   *Client
}

// NewHub creates a new Hub.
func NewHub() *Hub {
	return &Hub{
		agents: make(map[string]*Client),
	}
}

// Handler returns an http.ServeMux with the hub's endpoints.
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/agent", h.handleAgent)
	mux.HandleFunc("/ws/boss", h.handleBoss)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	return mux
}

func (h *Hub) handleAgent(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("agent upgrade error: %v", err)
		return
	}
	c := &Client{
		hub:  h,
		conn: conn,
		send: make(chan []byte, 256),
	}
	go c.writePump()
	go c.readPumpAgent()
}

func (h *Hub) handleBoss(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("boss upgrade error: %v", err)
		return
	}
	c := &Client{
		hub:    h,
		conn:   conn,
		send:   make(chan []byte, 256),
		isBoss: true,
	}

	h.mu.Lock()
	if h.boss != nil {
		// Close old boss connection.
		close(h.boss.send)
	}
	h.boss = c
	h.mu.Unlock()

	// Send current agent list to the new boss.
	h.sendAgentListToBoss()

	go c.writePump()
	go c.readPumpBoss()
}

// registerAgent adds an agent to the hub and notifies the boss.
func (h *Hub) registerAgent(c *Client, reg *protocol.Register) {
	c.agentID = reg.AgentID
	c.name = reg.Name
	c.status = protocol.StatusIdle

	h.mu.Lock()
	h.agents[c.agentID] = c
	h.mu.Unlock()

	log.Printf("agent registered: %s (%s)", c.name, c.agentID)
	h.sendAgentListToBoss()
}

// removeAgent removes an agent and notifies the boss.
func (h *Hub) removeAgent(c *Client) {
	if c.agentID == "" {
		return
	}
	h.mu.Lock()
	delete(h.agents, c.agentID)
	h.mu.Unlock()

	log.Printf("agent disconnected: %s (%s)", c.name, c.agentID)
	h.sendAgentListToBoss()
}

// removeBoss clears the boss reference.
func (h *Hub) removeBoss(c *Client) {
	h.mu.Lock()
	if h.boss == c {
		h.boss = nil
	}
	h.mu.Unlock()
	log.Println("boss disconnected")
}

// sendAgentListToBoss sends the current agent list to the boss client.
func (h *Hub) sendAgentListToBoss() {
	h.mu.RLock()
	boss := h.boss
	agents := make([]protocol.AgentInfo, 0, len(h.agents))
	for _, a := range h.agents {
		agents = append(agents, protocol.AgentInfo{
			AgentID: a.agentID,
			Name:    a.name,
			Status:  a.status,
		})
	}
	h.mu.RUnlock()

	if boss == nil {
		return
	}

	env := protocol.Envelope{
		Type: protocol.TypeAgentList,
		AgentList: &protocol.AgentList{
			Agents: agents,
		},
	}
	data, err := json.Marshal(env)
	if err != nil {
		log.Printf("marshal agent_list error: %v", err)
		return
	}
	select {
	case boss.send <- data:
	default:
		log.Println("boss send buffer full, dropping agent_list")
	}
}

// routeCommandToAgent sends a command from the boss to the target agent.
func (h *Hub) routeCommandToAgent(env *protocol.Envelope) {
	cmd := env.Command
	if cmd == nil {
		return
	}

	h.mu.RLock()
	agent, ok := h.agents[cmd.AgentID]
	h.mu.RUnlock()

	if !ok {
		h.sendErrorToBoss("agent not found: " + cmd.AgentID)
		return
	}

	data, err := json.Marshal(env)
	if err != nil {
		log.Printf("marshal command error: %v", err)
		return
	}
	select {
	case agent.send <- data:
	default:
		h.sendErrorToBoss("agent send buffer full: " + cmd.AgentID)
	}
}

// forwardToBoss forwards a message from an agent to the boss.
func (h *Hub) forwardToBoss(data []byte) {
	h.mu.RLock()
	boss := h.boss
	h.mu.RUnlock()

	if boss == nil {
		return
	}
	select {
	case boss.send <- data:
	default:
		log.Println("boss send buffer full, dropping message")
	}
}

func (h *Hub) sendErrorToBoss(msg string) {
	env := protocol.Envelope{
		Type:  protocol.TypeError,
		Error: &protocol.Error{Message: msg},
	}
	data, _ := json.Marshal(env)
	h.forwardToBoss(data)
}

// updateAgentStatus updates the status of an agent and notifies the boss.
func (h *Hub) updateAgentStatus(agentID, status string) {
	h.mu.Lock()
	if a, ok := h.agents[agentID]; ok {
		a.status = status
	}
	h.mu.Unlock()
	h.sendAgentListToBoss()
}

// readPumpAgent reads messages from an agent WebSocket connection.
func (c *Client) readPumpAgent() {
	defer func() {
		c.hub.removeAgent(c)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("agent read error: %v", err)
			}
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("agent message parse error: %v", err)
			continue
		}

		switch env.Type {
		case protocol.TypeRegister:
			if env.Register != nil {
				c.hub.registerAgent(c, env.Register)
			}
		case protocol.TypeProgress:
			if env.Progress != nil {
				env.Progress.AgentID = c.agentID
			}
			c.hub.forwardToBoss(message)
		case protocol.TypeStatusChange:
			if env.StatusChange != nil {
				c.hub.updateAgentStatus(c.agentID, env.StatusChange.Status)
			}
		case protocol.TypeError:
			c.hub.forwardToBoss(message)
		default:
			log.Printf("unknown message type from agent: %s", env.Type)
		}
	}
}

// readPumpBoss reads messages from the boss WebSocket connection.
func (c *Client) readPumpBoss() {
	defer func() {
		c.hub.removeBoss(c)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("boss read error: %v", err)
			}
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("boss message parse error: %v", err)
			continue
		}

		switch env.Type {
		case protocol.TypeCommand:
			c.hub.routeCommandToAgent(&env)
		default:
			log.Printf("unknown message type from boss: %s", env.Type)
		}
	}
}

// writePump pumps messages from the send channel to the WebSocket connection.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
