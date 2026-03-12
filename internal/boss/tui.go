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

// typewriterInterval controls how fast characters appear (lower = faster).
const typewriterInterval = 15 * time.Millisecond

// charsPerTick controls how many characters to add per tick (higher = faster).
const charsPerTick = 2

// splashDoneMsg signals the splash screen timer has elapsed.
type splashDoneMsg struct{}

// typewriterTickMsg signals it's time to add more characters to the animation.
type typewriterTickMsg struct{}

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
	output []string // fully displayed lines

	// Pinned prompt at top
	currentPrompt string // the current user prompt (pinned at top during execution)

	// Animation state for typewriter effect
	animBuffer     []string // lines waiting to be animated
	currentLine    string   // line currently being animated
	currentPos     int      // position in current line being displayed
	isAnimating    bool     // true if animation is in progress
	instantDisplay bool     // true for tags like [user], [tool], etc
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
		typewriterTick(),
	)
}

// typewriterTick returns a command that sends typewriter tick messages.
func typewriterTick() tea.Cmd {
	return tea.Tick(typewriterInterval, func(t time.Time) tea.Msg {
		return typewriterTickMsg{}
	})
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case splashDoneMsg:
		m.showSplash = false
		return m, nil

	case typewriterTickMsg:
		// Advance animation for all agents
		anyAnimating := false
		for i := range m.agents {
			if m.advanceAnimation(&m.agents[i]) {
				anyAnimating = true
			}
		}
		// Continue ticking if any agent is animating
		if anyAnimating {
			cmds = append(cmds, typewriterTick())
		}

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

				// Pin the prompt at the top of the pane during execution
				m.agents[m.sel].currentPrompt = fmt.Sprintf("[user] %s", prompt)

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
		// Restart ticker if any agent is animating
		for i := range m.agents {
			if m.agents[i].isAnimating {
				cmds = append(cmds, typewriterTick())
				break
			}
		}

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
				// Task completed - keep the prompt in title to show last task
				m.addLineToAgent(&m.agents[i], "[done]", true)
			} else {
				line := parseProgressLine(p.Line)
				if line != "" {
					// Determine if this should be instant or animated
					instant := shouldDisplayInstantly(line)
					m.addLineToAgent(&m.agents[i], line, instant)
				}
			}
			return
		}
	}
}

// shouldDisplayInstantly returns true for tags and system messages that should appear immediately.
func shouldDisplayInstantly(line string) bool {
	// Tags and system messages appear instantly
	instantPrefixes := []string{"[user]", "[tool]", "[tool_result]", "[system]", "[error]", "[ERROR]", "[✓]", "[done]"}
	for _, prefix := range instantPrefixes {
		if strings.HasPrefix(line, prefix) {
			return true
		}
	}
	return false
}

// addLineToAgent adds a line to an agent's display, either instantly or to the animation buffer.
func (m *Model) addLineToAgent(ap *agentPanel, line string, instant bool) {
	if instant {
		// Add directly to output
		ap.output = append(ap.output, line)
		// Trim to max lines
		if len(ap.output) > maxOutputLines {
			ap.output = ap.output[len(ap.output)-maxOutputLines:]
		}
	} else {
		// Add to animation buffer
		ap.animBuffer = append(ap.animBuffer, line)
		if !ap.isAnimating {
			ap.isAnimating = true
			// Start next line
			if len(ap.animBuffer) > 0 {
				ap.currentLine = ap.animBuffer[0]
				ap.animBuffer = ap.animBuffer[1:]
				ap.currentPos = 0
			}
		}
	}
}

