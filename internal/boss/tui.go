package boss

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"
	"github.com/matthewroberts/parallelagents/internal/protocol"
)

const maxOutputLines = 100

// splashDuration controls how long the splash screen is shown.
const splashDuration = 2 * time.Second

// splashDoneMsg signals the splash screen timer has elapsed.
type splashDoneMsg struct{}

var splashArt = `
    ____                  ____     __   ___                    __
   / __ \____ __________ / / /__  / /  /   | ____ ____  ____  / /______
  / /_/ / __ '/ ___/ __ '/ / / _ \/ /  / /| |/ __ '/ _ \/ __ \/ __/ ___/
 / ____/ /_/ / /  / /_/ / / /  __/ /  / ___ / /_/ /  __/ / / / /_(__  )
/_/    \__,_/_/   \__,_/_/_/\___/_/  /_/  |_\__, /\___/_/ /_/\__/____/
                                           /____/
`

// agentPanel holds per-agent display state.
type agentPanel struct {
	info   protocol.AgentInfo
	output []string // display lines
}

// Model is the bubbletea model for the boss TUI.
type Model struct {
	ws     *WSClient
	agents []agentPanel // ordered list of agent panels
	sel    int          // selected agent index

	input     textinput.Model
	connected bool
	status    string // status bar text
	width     int
	height    int

	showSplash bool // true while the splash screen is displayed
}

