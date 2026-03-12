// WebSocket connection state
let ws = null;
let isConnected = false;
const agents = new Map(); // agentId -> { name, status, output, currentPrompt }
const WS_URL = 'ws://localhost:8080/ws/boss';

// UI Elements
const mainContent = document.getElementById('main-content');
const noAgentsView = document.getElementById('no-agents');
const connectionStatus = document.getElementById('connection-status');
const agentCountEl = document.getElementById('agent-count');
const dialog = document.getElementById('agent-config-dialog');
const githubUrlInput = document.getElementById('github-url');
const agentNameInput = document.getElementById('agent-name');

// WebSocket Connection
function connectWebSocket() {
  console.log('Connecting to WebSocket:', WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connected');
    isConnected = true;
    updateConnectionStatus();
  };

  ws.onmessage = (event) => {
    try {
      const envelope = JSON.parse(event.data);
      console.log('Received message:', envelope);

      switch (envelope.type) {
        case 'agent_list':
          if (envelope.agent_list && envelope.agent_list.agents) {
            handleAgentList(envelope.agent_list.agents);
          }
          break;

        case 'status_change':
          if (envelope.status_change) {
            updateAgentStatus(
              envelope.status_change.agent_id,
              envelope.status_change.status
            );
          }
          break;

        case 'progress':
          if (envelope.progress) {
            handleProgressMessage(envelope.progress);
          }
          break;

        case 'error':
          console.error('Server error:', envelope.error);
          if (envelope.error.agent_id) {
            appendToConsole(envelope.error.agent_id, `[ERROR] ${envelope.error.message}`, 'error');
          }
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
    isConnected = false;
    updateConnectionStatus();

    // Attempt to reconnect after 3 seconds
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      connectWebSocket();
    }, 3000);
  };
}

function updateConnectionStatus() {
  if (isConnected) {
    connectionStatus.classList.add('connected');
    connectionStatus.querySelector('.status-text').textContent = 'Connected';
  } else {
    connectionStatus.classList.remove('connected');
    connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
  }
}

function handleAgentList(agentList) {
  console.log('Agent list:', agentList);

  // Track which agents are still active
  const activeAgentIds = new Set(agentList.map(a => a.agent_id));

  // Remove agents that are no longer in the list (but keep temp agents)
  for (const [agentId, agent] of agents) {
    if (!activeAgentIds.has(agentId) && !agent.isTemp) {
      removeAgentConsole(agentId);
      agents.delete(agentId);
    }
  }

  // Add or update agents
  agentList.forEach(agentInfo => {
    if (!agents.has(agentInfo.agent_id)) {
      // Check if there's a temp agent with matching name that we should migrate
      let tempAgent = null;
      for (const [tempId, agent] of agents) {
        if (agent.isTemp && agent.name === agentInfo.name) {
          tempAgent = { id: tempId, agent };
          break;
        }
      }

      if (tempAgent) {
        // Migrate temp agent to real agent
        console.log(`Migrating temp agent ${tempAgent.id} to real agent ${agentInfo.agent_id}`);

        // Get the output from the temp console
        const tempOutputDiv = document.getElementById(`output-${tempAgent.id}`);
        const tempOutput = tempOutputDiv ? Array.from(tempOutputDiv.children) : [];

        // Remove temp console
        removeAgentConsole(tempAgent.id);
        agents.delete(tempAgent.id);

        // Create new agent
        agents.set(agentInfo.agent_id, {
          id: agentInfo.agent_id,
          name: agentInfo.name,
          status: agentInfo.status,
          output: [],
          currentPrompt: '',
        });
        createAgentConsole(agentInfo.agent_id);

        // Migrate output
        const newOutputDiv = document.getElementById(`output-${agentInfo.agent_id}`);
        if (newOutputDiv) {
          tempOutput.forEach(line => {
            newOutputDiv.appendChild(line.cloneNode(true));
          });
          newOutputDiv.scrollTop = newOutputDiv.scrollHeight;
        }
      } else {
        // New agent (no temp agent to migrate)
        agents.set(agentInfo.agent_id, {
          id: agentInfo.agent_id,
          name: agentInfo.name,
          status: agentInfo.status,
          output: [],
          currentPrompt: '',
        });
        createAgentConsole(agentInfo.agent_id);
      }
    } else {
      // Update existing agent
      const agent = agents.get(agentInfo.agent_id);
      if (!agent.isTemp) {
        agent.name = agentInfo.name;
        agent.status = agentInfo.status;
        updateAgentConsoleHeader(agentInfo.agent_id);
      }
    }
  });

  // Count non-temp agents
  const realAgentCount = Array.from(agents.values()).filter(a => !a.isTemp).length;
  agentCountEl.textContent = `${realAgentCount} Agent${realAgentCount !== 1 ? 's' : ''}`;

  // Show/hide no agents view
  if (agents.size === 0) {
    noAgentsView.style.display = 'flex';
  } else {
    noAgentsView.style.display = 'none';
  }
}

