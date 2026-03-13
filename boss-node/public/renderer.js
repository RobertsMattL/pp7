// Debug: verify highlight.js loaded
console.log('highlight.js available:', typeof hljs !== 'undefined', typeof hljs !== 'undefined' ? hljs.listLanguages().length + ' languages' : 'N/A');

// WebSocket connection state
let ws = null;
let isConnected = false;
const agents = new Map(); // agentId -> { name, status, output, currentPrompt, deviceSerial }
const WS_URL = 'ws://localhost:8080/ws/boss';

// ADB device state
let adbDevices = []; // Array of { serial, state, model, product }
let devicePollInterval = null;

// Typewriter system: per-agent queue of text chunks to animate
const typewriterQueues = new Map(); // agentId -> { queue: [], typing: bool, lineEl: null, cursorEl: null }

// Code block tracking (post-process based — see highlightCodeBlocks)

// Device assignments persisted by agent name (since agent IDs change between sessions)
let deviceAssignments = {}; // { agentName: deviceSerial }

// Tab and terminal state
let activeTab = 'agents'; // 'agents' or agentId
const agentTerminals = new Map(); // terminalId -> { terminal: Terminal, fitAddon: FitAddon, created: bool, resizeObserver }
const agentSubtabs = new Map(); // agentId -> { active: string (subtabId), tabs: [{id, name, path}] }

// UI Elements
const mainContent = document.getElementById('main-content');
const noAgentsView = document.getElementById('no-agents');
const connectionStatus = document.getElementById('connection-status');
const agentCountEl = document.getElementById('agent-count');
const dialog = document.getElementById('agent-config-dialog');
const githubUrlInput = document.getElementById('github-url');
const agentNameInput = document.getElementById('agent-name');
const tabBar = document.getElementById('tab-bar');
const terminalContainer = document.getElementById('terminal-container');

// Initialize
async function init() {
  // Load cached device assignments
  const cached = await window.electronAPI.loadConsoles();
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
    deviceAssignments = cached;
  } else if (Array.isArray(cached)) {
    // Migrate old format: extract device assignments by name
    cached.forEach(c => {
      if (c.name && c.deviceSerial) {
        deviceAssignments[c.name] = c.deviceSerial;
      }
    });
    persistDeviceAssignments();
  }

  // Start polling for ADB devices
  await pollAdbDevices();
  devicePollInterval = setInterval(pollAdbDevices, 3000);

  // Poll git status every 10 seconds
  setInterval(refreshGlobalGitInfo, 10000);

  // Connect WebSocket
  connectWebSocket();
}

// ADB Device Polling
async function pollAdbDevices() {
  try {
    adbDevices = await window.electronAPI.getAdbDevices();
    updateAllAgentDeviceUI();
  } catch (err) {
    console.error('Failed to poll ADB devices:', err);
  }
}

function isDeviceOnline(serial) {
  if (!serial) return false;
  const device = adbDevices.find(d => d.serial === serial);
  return device && device.state === 'device';
}

function updateAllAgentDeviceUI() {
  for (const [agentId, agent] of agents) {
    if (agent.isTemp) continue;
    updateDeviceStatus(agentId);
    updateDeviceDropdown(agentId);
    updatePlayButton(agentId);
  }
}

function updateDeviceStatus(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  const consoleDiv = document.getElementById(`console-${agentId}`);
  if (!consoleDiv) return;

  const statusDot = consoleDiv.querySelector('.device-status-dot');
  const serialSpan = consoleDiv.querySelector('.device-serial-text');
  if (!statusDot || !serialSpan) return;

  const serial = agent.deviceSerial;
  if (serial) {
    const online = isDeviceOnline(serial);
    statusDot.className = `device-status-dot ${online ? 'online' : 'offline'}`;
    statusDot.title = online ? 'Device online' : 'Device offline';
    serialSpan.textContent = serial;
    serialSpan.className = `device-serial-text ${online ? 'online' : 'offline'}`;
  } else {
    statusDot.className = 'device-status-dot no-device';
    statusDot.title = 'No device assigned';
    serialSpan.textContent = 'No device';
    serialSpan.className = 'device-serial-text no-device';
  }
}