// advanceAnimation advances the typewriter animation for an agent.
// Returns true if the agent is still animating.
func (m *Model) advanceAnimation(ap *agentPanel) bool {
	if !ap.isAnimating {
		return false
	}

	// If no current line, check if there's more in the buffer
	if ap.currentLine == "" {
		if len(ap.animBuffer) > 0 {
			ap.currentLine = ap.animBuffer[0]
			ap.animBuffer = ap.animBuffer[1:]
			ap.currentPos = 0
		} else {
			ap.isAnimating = false
			return false
		}
	}

	// Add characters to the display
	lineLen := len(ap.currentLine)
	if ap.currentPos < lineLen {
		// Add charsPerTick characters (or remaining if less)
		endPos := ap.currentPos + charsPerTick
		if endPos > lineLen {
			endPos = lineLen
		}
		ap.currentPos = endPos

		// If we've completed the line, add it to output
		if ap.currentPos >= lineLen {
			ap.output = append(ap.output, ap.currentLine)
			// Trim to max lines
			if len(ap.output) > maxOutputLines {
				ap.output = ap.output[len(ap.output)-maxOutputLines:]
			}
			ap.currentLine = ""
			ap.currentPos = 0
		}
	}

	// Check if there's more to animate
	return ap.currentLine != "" || len(ap.animBuffer) > 0
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
	subtype, _ := obj["subtype"].(string)

	switch msgType {
	case "system":
		// Show system initialization messages
		if subtype == "init" {
			return "[system] Claude session started"
		}
		return fmt.Sprintf("[system] %s", subtype)

	case "assistant":
		// Parse full assistant message and extract all content
		if message, ok := obj["message"].(map[string]interface{}); ok {
			if content, ok := message["content"].([]interface{}); ok {
				var parts []string
				for _, c := range content {
					if block, ok := c.(map[string]interface{}); ok {
						blockType, _ := block["type"].(string)
						switch blockType {
						case "text":
							if text, ok := block["text"].(string); ok {
								parts = append(parts, text)
							}
						case "tool_use":
							name, _ := block["name"].(string)
							// Extract tool input parameters for display
							if input, ok := block["input"].(map[string]interface{}); ok {
								var inputParts []string
								for k, v := range input {
									// Show key parameters, truncate long values
									val := fmt.Sprintf("%v", v)
									if len(val) > 60 {
										val = val[:57] + "..."
									}
									inputParts = append(inputParts, fmt.Sprintf("%s: %s", k, val))
								}
								if len(inputParts) > 0 {
									parts = append(parts, fmt.Sprintf("[tool] %s\n  %s", name, strings.Join(inputParts, ", ")))
								} else {
									parts = append(parts, fmt.Sprintf("[tool] %s", name))
								}
							} else {
								parts = append(parts, fmt.Sprintf("[tool] %s", name))
							}
						case "thinking":
							parts = append(parts, "[thinking]")
						}
					}
				}
				if len(parts) > 0 {
					return strings.Join(parts, "\n")
				}
			}
		}
		return ""

	case "content_block_delta":
		// Handle streaming text deltas
		if delta, ok := obj["delta"].(map[string]interface{}); ok {
			deltaType, _ := delta["type"].(string)
			switch deltaType {
			case "text_delta":
				if text, ok := delta["text"].(string); ok {
					return text
				}
			case "thinking_delta":
				if text, ok := delta["text"].(string); ok {
					return fmt.Sprintf("[thinking] %s", text)
				}
			}
		}
		return ""

	case "content_block_start":
		// Show when tool use or thinking blocks start
		if cb, ok := obj["content_block"].(map[string]interface{}); ok {
			cbType, _ := cb["type"].(string)
			switch cbType {
			case "tool_use":
				name, _ := cb["name"].(string)
				return fmt.Sprintf("[tool] %s", name)
			case "thinking":
				return "[thinking started]"
			case "text":
				return "" // Text will come in deltas
			}
		}
		return ""

	case "result":
		// Show result status with more detail
		isError, _ := obj["is_error"].(bool)
		if isError {
			if result, ok := obj["result"].(string); ok {
				return fmt.Sprintf("[error] %s", result)
			}
			return "[error] Command failed"
		}
		// Success - show a concise completion message
		if subtype == "success" {
			return "[✓] Command completed successfully"
		}
		return "[✓] completed"

	case "user":
		// Handle tool results coming back from tool execution
		if message, ok := obj["message"].(map[string]interface{}); ok {
			if content, ok := message["content"].([]interface{}); ok {
				for _, c := range content {
					if block, ok := c.(map[string]interface{}); ok {
						if blockType, _ := block["type"].(string); blockType == "tool_result" {
							isError, _ := block["is_error"].(bool)
							resultContent, _ := block["content"].(string)

							if isError {
								// Truncate error output if too long
								if len(resultContent) > 200 {
									resultContent = resultContent[:197] + "..."
								}
								return fmt.Sprintf("[tool_result] ERROR: %s", resultContent)
							}

							// Truncate successful output if too long
							if len(resultContent) > 150 {
								lines := strings.Split(resultContent, "\n")
								if len(lines) > 3 {
									resultContent = strings.Join(lines[:3], "\n") + fmt.Sprintf("\n  ... (%d more lines)", len(lines)-3)
								} else if len(resultContent) > 150 {
									resultContent = resultContent[:147] + "..."
								}
							}
							return fmt.Sprintf("[tool_result] %s", resultContent)
						}
					}
				}
			}
		}
		return ""

	case "error":
		// Show errors clearly
		if msg, ok := obj["error"].(map[string]interface{}); ok {
			if errMsg, ok := msg["message"].(string); ok {
				return fmt.Sprintf("[ERROR] %s", errMsg)
			}
		}
		return "[ERROR] An error occurred"

	case "message_start":
		return "[assistant] Processing..."

	case "message_delta", "message_stop", "content_block_stop", "ping":
		// These are metadata events - don't display
		return ""

	default:
		// For unrecognized types, show a summary only if it might be important
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

	// Reserve height for:
	// - header: 1 line
	// - header newline: 1 line
	// - status bar: 1 line
	// - status newline: 1 line
	// - agent selector: 1 line
	// - selector newline: 1 line
	// - input: 1 line
	// - input newline: 1 line
	// Total overhead: 8 lines
	panelHeight := m.height - 8
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
	// Title line with optional prompt.
	name := agentNameStyle.Render(ap.info.Name)
	tag := renderStatusTag(ap.info.Status)

	// Build title with prompt if active
	var title string
	if ap.currentPrompt != "" {
		// Strip the [user] prefix if present
		prompt := strings.TrimPrefix(ap.currentPrompt, "[user] ")
		// Truncate prompt to fit in title (leave room for name, tag, quotes, and padding)
		maxPromptLen := width - len(ap.info.Name) - 15 // conservative estimate
		if maxPromptLen < 10 {
			maxPromptLen = 10
		}
		if len(prompt) > maxPromptLen {
			prompt = prompt[:maxPromptLen-3] + "..."
		}
		title = fmt.Sprintf("%s %s - \"%s\"", name, tag, prompt)
	} else {
		title = fmt.Sprintf("%s %s", name, tag)
	}

	// Calculate total content height (excluding title + separator)
	totalContentHeight := height - 2 // account for title + separator
	if totalContentHeight < 1 {
		totalContentHeight = 1
	}

	// Truncate lines to fit width
	contentWidth := width - 4
	if contentWidth < 10 {
		contentWidth = 10
	}

	// Build content lines (make a copy to avoid modifying original)
	lines := make([]string, len(ap.output))
	copy(lines, ap.output)

	// Add currently animating partial line (with cursor)
	if ap.isAnimating && ap.currentLine != "" && ap.currentPos > 0 {
		partialLine := ap.currentLine[:ap.currentPos] + "▌"
		lines = append(lines, partialLine)
	}

	// Trim to available height
	if len(lines) > totalContentHeight {
		lines = lines[len(lines)-totalContentHeight:]
	}

	// Build final display lines
	var displayLines []string
	for i := 0; i < len(lines) && i < totalContentHeight; i++ {
		l := lines[i]
		if len(l) > contentWidth {
			l = l[:contentWidth-1] + "~"
		}
		displayLines = append(displayLines, l)
	}

	// Pad to exact totalContentHeight
	for len(displayLines) < totalContentHeight {
		displayLines = append(displayLines, "")
	}

	// Final safety check - hard limit to totalContentHeight
	if len(displayLines) > totalContentHeight {
		displayLines = displayLines[:totalContentHeight]
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

	// Use MaxHeight to enforce a hard limit without expansion
	// This prevents panels from growing beyond allocated space
	return style.Width(width).MaxHeight(height).Render(content)
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