// NewModel creates the initial boss TUI model.
func NewModel(ws *WSClient) Model {
	ti := textinput.New()
	ti.Placeholder = "Type a prompt and press Enter..."
	ti.Focus()
	ti.CharLimit = 4096
	ti.Width = 60

	return Model{
		ws:         ws,
		input:      ti,
		status:     "Connecting...",
		showSplash: true,
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		tea.Tick(splashDuration, func(t time.Time) tea.Msg {
			return splashDoneMsg{}
		}),
	)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case splashDoneMsg:
		m.showSplash = false
		return m, nil

	case tea.KeyMsg:
		// Allow dismissing splash early with any key (except quit).
		if m.showSplash {
			if msg.String() == "ctrl+c" || msg.String() == "esc" {
				return m, tea.Quit
			}
			m.showSplash = false
			return m, nil
		}
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit
		case "tab":
			if len(m.agents) > 0 {
				m.sel = (m.sel + 1) % len(m.agents)
				m.updateInputPrompt()
			}
		case "shift+tab":
			if len(m.agents) > 0 {
				m.sel = (m.sel - 1 + len(m.agents)) % len(m.agents)
				m.updateInputPrompt()
			}
		case "enter":
			prompt := strings.TrimSpace(m.input.Value())
			if prompt != "" && len(m.agents) > 0 && m.sel < len(m.agents) {
				agent := m.agents[m.sel]
				err := m.ws.SendCommand(protocol.Command{
					CommandID: uuid.New().String(),
					AgentID:   agent.info.AgentID,
					Prompt:    prompt,
				})
				if err != nil {
					m.status = fmt.Sprintf("Send error: %v", err)
				} else {
					m.status = fmt.Sprintf("Sent to %s", agent.info.Name)
				}
				m.input.SetValue("")
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.input.Width = m.width - 20

	case ConnectedMsg:
		m.connected = true
		m.status = "Connected"

	case DisconnectMsg:
		m.connected = false
		m.status = fmt.Sprintf("Disconnected: %v", msg.Err)

	case AgentListMsg:
		m.syncAgents(msg.Agents)

	case ProgressMsg:
		m.appendProgress(msg)

	case StatusMsg:
		m.updateAgentStatus(msg.AgentID, msg.Status)

	case ServerErrorMsg:
		m.status = fmt.Sprintf("Error: %s", msg.Message)
		if msg.AgentID != "" {
			for i := range m.agents {
				if m.agents[i].info.AgentID == msg.AgentID {
					m.agents[i].output = append(m.agents[i].output, fmt.Sprintf("[error] %s", msg.Message))
					break
				}
			}
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	cmds = append(cmds, cmd)

	return m, tea.Batch(cmds...)
}

func (m *Model) syncAgents(agents []protocol.AgentInfo) {
	// Build lookup of existing panels by ID.
	existing := make(map[string]*agentPanel)
	for i := range m.agents {
		existing[m.agents[i].info.AgentID] = &m.agents[i]
	}

	newPanels := make([]agentPanel, len(agents))
	for i, info := range agents {
		if ep, ok := existing[info.AgentID]; ok {
			newPanels[i] = *ep
			newPanels[i].info = info
		} else {
			newPanels[i] = agentPanel{info: info}
		}
	}
	m.agents = newPanels

	// Clamp selection.
	if m.sel >= len(m.agents) {
		if len(m.agents) > 0 {
			m.sel = len(m.agents) - 1
		} else {
			m.sel = 0
		}
	}
	m.updateInputPrompt()
}

func (m *Model) appendProgress(p ProgressMsg) {
	for i := range m.agents {
		if m.agents[i].info.AgentID == p.AgentID {
			if p.IsFinal {
				m.agents[i].output = append(m.agents[i].output, "[done]")
			} else {
				line := parseProgressLine(p.Line)
				if line != "" {
					m.agents[i].output = append(m.agents[i].output, line)
					// Trim to max lines.
					if len(m.agents[i].output) > maxOutputLines {
						m.agents[i].output = m.agents[i].output[len(m.agents[i].output)-maxOutputLines:]
					}
				}
			}
			return
		}
	}
}

func (m *Model) updateAgentStatus(agentID, status string) {
	for i := range m.agents {
		if m.agents[i].info.AgentID == agentID {
			m.agents[i].info.Status = status
			return
		}
	}
}

func (m *Model) updateInputPrompt() {
	if len(m.agents) > 0 && m.sel < len(m.agents) {
		m.input.Prompt = fmt.Sprintf("[%s] > ", m.agents[m.sel].info.Name)
	} else {
		m.input.Prompt = "> "
	}
}

// parseProgressLine extracts display text from a claude stream-json line.
func parseProgressLine(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}

	var obj map[string]interface{}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return string(raw)
	}

	msgType, _ := obj["type"].(string)

	switch msgType {
	case "assistant":
		if message, ok := obj["message"].(map[string]interface{}); ok {
			if content, ok := message["content"].([]interface{}); ok {
				for _, c := range content {
					if block, ok := c.(map[string]interface{}); ok {
						if text, ok := block["text"].(string); ok {
							return text
						}
					}
				}
			}
		}
		return ""

	case "content_block_delta":
		if delta, ok := obj["delta"].(map[string]interface{}); ok {
			if text, ok := delta["text"].(string); ok {
				return text
			}
		}
		return ""

	case "content_block_start":
		if cb, ok := obj["content_block"].(map[string]interface{}); ok {
			if cbType, ok := cb["type"].(string); ok && cbType == "tool_use" {
				name, _ := cb["name"].(string)
				return fmt.Sprintf("[tool] %s", name)
			}
		}
		return ""

	case "result":
		return "[result] completed"

	case "message_start", "message_delta", "message_stop",
		"content_block_stop", "ping":
		return ""

	default:
		// For unrecognized types, show a summary.
		if msgType != "" {
			return fmt.Sprintf("[%s]", msgType)
		}
		return ""
	}
}

// Styles.
var (
	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("15")).
			Background(lipgloss.Color("62")).
			Padding(0, 1)

	statusBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240")).
			Padding(0, 1)

	panelBorderIdle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("240")).
			Padding(0, 1)

	panelBorderBusy = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("226")).
			Padding(0, 1)

	panelBorderError = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("196")).
			Padding(0, 1)

	panelBorderSelected = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color("51")).
				Padding(0, 1)

	agentNameStyle = lipgloss.NewStyle().Bold(true)
	statusTagIdle  = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	statusTagBusy  = lipgloss.NewStyle().Foreground(lipgloss.Color("226")).Bold(true)
	statusTagError = lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true)
)