function updateDeviceDropdown(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  const select = document.getElementById(`device-select-${agentId}`);
  if (!select) return;

  const currentSerial = agent.deviceSerial;

  select.innerHTML = '<option value="">-- Select Device --</option>';

  adbDevices.forEach(device => {
    const option = document.createElement('option');
    option.value = device.serial;
    const stateLabel = device.state === 'device' ? '' : ` (${device.state})`;
    option.textContent = `${device.model} [${device.serial}]${stateLabel}`;
    if (device.serial === currentSerial) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  // If the current serial is set but not in the list, add it as disconnected
  if (currentSerial && !adbDevices.find(d => d.serial === currentSerial)) {
    const option = document.createElement('option');
    option.value = currentSerial;
    option.textContent = `${currentSerial} (disconnected)`;
    option.selected = true;
    select.appendChild(option);
  }
}

function updatePlayButton(agentId) {
  const agent = agents.get(agentId);
  const playBtn = document.getElementById(`play-${agentId}`);
  if (!playBtn || !agent) return;

  const hasDevice = agent.deviceSerial && isDeviceOnline(agent.deviceSerial);
  const hasRepoPath = !!agent.repoPath;
  playBtn.disabled = !(hasDevice && hasRepoPath);
}

function persistDeviceAssignments() {
  window.electronAPI.saveConsoles(deviceAssignments);
}

async function handlePlay(agentId) {
  const agent = agents.get(agentId);
  if (!agent || !agent.deviceSerial || !agent.repoPath) return;

  const playBtn = document.getElementById(`play-${agentId}`);
  if (playBtn) {
    playBtn.disabled = true;
    playBtn.classList.add('building');
  }

  appendToConsole(agentId, 'Starting build...', 'system');

  try {
    await window.electronAPI.buildAndLaunch({
      consoleId: agentId,
      deviceSerial: agent.deviceSerial,
      projectPath: agent.repoPath,
    });
  } catch (err) {
    appendToConsole(agentId, `Build error: ${err.message}`, 'error');
  }

  if (playBtn) {
    playBtn.classList.remove('building');
    updatePlayButton(agentId);
  }
}

// Listen for build output from main process
window.electronAPI.onBuildOutput((data) => {
  const { consoleId, output, type } = data;
  appendToConsole(consoleId, output, type);
});

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
      removeAgentTab(agentId);
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

      // Restore cached device assignment by agent name
      const cachedSerial = deviceAssignments[agentInfo.name] || null;

      if (tempAgent) {
        // Migrate temp agent to real agent
        console.log(`Migrating temp agent ${tempAgent.id} to real agent ${agentInfo.agent_id}`);

        // Get the output from the temp console
        const tempOutputDiv = document.getElementById(`output-${tempAgent.id}`);
        const tempOutput = tempOutputDiv ? Array.from(tempOutputDiv.children) : [];

        // Get repoPath from temp agent
        const repoPath = tempAgent.agent.repoPath || null;

        // Remove temp console
        removeAgentConsole(tempAgent.id);
        agents.delete(tempAgent.id);

        // Create new agent with device info
        agents.set(agentInfo.agent_id, {
          id: agentInfo.agent_id,
          name: agentInfo.name,
          status: agentInfo.status,
          output: [],
          currentPrompt: '',
          deviceSerial: cachedSerial,
          repoPath: repoPath,
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
          deviceSerial: cachedSerial,
          repoPath: agentInfo.workdir || null,
        });
        createAgentConsole(agentInfo.agent_id);
      }
    } else {
      // Update existing agent
      const agent = agents.get(agentInfo.agent_id);
      if (!agent.isTemp) {
        agent.name = agentInfo.name;
        agent.status = agentInfo.status;
        if (agentInfo.workdir && !agent.repoPath) {
          agent.repoPath = agentInfo.workdir;
        }
        updateAgentConsoleHeader(agentInfo.agent_id);
      }
    }
  });

  // Update count
  const realAgentCount = Array.from(agents.values()).filter(a => !a.isTemp).length;
  agentCountEl.textContent = `${realAgentCount} Agent${realAgentCount !== 1 ? 's' : ''}`;

  // Show/hide no agents view
  if (agents.size === 0) {
    noAgentsView.style.display = 'flex';
  } else {
    noAgentsView.style.display = 'none';
  }

  // Refresh global git info whenever agent list changes
  refreshGlobalGitInfo();
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
    // Auto-build if enabled
    const agent = agents.get(agent_id);
    if (agent && agent.autoBuild && agent.deviceSerial && agent.repoPath) {
      appendToConsole(agent_id, '[auto-build] Triggering build...', 'system');
      handlePlay(agent_id);
    }
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
          parts.push(shortenFilePaths(block.text));
        }
        break;
      case 'tool_use':
        const toolName = block.name || 'unknown';
        const input = block.input || {};
        const inputParts = Object.entries(input)
          .map(([k, v]) => {
            let val = shortenFilePaths(String(v));
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
      return { text: shortenFilePaths(delta.text || ''), type: 'default' };
    case 'thinking_delta':
      return { text: `[thinking] ${shortenFilePaths(delta.text || '')}`, type: 'default' };
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

function shortenFilePaths(text) {
  // Pattern to match file paths with /repos/{agentName}/
  // Matches paths like: /Users/.../parallelagents-boss-node/repos/a2/app/...
  const reposPattern = /([^\s]*\/repos\/([^\/\s]+)\/[^\s]*)/g;

  return text.replace(reposPattern, (match, fullPath, agentName) => {
    // Extract everything after /repos/
    const afterRepos = fullPath.substring(fullPath.indexOf('/repos/') + 7);
    return afterRepos;
  });
}

function parseUserMessage(obj) {
  const content = obj.message?.content || [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const isError = block.is_error || false;
      let resultContent = block.content || '';

      // Shorten file paths
      resultContent = shortenFilePaths(resultContent);

      // Don't truncate - show full output
      if (isError) {
        return { text: `[tool_result] ERROR: ${resultContent}`, type: 'tool_result' };
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
  const isTemp = agent.isTemp;

  consoleDiv.innerHTML = `
    <div class="console-header">
      <div class="console-title">
        <span class="console-name">${escapeHtml(agent.name)}</span>
        <span class="console-status ${agent.status}">${agent.status.toUpperCase()}</span>
        ${!isTemp ? `
          <span class="device-status-dot no-device" title="No device assigned"></span>
          <span class="device-serial-text no-device">No device</span>
        ` : ''}
      </div>
      ${!isTemp ? `
        <div class="console-actions">
          <button class="play-btn" id="play-${agentId}" title="Build & Launch" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
          <button class="close-agent-btn" id="close-${agentId}" title="Close Agent">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      ` : ''}
    </div>
    ${!isTemp ? `
      <div class="device-assignment">
        <label>Device:</label>
        <select id="device-select-${agentId}" class="device-select">
          <option value="">-- Select Device --</option>
        </select>
        <button class="refresh-btn" title="Refresh devices">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <label class="auto-build-toggle">
          <input type="checkbox" id="auto-build-${agentId}" class="auto-build-checkbox">
          <span class="auto-build-label">Auto Build</span>
        </label>
      </div>
    ` : ''}
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

  // Set up device UI for non-temp agents
  if (!isTemp) {
    // Populate device dropdown
    updateDeviceDropdown(agentId);
    updateDeviceStatus(agentId);
    updatePlayButton(agentId);

    // Device selection change
    const select = document.getElementById(`device-select-${agentId}`);
    select.addEventListener('change', () => {
      agent.deviceSerial = select.value || null;
      // Persist by agent name
      if (agent.deviceSerial) {
        deviceAssignments[agent.name] = agent.deviceSerial;
      } else {
        delete deviceAssignments[agent.name];
      }
      persistDeviceAssignments();
      updateDeviceStatus(agentId);
      updatePlayButton(agentId);
    });

    // Refresh button
    consoleDiv.querySelector('.refresh-btn').addEventListener('click', () => {
      pollAdbDevices();
    });

    // Play button
    const playBtn = document.getElementById(`play-${agentId}`);
    playBtn.addEventListener('click', () => {
      handlePlay(agentId);
    });

    // Close button
    const closeBtn = document.getElementById(`close-${agentId}`);
    closeBtn.addEventListener('click', () => {
      closeAgent(agentId);
    });

    // Auto-build checkbox
    const autoBuildCb = document.getElementById(`auto-build-${agentId}`);
    autoBuildCb.addEventListener('change', () => {
      agent.autoBuild = autoBuildCb.checked;
    });
  }

  // Add tab for this agent (non-temp only)
  if (!isTemp) {
    addAgentTab(agentId, agent.name);
  }

  // Set up code highlighting observer for this console
  setupHighlightObserver(agentId);

  // Refresh global git status panel
  refreshGlobalGitInfo();
}

async function refreshGlobalGitInfo() {
  const panel = document.getElementById('git-status-panel');
  if (!panel) return;

  // Collect all non-temp agents with repo paths
  const agentEntries = [];
  for (const [agentId, agent] of agents) {
    if (!agent.isTemp && agent.repoPath) {
      agentEntries.push({ agentId, agent });
    }
  }

  if (agentEntries.length === 0) {
    panel.innerHTML = '';
    panel.classList.remove('visible');
    return;
  }

  // Fetch git info for all agents in parallel
  const results = await Promise.all(
    agentEntries.map(async ({ agentId, agent }) => {
      try {
        const info = await window.electronAPI.getGitInfo(agent.repoPath);
        return { agentId, name: agent.name, info, repoPath: agent.repoPath };
      } catch {
        return { agentId, name: agent.name, info: null, repoPath: agent.repoPath };
      }
    })
  );

  const validResults = results.filter(r => r.info);
  if (validResults.length === 0) {
    panel.innerHTML = '';
    panel.classList.remove('visible');
    return;
  }

  // Determine if all agents share the same commit hash and are clean
  const allSameHash = validResults.every(r => r.info.hash === validResults[0].info.hash);
  const allClean = validResults.every(r => !r.info.dirty);
  const allGreen = allSameHash && allClean;

  // Build rows with per-agent push/pull buttons
  const rows = validResults.map(({ agentId, name, info }) => {
    const hashClass = allGreen ? 'git-hash synced' : (info.dirty ? 'git-hash dirty' : 'git-hash');
    const dirtyBadge = info.dirty
      ? `<span class="git-dirty">${info.changedFiles} change${info.changedFiles !== 1 ? 's' : ''}</span>`
      : '';
    return `<div class="git-status-row">
      <span class="git-agent-name">${escapeHtml(name)}</span>
      <span class="git-branch">${escapeHtml(info.branch)}</span>
      <span class="${hashClass}">${escapeHtml(info.hash)}</span>
      ${dirtyBadge}
      <span class="git-message">${escapeHtml(info.message)}</span>
      <div class="git-sync-btns">
        <button class="git-btn git-push-btn" data-agent-id="${agentId}" title="Push changes to remote">Push</button>
        <button class="git-btn git-pull-btn" data-agent-id="${agentId}" title="Pull changes from remote">Pull</button>
      </div>
    </div>`;
  }).join('');

  // Sync All bar
  const syncBar = validResults.length > 1
    ? `<div class="git-sync-bar">
        <button class="git-btn git-sync-all-btn" id="sync-all-btn" title="Push all then pull all">Sync All</button>
      </div>`
    : '';

  panel.innerHTML = rows + syncBar;
  panel.classList.add('visible');

  // Attach per-agent push/pull handlers
  panel.querySelectorAll('.git-push-btn').forEach(btn => {
    btn.addEventListener('click', () => handleGitPush(btn.dataset.agentId));
  });
  panel.querySelectorAll('.git-pull-btn').forEach(btn => {
    btn.addEventListener('click', () => handleGitPull(btn.dataset.agentId));
  });

  // Sync All handler
  const syncAllBtn = document.getElementById('sync-all-btn');
  if (syncAllBtn) {
    syncAllBtn.addEventListener('click', handleSyncAll);
  }
}

async function handleGitPush(agentId) {
  const agent = agents.get(agentId);
  if (!agent || !agent.repoPath) return;

  const btn = document.querySelector(`.git-push-btn[data-agent-id="${agentId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const result = await window.electronAPI.gitPush({ repoPath: agent.repoPath });
    if (result.success) {
      appendToConsole(agentId, `[git] Push successful`, 'system');
    } else {
      appendToConsole(agentId, `[git] Push failed: ${result.error}`, 'error');
    }
  } catch (err) {
    appendToConsole(agentId, `[git] Push error: ${err.message}`, 'error');
  }

  refreshGlobalGitInfo();
}

async function handleGitPull(agentId) {
  const agent = agents.get(agentId);
  if (!agent || !agent.repoPath) return;

  const btn = document.querySelector(`.git-pull-btn[data-agent-id="${agentId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const result = await window.electronAPI.gitPull({ repoPath: agent.repoPath });
    if (result.success) {
      appendToConsole(agentId, `[git] Pull successful: ${result.output.trim()}`, 'system');
    } else {
      appendToConsole(agentId, `[git] Pull failed: ${result.error}`, 'error');
    }
  } catch (err) {
    appendToConsole(agentId, `[git] Pull error: ${err.message}`, 'error');
  }

  refreshGlobalGitInfo();
}

async function handleSyncAll() {
  const syncBtn = document.getElementById('sync-all-btn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = 'Syncing...'; }

  // Collect agents with repo paths
  const syncAgents = [];
  for (const [agentId, agent] of agents) {
    if (!agent.isTemp && agent.repoPath) {
      syncAgents.push({ agentId, agent });
    }
  }

  // Phase 1: Commit and push all agents
  for (const { agentId, agent } of syncAgents) {
    try {
      const result = await window.electronAPI.gitPush({ repoPath: agent.repoPath });
      if (result.success) {
        appendToConsole(agentId, `[sync] Committed & pushed`, 'system');
      } else {
        appendToConsole(agentId, `[sync] Push failed: ${result.error}`, 'error');
      }
    } catch (err) {
      appendToConsole(agentId, `[sync] Push error: ${err.message}`, 'error');
    }
  }

  // Phase 2: Pull all agents
  for (const { agentId, agent } of syncAgents) {
    try {
      const result = await window.electronAPI.gitPull({ repoPath: agent.repoPath });
      if (result.success) {
        appendToConsole(agentId, `[sync] Pulled: ${result.output.trim()}`, 'system');
      } else {
        appendToConsole(agentId, `[sync] Pull failed: ${result.error}`, 'error');
      }
    } catch (err) {
      appendToConsole(agentId, `[sync] Pull error: ${err.message}`, 'error');
    }
  }

  refreshGlobalGitInfo();
}

async function closeAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Kill the agent process via main process (pass both ID and name)
  try {
    await window.electronAPI.stopAgent({ agentId, agentName: agent.name });
  } catch (err) {
    console.error('Failed to stop agent process:', err);
  }

  // Clean up all terminals for this agent
  const subtabs = agentSubtabs.get(agentId);
  if (subtabs) {
    subtabs.tabs.forEach(tab => {
      const terminalId = `${agentId}-${tab.id}`;
      const termState = agentTerminals.get(terminalId);
      if (termState) {
        if (termState.resizeObserver) {
          termState.resizeObserver.disconnect();
        }
        agentTerminals.delete(terminalId);
      }
    });
    agentSubtabs.delete(agentId);
  }

  // Clean up typewriter state
  flushTypewriter(agentId);
  typewriterQueues.delete(agentId);

  // Clean up highlight observer
  const obs = highlightObservers.get(agentId);
  if (obs) { obs.disconnect(); highlightObservers.delete(agentId); }
  highlightTimers.delete(agentId);

  // Remove tab and terminal
  removeAgentTab(agentId);

  // Remove from UI and state
  removeAgentConsole(agentId);
  agents.delete(agentId);

  // Update count
  const realAgentCount = Array.from(agents.values()).filter(a => !a.isTemp).length;
  agentCountEl.textContent = `${realAgentCount} Agent${realAgentCount !== 1 ? 's' : ''}`;

  // Show empty state if needed
  if (agents.size === 0) {
    noAgentsView.style.display = 'flex';
  }

  // Refresh git panel
  refreshGlobalGitInfo();
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
  updateAgentTabName(agentId, agent.name);
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
      deviceSerial: null,
      repoPath: null,
    };
    agents.set(agentId, agent);
    noAgentsView.style.display = 'none';
    createAgentConsole(agentId);
    agentCountEl.textContent = `${agents.size} Agent${agents.size !== 1 ? 's' : ''}`;
  }

  if (!agent) return;

  const outputDiv = document.getElementById(`output-${agentId}`);
  if (!outputDiv) return;

  // Use typewriter animation for Claude's text output (default type from assistant/deltas)
  if (type === 'default' && text && !agent.isTemp) {
    enqueueTypewriter(agentId, outputDiv, text);
    return;
  }

  // Flush any pending typewriter text before appending a non-default line
  flushTypewriter(agentId);

  // Instant append for non-default types (system, error, tool, user, etc.)
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  line.textContent = text;

  outputDiv.appendChild(line);
  outputDiv.scrollTop = outputDiv.scrollHeight;

  // Keep only last 1000 lines
  while (outputDiv.children.length > 1000) {
    outputDiv.removeChild(outputDiv.firstChild);
  }
}

// --- Typewriter Animation System ---
function getTypewriterState(agentId) {
  if (!typewriterQueues.has(agentId)) {
    typewriterQueues.set(agentId, {
      queue: [],
      typing: false,
      lineEl: null,
      cursorEl: null,
    });
  }
  return typewriterQueues.get(agentId);
}

function enqueueTypewriter(agentId, outputDiv, text) {
  const state = getTypewriterState(agentId);
  state.queue.push({ outputDiv, text });

  if (!state.typing) {
    processTypewriterQueue(agentId);
  }
}

function processTypewriterQueue(agentId) {
  const state = getTypewriterState(agentId);
  if (state.queue.length === 0) {
    state.typing = false;
    // Remove cursor when done
    if (state.cursorEl && state.cursorEl.parentNode) {
      state.cursorEl.remove();
    }
    // Remove typing class from line
    if (state.lineEl) {
      state.lineEl.classList.remove('typing');
    }
    // Post-process: highlight any code blocks in the output
    scheduleHighlight(agentId);
    state.lineEl = null;
    state.cursorEl = null;
    return;
  }

  state.typing = true;
  const { outputDiv, text } = state.queue.shift();

  // If we don't have an active line, create one
  if (!state.lineEl) {
    state.lineEl = document.createElement('div');
    state.lineEl.className = 'console-line default typing';
    outputDiv.appendChild(state.lineEl);

    state.cursorEl = document.createElement('span');
    state.cursorEl.className = 'typewriter-cursor';
    state.lineEl.appendChild(state.cursorEl);
  }

  // Check if text contains newlines — if so, we need to handle line breaks
  const chars = [...text];
  let charIndex = 0;

  // Determine typing speed based on queue backlog (speed up if lots queued)
  const baseSpeed = 12;
  const speedMultiplier = Math.max(1, Math.min(state.queue.length, 10));
  const charsPerTick = Math.ceil(speedMultiplier);

  function typeNext() {
    if (charIndex >= chars.length) {
      // Done with this chunk, process next in queue
      processTypewriterQueue(agentId);
      return;
    }

    // Type multiple chars per tick if backlog exists
    let charsToAdd = '';
    for (let i = 0; i < charsPerTick && charIndex < chars.length; i++, charIndex++) {
      const char = chars[charIndex];
      if (char === '\n') {
        // Finish current line, start a new one
        if (charsToAdd && state.lineEl) {
          const textNode = document.createTextNode(charsToAdd);
          if (state.cursorEl && state.cursorEl.parentNode === state.lineEl) {
            state.lineEl.insertBefore(textNode, state.cursorEl);
          } else {
            state.lineEl.appendChild(textNode);
          }
          charsToAdd = '';
        }

        // Remove cursor and typing class from current line
        const completedLine = state.lineEl;
        if (completedLine) {
          completedLine.classList.remove('typing');
        }
        if (state.cursorEl && state.cursorEl.parentNode) {
          state.cursorEl.remove();
        }

        // Create new line for next text
        state.lineEl = document.createElement('div');
        state.lineEl.className = 'console-line default typing';
        outputDiv.appendChild(state.lineEl);
        if (state.cursorEl) {
          state.lineEl.appendChild(state.cursorEl);
        }

        // Trim lines
        while (outputDiv.children.length > 1000) {
          outputDiv.removeChild(outputDiv.firstChild);
        }
      } else {
        charsToAdd += char;
      }
    }

    // Insert accumulated text before cursor
    if (charsToAdd && state.lineEl) {
      const textNode = document.createTextNode(charsToAdd);
      if (state.cursorEl && state.cursorEl.parentNode === state.lineEl) {
        state.lineEl.insertBefore(textNode, state.cursorEl);
      } else {
        state.lineEl.appendChild(textNode);
      }
    }

    // Auto-scroll
    outputDiv.scrollTop = outputDiv.scrollHeight;

    // Schedule next tick
    const speed = Math.max(2, baseSpeed / speedMultiplier);
    setTimeout(typeNext, speed);
  }

  typeNext();
}

// Flush typewriter instantly (e.g., when a non-default line interrupts)
function flushTypewriter(agentId) {
  const state = getTypewriterState(agentId);
  if (!state.typing && state.queue.length === 0) return;

  // Instantly render all queued text
  for (const { outputDiv, text } of state.queue) {
    if (!state.lineEl) {
      state.lineEl = document.createElement('div');
      state.lineEl.className = 'console-line default';
      outputDiv.appendChild(state.lineEl);
    }

    const lines = text.split('\n');
    lines.forEach((lineText, i) => {
      if (i > 0) {
        state.lineEl = document.createElement('div');
        state.lineEl.className = 'console-line default';
        outputDiv.appendChild(state.lineEl);
      }
      if (lineText) {
        state.lineEl.appendChild(document.createTextNode(lineText));
      }
    });
  }

  state.queue = [];
  state.typing = false;
  if (state.cursorEl && state.cursorEl.parentNode) {
    state.cursorEl.remove();
  }
  if (state.lineEl) {
    state.lineEl.classList.remove('typing');
  }
  state.lineEl = null;
  state.cursorEl = null;

  // Post-process: highlight any code blocks
  scheduleHighlight(agentId);
}

// --- Code Block Detection and Highlighting ---
const highlightObservers = new Map(); // agentId -> MutationObserver
const highlightTimers = new Map(); // agentId -> debounce timer

function setupHighlightObserver(agentId) {
  if (highlightObservers.has(agentId)) return;

  const outputDiv = document.getElementById(`output-${agentId}`);
  if (!outputDiv) return;

  const observer = new MutationObserver(() => {
    // Debounce: wait 500ms after last DOM change before highlighting
    if (highlightTimers.has(agentId)) {
      clearTimeout(highlightTimers.get(agentId));
    }
    highlightTimers.set(agentId, setTimeout(() => {
      highlightTimers.delete(agentId);
      highlightCodeBlocks(outputDiv);
    }, 500));
  });

  observer.observe(outputDiv, { childList: true, subtree: true, characterData: true });
  highlightObservers.set(agentId, observer);
  console.log(`[hljs] Observer set up for agent ${agentId}`);
}

function scheduleHighlight(agentId) {
  // Also trigger highlight directly (backup for flush/queue-empty)
  if (highlightTimers.has(agentId)) {
    clearTimeout(highlightTimers.get(agentId));
  }
  highlightTimers.set(agentId, setTimeout(() => {
    highlightTimers.delete(agentId);
    const outputDiv = document.getElementById(`output-${agentId}`);
    if (outputDiv) {
      highlightCodeBlocks(outputDiv);
    }
  }, 500));
}

function highlightCodeBlocks(outputDiv) {
  if (typeof hljs === 'undefined') {
    console.warn('[hljs] highlight.js not loaded!');
    return;
  }

  const children = Array.from(outputDiv.children);
  let i = 0;
  let replacements = 0;

  while (i < children.length) {
    const el = children[i];

    // Skip non-console-line elements (already processed code blocks, etc.)
    if (!el.classList || !el.classList.contains('console-line')) {
      i++;
      continue;
    }

    // Skip already processed
    if (el.dataset.hljsDone) {
      i++;
      continue;
    }

    // Skip lines still being typed
    if (el.classList.contains('typing')) {
      i++;
      continue;
    }

    const text = (el.textContent || '').trim();

    // Look for opening ``` (with optional language)
    const startMatch = text.match(/^```(\w*)$/);
    if (startMatch) {
      const language = startMatch[1] || '';
      const codeLines = [];
      const toHide = [el];

      // Look ahead for closing ```
      let j = i + 1;
      let found = false;
      while (j < children.length) {
        const child = children[j];
        if (!child.classList || !child.classList.contains('console-line')) {
          j++;
          continue;
        }
        // Skip lines still being typed
        if (child.classList.contains('typing')) break;

        const childText = (child.textContent || '').trim();
        if (childText.match(/^```$/)) {
          toHide.push(child);
          found = true;
          break;
        }
        codeLines.push(child.textContent || '');
        toHide.push(child);
        j++;
      }

      if (found && codeLines.length > 0) {
        // Build highlighted code block
        const container = document.createElement('div');
        container.className = 'code-block-container';
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        if (language) {
          codeEl.className = `language-${language}`;
        }
        codeEl.textContent = codeLines.join('\n');
        pre.appendChild(codeEl);
        container.appendChild(pre);

        try {
          hljs.highlightElement(codeEl);
        } catch (e) {
          console.warn('[hljs] highlightElement error:', e);
        }

        // Insert before the opening marker, then hide all raw lines
        el.parentNode.insertBefore(container, el);
        toHide.forEach(h => { h.style.display = 'none'; h.dataset.hljsDone = '1'; });
        replacements++;

        i = j + 1;
        continue;
      }

      // Opening ``` found but no closing yet — skip, will retry
      i++;
      continue;
    }

    // Inline code: `code` backtick patterns
    if (text.includes('`') && !text.startsWith('```')) {
      const original = el.textContent;
      const html = original.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
      if (html !== original) {
        el.innerHTML = html;
      }
    }

    el.dataset.hljsDone = '1';
    i++;
  }

  if (replacements > 0) {
    console.log(`[hljs] Highlighted ${replacements} code block(s)`);
  }
}


function sendPrompt(agentId) {
  const input = document.getElementById(`input-${agentId}`);
  if (!input) return;

  const prompt = input.value.trim();
  if (!prompt) return;

  const agent = agents.get(agentId);
  if (!agent) return;

  // Update pinned prompt and track start time
  agent.currentPrompt = prompt;
  agent.promptStartTime = new Date();
  const pinnedPromptDiv = document.getElementById(`prompt-${agentId}`);
  if (pinnedPromptDiv) {
    const startTimeStr = agent.promptStartTime.toLocaleTimeString();
    pinnedPromptDiv.textContent = `"${prompt}" (started ${startTimeStr})`;
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
  div.textContent = text || '';
  return div.innerHTML;
}

function showAgentDialog() {
  dialog.style.display = 'flex';
  githubUrlInput.focus();
}

function hideAgentDialog() {
  dialog.style.display = 'none';
  githubUrlInput.value = '';
  agentNameInput.value = '';
}

// Dialog handlers
window.electronAPI.onShowAgentConfigDialog(() => {
  showAgentDialog();
});

// "+ Agent" button opens the same dialog
document.getElementById('add-agent-btn').addEventListener('click', () => {
  showAgentDialog();
});

document.getElementById('close-dialog').addEventListener('click', hideAgentDialog);
document.getElementById('cancel-dialog').addEventListener('click', hideAgentDialog);

document.getElementById('create-agent').addEventListener('click', async () => {
  const githubUrl = githubUrlInput.value.trim();
  const agentName = agentNameInput.value.trim();

  if (!githubUrl) {
    alert('Please enter a Git repository URL');
    return;
  }

  // Basic URL validation - accept HTTP(S) and SSH formats
  const isHttpUrl = githubUrl.startsWith('http://') || githubUrl.startsWith('https://');
  const isSshUrl = githubUrl.startsWith('git@') || githubUrl.startsWith('ssh://');

  if (!isHttpUrl && !isSshUrl) {
    alert('Please enter a valid Git repository URL\n\nSupported formats:\n• https://github.com/user/repo.git\n• git@github.com:user/repo.git\n• ssh://git@github.com/user/repo.git');
    return;
  }

  // Close dialog
  hideAgentDialog();

  try {
    // Call main process to clone repo
    const result = await window.electronAPI.cloneAndStartAgent({
      githubUrl,
      agentName,
    });

    console.log('Agent created:', result);

    // If duplicate name or other error with no temp agent created
    if (result.error && !result.agentId) {
      alert(result.error);
      return;
    }

    // Update the temp agent's name and repoPath
    const tempAgentId = result.agentId;
    const tempAgent = agents.get(tempAgentId);
    if (tempAgent) {
      tempAgent.name = result.agentName;
      tempAgent.repoPath = result.repoPath;
      updateAgentConsoleHeader(tempAgentId);
    }

    // If clone failed, don't proceed further
    if (result.error) {
      console.error('Clone failed:', result.error);
      return;
    }

  } catch (error) {
    console.error('Failed to create agent:', error);
    alert(`Failed to create agent: ${error.message}`);
  }
});

// Listen for agent output from main process
window.electronAPI.onAgentOutput((data) => {
  const { agentId, output, type } = data;

  // If type is 'default', the output is likely Claude's stream-json format
  // Parse it to extract the actual content
  if (type === 'default') {
    const parsedLine = parseProgressLine(output);
    if (parsedLine.text) {
      appendToConsole(agentId, parsedLine.text, parsedLine.type);
    }
  } else {
    // For other types (system, error, git, etc.), append directly
    appendToConsole(agentId, output, type);
  }
});

// --- Project Management ---

// Listen for new project command
window.electronAPI.onNewProject(async () => {
  const confirm = window.confirm('Create a new project? This will close all current agents.');
  if (!confirm) return;

  try {
    const result = await window.electronAPI.newProject();
    if (result.success) {
      // Clear all agents from UI
      for (const [agentId] of agents) {
        removeAgentTab(agentId);
        removeAgentConsole(agentId);
      }
      agents.clear();
      agentCountEl.textContent = '0 Agents';
      noAgentsView.style.display = 'flex';

      console.log('New project created:', result.projectPath);
      alert(`New project created: ${result.projectName}`);
    }
  } catch (err) {
    console.error('Failed to create new project:', err);
    alert(`Failed to create project: ${err.message}`);
  }
});

// Listen for open project command
window.electronAPI.onOpenProject(async () => {
  try {
    const result = await window.electronAPI.openProject();
    if (result.success) {
      // Clear all agents from UI
      for (const [agentId] of agents) {
        removeAgentTab(agentId);
        removeAgentConsole(agentId);
      }
      agents.clear();

      console.log('Project opened:', result.projectPath);
      console.log('Agents in project:', result.agents);

      // Restore agents from project
      if (result.agents && result.agents.length > 0) {
        // Create temp consoles for each agent
        for (const agentConfig of result.agents) {
          const tempAgentId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

          // Create a temp agent
          const agent = {
            id: tempAgentId,
            name: agentConfig.name,
            status: 'idle',
            output: [],
            currentPrompt: '',
            isTemp: true,  // Mark as temp so they can be migrated when real agent connects
            deviceSerial: null,
            repoPath: agentConfig.repoPath,
          };
          agents.set(tempAgentId, agent);
          createAgentConsole(tempAgentId);

          // Start the agent process
          appendToConsole(tempAgentId, `Restoring agent "${agentConfig.name}"...`, 'system');
        }

        agentCountEl.textContent = `${result.agents.length} Agent${result.agents.length !== 1 ? 's' : ''}`;
        noAgentsView.style.display = 'none';
      } else {
        agentCountEl.textContent = '0 Agents';
        noAgentsView.style.display = 'flex';
      }

      // Reconnect to trigger agent restoration via main process
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        connectWebSocket();
      }, 500);
    } else if (!result.canceled) {
      alert(`Failed to open project: ${result.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('Failed to open project:', err);
    alert(`Failed to open project: ${err.message}`);
  }
});

// Listen for save project as command
window.electronAPI.onSaveProjectAs(async () => {
  try {
    const result = await window.electronAPI.saveProjectAs();
    if (result.success) {
      console.log('Project saved as:', result.projectPath);
      alert(`Project saved as: ${result.projectName}`);
    }
  } catch (err) {
    console.error('Failed to save project:', err);
    alert(`Failed to save project: ${err.message}`);
  }
});

// --- Tab System ---
function switchTab(tabId) {
  activeTab = tabId;

  // Update tab button styles
  tabBar.querySelectorAll('.tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  if (tabId === 'agents') {
    // Show All Agents view
    mainContent.style.display = 'flex';
    terminalContainer.style.display = 'none';
    // Hide all terminal views
    terminalContainer.querySelectorAll('.terminal-view').forEach(tv => {
      tv.style.display = 'none';
    });
  } else {
    // Show a specific agent's terminal
    mainContent.style.display = 'none';
    terminalContainer.style.display = 'flex';

    // Hide all terminal views, show the selected one
    terminalContainer.querySelectorAll('.terminal-view').forEach(tv => {
      tv.style.display = 'none';
    });

    const termView = document.getElementById(`terminal-view-${tabId}`);
    if (termView) {
      termView.style.display = 'flex';
      // Create terminal if not yet created
      ensureTerminal(tabId);
    }
  }
}

async function addAgentTab(agentId, agentName) {
  console.log(`addAgentTab called for ${agentId} (${agentName})`);

  // Don't add duplicate tabs
  if (tabBar.querySelector(`[data-tab="${agentId}"]`)) {
    console.log(`Tab already exists for ${agentId}, skipping`);
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.tab = agentId;
  btn.textContent = agentName;
  btn.addEventListener('click', () => switchTab(agentId));
  tabBar.appendChild(btn);

  // Create terminal view container with nested structure
  const termView = document.createElement('div');
  termView.className = 'terminal-view';
  termView.id = `terminal-view-${agentId}`;
  termView.style.display = 'none';

  // Create subtab bar
  const subtabBar = document.createElement('div');
  subtabBar.className = 'subtab-bar';
  subtabBar.id = `subtab-bar-${agentId}`;

  // Create terminal content area
  const termContent = document.createElement('div');
  termContent.className = 'terminal-content';
  termContent.id = `terminal-content-${agentId}`;

  termView.appendChild(subtabBar);
  termView.appendChild(termContent);
  terminalContainer.appendChild(termView);

  console.log(`About to initialize subtabs for ${agentId}`);

  // Initialize subtabs for this agent
  await initializeAgentSubtabs(agentId);

  console.log(`Finished initializing subtabs for ${agentId}`);
}

function removeAgentTab(agentId) {
  const btn = tabBar.querySelector(`[data-tab="${agentId}"]`);
  if (btn) btn.remove();

  const termView = document.getElementById(`terminal-view-${agentId}`);
  if (termView) termView.remove();

  // Destroy terminal
  const termState = agentTerminals.get(agentId);
  if (termState) {
    termState.terminal.dispose();
    window.electronAPI.destroyTerminal(agentId);
    agentTerminals.delete(agentId);
  }

  // If we were viewing this tab, switch back to agents
  if (activeTab === agentId) {
    switchTab('agents');
  }
}

function updateAgentTabName(agentId, name) {
  const btn = tabBar.querySelector(`[data-tab="${agentId}"]`);
  if (btn) btn.textContent = name;
}

async function initializeAgentSubtabs(agentId) {
  const agent = agents.get(agentId);
  console.log(`initializeAgentSubtabs for ${agentId}:`, { agent, repoPath: agent?.repoPath });

  if (!agent || !agent.repoPath) {
    console.warn(`Cannot initialize subtabs for ${agentId}: no agent or repoPath`);
    return;
  }

  const subtabBar = document.getElementById(`subtab-bar-${agentId}`);
  const termContent = document.getElementById(`terminal-content-${agentId}`);
  if (!subtabBar || !termContent) {
    console.warn(`Cannot initialize subtabs for ${agentId}: missing DOM elements`);
    return;
  }

  // Get submodules from the repository
  console.log(`Fetching submodules for ${agent.repoPath}`);
  const submodules = await window.electronAPI.getGitSubmodules(agent.repoPath);
  console.log(`Found ${submodules.length} submodules:`, submodules);

  // Build subtab list: parent directory first, then submodules
  const tabs = [
    { id: 'parent', name: 'Parent', path: agent.repoPath }
  ];

  submodules.forEach(sub => {
    if (sub.initialized) {
      console.log(`Adding submodule tab: ${sub.name}`);
      tabs.push({
        id: `submodule-${sub.name}`,
        name: sub.name,
        path: sub.fullPath
      });
    } else {
      console.log(`Skipping uninitialized submodule: ${sub.name}`);
    }
  });

  // Store subtab state
  agentSubtabs.set(agentId, {
    active: 'parent',
    tabs: tabs
  });

  // Create subtab buttons
  tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = `subtab ${tab.id === 'parent' ? 'active' : ''}`;
    btn.dataset.subtab = tab.id;
    btn.textContent = tab.name;
    btn.addEventListener('click', () => switchSubtab(agentId, tab.id));
    subtabBar.appendChild(btn);

    // Create terminal pane for this subtab
    const pane = document.createElement('div');
    pane.className = `terminal-pane ${tab.id === 'parent' ? 'active' : ''}`;
    pane.id = `terminal-pane-${agentId}-${tab.id}`;
    termContent.appendChild(pane);
  });

  // Initialize the active subtab's terminal
  if (tabs.length > 0) {
    await ensureTerminal(agentId, 'parent');
  }
}

function switchSubtab(agentId, subtabId) {
  const subtabs = agentSubtabs.get(agentId);
  if (!subtabs) return;

  // Update active state
  subtabs.active = subtabId;

  // Update UI
  const subtabBar = document.getElementById(`subtab-bar-${agentId}`);
  const termContent = document.getElementById(`terminal-content-${agentId}`);
  if (!subtabBar || !termContent) return;

  // Update subtab buttons
  subtabBar.querySelectorAll('.subtab').forEach(btn => {
    if (btn.dataset.subtab === subtabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update terminal panes
  termContent.querySelectorAll('.terminal-pane').forEach(pane => {
    if (pane.id === `terminal-pane-${agentId}-${subtabId}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  // Ensure terminal is created for this subtab
  ensureTerminal(agentId, subtabId);
}

async function ensureTerminal(agentId, subtabId = 'parent') {
  const terminalId = `${agentId}-${subtabId}`;
  const termState = agentTerminals.get(terminalId);

  if (termState && termState.created) {
    // Just re-fit
    setTimeout(() => termState.fitAddon.fit(), 50);
    return;
  }

  const agent = agents.get(agentId);
  const subtabs = agentSubtabs.get(agentId);
  if (!agent || !subtabs) return;

  // Find the tab info for this subtab
  const tabInfo = subtabs.tabs.find(t => t.id === subtabId);
  if (!tabInfo) return;

  const paneEl = document.getElementById(`terminal-pane-${agentId}-${subtabId}`);
  if (!paneEl) return;

  const terminal = new Terminal({
    theme: {
      background: '#0d0d0d',
      foreground: '#e0e0e0',
      cursor: '#10b981',
      cursorAccent: '#0d0d0d',
      selectionBackground: 'rgba(16, 185, 129, 0.3)',
      black: '#1a1a1a',
      red: '#ef4444',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#3b82f6',
      magenta: '#a78bfa',
      cyan: '#06b6d4',
      white: '#e0e0e0',
      brightBlack: '#707070',
      brightRed: '#f87171',
      brightGreen: '#34d399',
      brightYellow: '#fbbf24',
      brightBlue: '#60a5fa',
      brightMagenta: '#c4b5fd',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff',
    },
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'bar',
  });

  const FitAddonClass = window.FitAddon?.FitAddon || window.FitAddon;
  const fitAddon = new FitAddonClass();
  terminal.loadAddon(fitAddon);

  terminal.open(paneEl);
  fitAddon.fit();

  // Send initial size to PTY with lazygit command
  await window.electronAPI.createTerminal({
    agentId: terminalId,
    cwd: tabInfo.path,
    cols: terminal.cols,
    rows: terminal.rows,
    command: 'lazygit'
  });

  // Forward user input to PTY
  terminal.onData((data) => {
    window.electronAPI.writeTerminal({ agentId: terminalId, data });
  });

  // Handle resize
  terminal.onResize(({ cols, rows }) => {
    window.electronAPI.resizeTerminal({ agentId: terminalId, cols, rows });
  });

  // Fit on window resize
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
  });
  resizeObserver.observe(paneEl);

  agentTerminals.set(terminalId, { terminal, fitAddon, created: true, resizeObserver });
}

// Listen for PTY output
window.electronAPI.onTerminalData(({ agentId, data }) => {
  const termState = agentTerminals.get(agentId);
  if (termState) {
    termState.terminal.write(data);
  }
});

// Listen for PTY exit
window.electronAPI.onTerminalExit(({ agentId, exitCode }) => {
  const termState = agentTerminals.get(agentId);
  if (termState) {
    termState.terminal.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
  }
});

// Set up the "All Agents" tab click handler
document.querySelector('[data-tab="agents"]').addEventListener('click', () => {
  switchTab('agents');
});

// Initialize
init();