function updateAgentStatus(agentId, status) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = status;
    updateAgentConsoleHeader(agentId);
  }
}

function handleProgressMessage(progress) {
  const { agent_id, line, is_final } = progress;

  if (is_final) {
    appendToConsole(agent_id, '[DONE]', 'done');
    // Clear pinned prompt after task completes
    // Actually, keep it to show last task - as per Go implementation
  } else {
    const parsedLine = parseProgressLine(line);
    if (parsedLine.text) {
      appendToConsole(agent_id, parsedLine.text, parsedLine.type);
    }
  }
}

function parseProgressLine(rawLine) {
  if (!rawLine) {
    return { text: '', type: 'default' };
  }

  try {
    const obj = typeof rawLine === 'string' ? JSON.parse(rawLine) : rawLine;
    const msgType = obj.type;
    const subtype = obj.subtype;

    switch (msgType) {
      case 'system':
        if (subtype === 'init') {
          return { text: '[system] Claude session started', type: 'system' };
        }
        return { text: `[system] ${subtype}`, type: 'system' };

      case 'assistant':
        return parseAssistantMessage(obj);

      case 'content_block_delta':
        return parseContentBlockDelta(obj);

      case 'content_block_start':
        return parseContentBlockStart(obj);

      case 'result':
        return parseResult(obj);

      case 'user':
        return parseUserMessage(obj);

      case 'error':
        const errorMsg = obj.error?.message || 'An error occurred';
        return { text: `[ERROR] ${errorMsg}`, type: 'error' };

      case 'message_start':
        return { text: '[assistant] Processing...', type: 'system' };

      case 'message_delta':
      case 'message_stop':
      case 'content_block_stop':
      case 'ping':
        return { text: '', type: 'default' };

      default:
        if (msgType) {
          return { text: `[${msgType}]`, type: 'default' };
        }
        return { text: '', type: 'default' };
    }
  } catch (err) {
    return { text: String(rawLine), type: 'default' };
  }
}

function parseAssistantMessage(obj) {
  const content = obj.message?.content || [];
  const parts = [];

  content.forEach(block => {
    const blockType = block.type;
    switch (blockType) {
      case 'text':
        if (block.text) {
          parts.push(block.text);
        }
        break;
      case 'tool_use':
        const toolName = block.name || 'unknown';
        const input = block.input || {};
        const inputParts = Object.entries(input)
          .map(([k, v]) => {
            let val = String(v);
            if (val.length > 60) {
              val = val.substring(0, 57) + '...';
            }
            return `${k}: ${val}`;
          });
        if (inputParts.length > 0) {
          parts.push(`[tool] ${toolName}\n  ${inputParts.join(', ')}`);
        } else {
          parts.push(`[tool] ${toolName}`);
        }
        break;
      case 'thinking':
        parts.push('[thinking]');
        break;
    }
  });

  return { text: parts.join('\n'), type: 'default' };
}