func (m Model) View() string {
	if m.width == 0 {
		return "Loading..."
	}

	if m.showSplash {
		return m.renderSplash()
	}

	var b strings.Builder

	// Header.
	title := fmt.Sprintf(" ParallelAgents Dashboard  [%d agents]", len(m.agents))
	header := headerStyle.Width(m.width).Render(title)
	b.WriteString(header)
	b.WriteString("\n")

	// Agent panels.
	if len(m.agents) == 0 {
		b.WriteString("\n  No agents connected. Start agents to see them here.\n\n")
	} else {
		panels := m.renderPanels()
		b.WriteString(panels)
		b.WriteString("\n")
	}

	// Status bar.
	connStatus := "Disconnected"
	if m.connected {
		connStatus = "Connected"
	}
	statusLine := fmt.Sprintf("Status: %s  |  %s", connStatus, m.status)
	b.WriteString(statusBarStyle.Width(m.width).Render(statusLine))
	b.WriteString("\n")

	// Input area.
	if len(m.agents) > 0 && m.sel < len(m.agents) {
		agentName := m.agents[m.sel].info.Name
		b.WriteString(statusBarStyle.Render(fmt.Sprintf("Agent: [%s]  (Tab to switch)", agentName)))
		b.WriteString("\n")
	}
	b.WriteString(m.input.View())
	b.WriteString("\n")

	return b.String()
}

func (m Model) renderSplash() string {
	logoStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("51")).
		Bold(true)

	subtitleStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("62")).
		Italic(true)

	hintStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240"))

	logo := logoStyle.Render(splashArt)
	subtitle := subtitleStyle.Render("Distributed Claude Agent Orchestration")
	hint := hintStyle.Render("Press any key to continue...")

	block := lipgloss.JoinVertical(lipgloss.Center, logo, "", subtitle, "", hint)

	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, block)
}

func (m Model) renderPanels() string {
	if len(m.agents) == 0 {
		return ""
	}

	// Calculate panel width.
	n := len(m.agents)
	// Account for border (2 chars each side) and padding.
	panelWidth := (m.width / n) - 1
	if panelWidth < 20 {
		panelWidth = 20
	}

	// Reserve height for header(1) + status(1) + input(2) + padding(2).
	panelHeight := m.height - 7
	if panelHeight < 5 {
		panelHeight = 5
	}

	panels := make([]string, n)
	for i, ap := range m.agents {
		panels[i] = m.renderOnePanel(ap, i == m.sel, panelWidth, panelHeight)
	}

	return lipgloss.JoinHorizontal(lipgloss.Top, panels...)
}

func (m Model) renderOnePanel(ap agentPanel, selected bool, width, height int) string {
	// Title line.
	name := agentNameStyle.Render(ap.info.Name)
	tag := renderStatusTag(ap.info.Status)
	title := fmt.Sprintf("%s %s", name, tag)

	// Content lines.
	contentHeight := height - 2 // title + separator
	if contentHeight < 1 {
		contentHeight = 1
	}

	lines := ap.output
	if len(lines) > contentHeight {
		lines = lines[len(lines)-contentHeight:]
	}

	// Truncate lines to fit width.
	contentWidth := width - 4
	if contentWidth < 10 {
		contentWidth = 10
	}
	var displayLines []string
	for _, l := range lines {
		if len(l) > contentWidth {
			l = l[:contentWidth-1] + "~"
		}
		displayLines = append(displayLines, l)
	}

	// Pad to fill height.
	for len(displayLines) < contentHeight {
		displayLines = append(displayLines, "")
	}

	content := title + "\n" + strings.Repeat("─", contentWidth) + "\n" + strings.Join(displayLines, "\n")

	// Pick border style.
	style := panelBorderIdle
	if selected {
		style = panelBorderSelected
	} else {
		switch ap.info.Status {
		case protocol.StatusBusy:
			style = panelBorderBusy
		case protocol.StatusError:
			style = panelBorderError
		}
	}

	return style.Width(width).Height(height).Render(content)
}

func renderStatusTag(status string) string {
	switch status {
	case protocol.StatusBusy:
		return statusTagBusy.Render("[BUSY]")
	case protocol.StatusError:
		return statusTagError.Render("[ERROR]")
	default:
		return statusTagIdle.Render("[IDLE]")
	}
}
