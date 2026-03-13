package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/matthewroberts/parallelagents/internal/protocol"
)

// Commander abstracts the execution of claude CLI for testability.
type Commander interface {
	// Run executes a command and streams output lines to the callback.
	// It blocks until the process exits.
	Run(ctx context.Context, prompt string, workdir string, onLine func(line []byte)) error
}

// ClaudeCommander runs the real claude CLI.
type ClaudeCommander struct{}

func (c *ClaudeCommander) Run(ctx context.Context, prompt string, workdir string, onLine func(line []byte)) error {
	cmd := exec.CommandContext(ctx, "claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions")
	if workdir != "" {
		cmd.Dir = workdir
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start claude: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1<<20), 1<<20) // 1MB buffer
	for scanner.Scan() {
		onLine(scanner.Bytes())
	}

	if err := cmd.Wait(); err != nil {
		stderr := strings.TrimSpace(stderrBuf.String())
		if stderr != "" {
			return fmt.Errorf("%w: %s", err, stderr)
		}
		return fmt.Errorf("%w (no stderr captured — claude may have written the error to stdout)", err)
	}
	return nil
}

// Agent wraps a claude process and connects to the server.
type Agent struct {
	id        string
	name      string
	serverURL string
	workdir   string
	commander Commander

	mu   sync.Mutex
	conn *websocket.Conn
	busy bool
}

// New creates a new Agent.
func New(name, serverURL, workdir string, commander Commander) *Agent {
	if commander == nil {
		commander = &ClaudeCommander{}
	}
	return &Agent{
		id:        uuid.New().String(),
		name:      name,
		serverURL: serverURL,
		workdir:   workdir,
		commander: commander,
	}
}

// Run connects to the server and processes commands until the context is cancelled.
func (a *Agent) Run(ctx context.Context) error {
	for {
		err := a.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("disconnected: %v, reconnecting...", err)
		a.backoffSleep(ctx)
	}
}

func (a *Agent) connectAndServe(ctx context.Context) error {
	u, err := url.Parse(a.serverURL)
	if err != nil {
		return fmt.Errorf("parse server URL: %w", err)
	}

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()

	// Register with the server.
	if err := a.sendEnvelope(&protocol.Envelope{
		Type: protocol.TypeRegister,
		Register: &protocol.Register{
			AgentID: a.id,
			Name:    a.name,
			WorkDir: a.workdir,
		},
	}); err != nil {
		return fmt.Errorf("register: %w", err)
	}

	log.Printf("connected and registered as %s (%s)", a.name, a.id)

	// Read commands.
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var env protocol.Envelope
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("parse error: %v", err)
			continue
		}

		switch env.Type {
		case protocol.TypeCommand:
			if env.Command != nil {
				go a.handleCommand(ctx, env.Command)
			}
		default:
			log.Printf("unknown message type: %s", env.Type)
		}
	}
}

func (a *Agent) handleCommand(ctx context.Context, cmd *protocol.Command) {
	a.mu.Lock()
	if a.busy {
		a.mu.Unlock()
		a.sendEnvelope(&protocol.Envelope{
			Type: protocol.TypeError,
			Error: &protocol.Error{
				AgentID: a.id,
				Message: "agent is busy",
			},
		})
		return
	}
	a.busy = true
	a.mu.Unlock()

	// Notify busy.
	a.sendEnvelope(&protocol.Envelope{
		Type: protocol.TypeStatusChange,
		StatusChange: &protocol.StatusChange{
			AgentID: a.id,
			Status:  protocol.StatusBusy,
		},
	})

	// Run claude.
	err := a.commander.Run(ctx, cmd.Prompt, a.workdir, func(line []byte) {
		raw := json.RawMessage(make([]byte, len(line)))
		copy(raw, line)
		a.sendEnvelope(&protocol.Envelope{
			Type: protocol.TypeProgress,
			Progress: &protocol.Progress{
				CommandID: cmd.CommandID,
				AgentID:   a.id,
				Line:      raw,
			},
		})
	})

	finalStatus := protocol.StatusIdle
	if err != nil {
		log.Printf("claude error: %v", err)
		finalStatus = protocol.StatusError
		a.sendEnvelope(&protocol.Envelope{
			Type: protocol.TypeError,
			Error: &protocol.Error{
				AgentID: a.id,
				Message: fmt.Sprintf("claude error: %v", err),
			},
		})
	}

	// Send final progress marker.
	a.sendEnvelope(&protocol.Envelope{
		Type: protocol.TypeProgress,
		Progress: &protocol.Progress{
			CommandID: cmd.CommandID,
			AgentID:   a.id,
			IsFinal:   true,
		},
	})

	// Update status.
	a.mu.Lock()
	a.busy = false
	a.mu.Unlock()

	a.sendEnvelope(&protocol.Envelope{
		Type: protocol.TypeStatusChange,
		StatusChange: &protocol.StatusChange{
			AgentID: a.id,
			Status:  finalStatus,
		},
	})
}

func (a *Agent) sendEnvelope(env *protocol.Envelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn == nil {
		return fmt.Errorf("not connected")
	}
	return a.conn.WriteMessage(websocket.TextMessage, data)
}

func (a *Agent) backoffSleep(ctx context.Context) {
	base := 1 * time.Second
	max := 30 * time.Second
	delay := base

	// Simple exponential backoff with jitter.
	jitter := time.Duration(rand.Int63n(int64(delay / 2)))
	delay = delay + jitter
	if delay > max {
		delay = max
	}

	select {
	case <-time.After(delay):
	case <-ctx.Done():
	}
}