function parseContentBlockDelta(obj) {
  const delta = obj.delta || {};
  const deltaType = delta.type;

  switch (deltaType) {
    case 'text_delta':
      return { text: delta.text || '', type: 'default' };
    case 'thinking_delta':
      return { text: `[thinking] ${delta.text || ''}`, type: 'default' };
    default:
      return { text: '', type: 'default' };
  }
}

function parseContentBlockStart(obj) {
  const cb = obj.content_block || {};
  const cbType = cb.type;

  switch (cbType) {
    case 'tool_use':
      return { text: `[tool] ${cb.name || 'unknown'}`, type: 'tool' };
    case 'thinking':
      return { text: '[thinking started]', type: 'default' };
    default:
      return { text: '', type: 'default' };
  }
}

function parseResult(obj) {
  const isError = obj.is_error || false;
  if (isError) {
    const result = obj.result || 'Command failed';
    return { text: `[error] ${result}`, type: 'error' };
  }
  return { text: '[✓] Command completed successfully', type: 'done' };
}

function parseUserMessage(obj) {
  const content = obj.message?.content || [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const isError = block.is_error || false;
      let resultContent = block.content || '';

      if (isError) {
        if (resultContent.length > 200) {
          resultContent = resultContent.substring(0, 197) + '...';
        }
        return { text: `[tool_result] ERROR: ${resultContent}`, type: 'tool_result' };
      }

      if (resultContent.length > 150) {
        const lines = resultContent.split('\n');
        if (lines.length > 3) {
          resultContent = lines.slice(0, 3).join('\n') + `\n  ... (${lines.length - 3} more lines)`;
        } else if (resultContent.length > 150) {
          resultContent = resultContent.substring(0, 147) + '...';
        }
      }
      return { text: `[tool_result] ${resultContent}`, type: 'tool_result' };
    }
  }
  return { text: '', type: 'default' };
}

function createAgentConsole(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  const consoleDiv = document.createElement('div');
  consoleDiv.className = 'agent-console';
  consoleDiv.id = `console-${agentId}`;

  // Disable input for temp agents
  const isDisabled = agent.isTemp ? 'disabled' : '';
  const placeholder = agent.isTemp
    ? 'Waiting for agent to connect...'
    : 'Type a prompt and press Enter...';

  consoleDiv.innerHTML = `
    <div class="console-header">
      <div class="console-title">
        <span class="console-name">${escapeHtml(agent.name)}</span>
        <span class="console-status ${agent.status}">${agent.status.toUpperCase()}</span>
      </div>
    </div>
    <div class="pinned-prompt hidden" id="prompt-${agentId}"></div>
    <div class="console-output" id="output-${agentId}"></div>
    <div class="console-input-container">
      <input
        type="text"
        class="console-input"
        id="input-${agentId}"
        placeholder="${placeholder}"
        autocomplete="off"
        ${isDisabled}
      >
      <button class="send-btn" onclick="sendPrompt('${agentId}')" ${isDisabled}>Send</button>
    </div>
  `;

  mainContent.appendChild(consoleDiv);

  // Add event listener for Enter key
  const input = document.getElementById(`input-${agentId}`);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !agent.isTemp) {
      sendPrompt(agentId);
    }
  });
}

function removeAgentConsole(agentId) {
  const consoleDiv = document.getElementById(`console-${agentId}`);
  if (consoleDiv) {
    consoleDiv.remove();
  }
}

function updateAgentConsoleHeader(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  const consoleDiv = document.getElementById(`console-${agentId}`);
  if (!consoleDiv) return;

  const nameSpan = consoleDiv.querySelector('.console-name');
  const statusSpan = consoleDiv.querySelector('.console-status');

  if (nameSpan) nameSpan.textContent = agent.name;
  if (statusSpan) {
    statusSpan.textContent = agent.status.toUpperCase();
    statusSpan.className = `console-status ${agent.status}`;
  }
}

function appendToConsole(agentId, text, type = 'default') {
  let agent = agents.get(agentId);

  // If agent doesn't exist and this is a temp agent (git output), create temporary console
  if (!agent && agentId.startsWith('temp-')) {
    agent = {
      id: agentId,
      name: 'Setting up...',
      status: 'idle',
      output: [],
      currentPrompt: '',
      isTemp: true,
    };
    agents.set(agentId, agent);
    noAgentsView.style.display = 'none';
    createAgentConsole(agentId);
    agentCountEl.textContent = `${agents.size} Agent${agents.size !== 1 ? 's' : ''}`;
  }

  if (!agent) return;

  const outputDiv = document.getElementById(`output-${agentId}`);
  if (!outputDiv) return;

  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  line.textContent = text;

  outputDiv.appendChild(line);

  // Auto-scroll to bottom
  outputDiv.scrollTop = outputDiv.scrollHeight;

  // Keep only last 1000 lines
  while (outputDiv.children.length > 1000) {
    outputDiv.removeChild(outputDiv.firstChild);
  }
}

function sendPrompt(agentId) {
  const input = document.getElementById(`input-${agentId}`);
  if (!input) return;

  const prompt = input.value.trim();
  if (!prompt) return;

  const agent = agents.get(agentId);
  if (!agent) return;

  // Update pinned prompt
  agent.currentPrompt = prompt;
  const pinnedPromptDiv = document.getElementById(`prompt-${agentId}`);
  if (pinnedPromptDiv) {
    pinnedPromptDiv.textContent = `"${prompt}"`;
    pinnedPromptDiv.classList.remove('hidden');
  }

  // Add user message to console
  appendToConsole(agentId, `[user] ${prompt}`, 'user');

  // Send command via WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    const command = {
      type: 'command',
      command: {
        command_id: generateUUID(),
        agent_id: agentId,
        prompt: prompt,
      },
    };

    ws.send(JSON.stringify(command));
    console.log('Sent command:', command);
  } else {
    appendToConsole(agentId, '[ERROR] Not connected to server', 'error');
  }

  // Clear input
  input.value = '';
}

// Expose sendPrompt to global scope for button onclick
window.sendPrompt = sendPrompt;

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Dialog handlers
window.electronAPI.onShowAgentConfigDialog(() => {
  dialog.style.display = 'flex';
  githubUrlInput.focus();
});

document.getElementById('close-dialog').addEventListener('click', () => {
  dialog.style.display = 'none';
  githubUrlInput.value = '';
  agentNameInput.value = '';
});

document.getElementById('cancel-dialog').addEventListener('click', () => {
  dialog.style.display = 'none';
  githubUrlInput.value = '';
  agentNameInput.value = '';
});

document.getElementById('create-agent').addEventListener('click', async () => {
  const githubUrl = githubUrlInput.value.trim();
  const agentName = agentNameInput.value.trim();

  if (!githubUrl) {
    alert('Please enter a GitHub repository URL');
    return;
  }

  // Basic URL validation
  if (!githubUrl.startsWith('http://') && !githubUrl.startsWith('https://')) {
    alert('Please enter a valid GitHub URL (must start with http:// or https://)');
    return;
  }

  // Close dialog
  dialog.style.display = 'none';

  try {
    // Call main process to clone repo
    const result = await window.electronAPI.cloneAndStartAgent({
      githubUrl,
      agentName,
    });

    console.log('Agent created:', result);

    // Update the temp agent's name if it exists
    const tempAgentId = result.agentId;
    const tempAgent = agents.get(tempAgentId);
    if (tempAgent) {
      tempAgent.name = result.agentName;
      updateAgentConsoleHeader(tempAgentId);
    }

    // Note: The console was already created when git output started streaming.
    // The real agent console will be created when it connects to the server
    // and appears in the agent_list.

  } catch (error) {
    console.error('Failed to create agent:', error);
    alert(`Failed to create agent: ${error.message}`);
  }

  // Clear inputs
  githubUrlInput.value = '';
  agentNameInput.value = '';
});

// Listen for agent output from main process
window.electronAPI.onAgentOutput((data) => {
  const { agentId, output, type } = data;
  appendToConsole(agentId, output, type);
});

// Initialize WebSocket connection
connectWebSocket();
