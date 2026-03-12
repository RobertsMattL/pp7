const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  cloneAndStartAgent: (config) => ipcRenderer.invoke('clone-and-start-agent', config),
  getAgents: () => ipcRenderer.invoke('get-agents'),
  stopAgent: (agentId) => ipcRenderer.invoke('stop-agent', agentId),
  sendPromptToAgent: (data) => ipcRenderer.invoke('send-prompt-to-agent', data),

  // ADB device management
  getAdbDevices: () => ipcRenderer.invoke('get-adb-devices'),

  // Console persistence
  loadConsoles: () => ipcRenderer.invoke('load-consoles'),
  saveConsoles: (consoles) => ipcRenderer.invoke('save-consoles', consoles),

  // Build and launch
  buildAndLaunch: (data) => ipcRenderer.invoke('build-and-launch', data),

  // Git info and sync
  getGitInfo: (repoPath) => ipcRenderer.invoke('get-git-info', repoPath),
  gitPush: (data) => ipcRenderer.invoke('git-push', data),
  gitPull: (data) => ipcRenderer.invoke('git-pull', data),

  // Terminal
  createTerminal: (data) => ipcRenderer.invoke('create-terminal', data),
  writeTerminal: (data) => ipcRenderer.invoke('write-terminal', data),
  resizeTerminal: (data) => ipcRenderer.invoke('resize-terminal', data),
  destroyTerminal: (agentId) => ipcRenderer.invoke('destroy-terminal', agentId),
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (event, data) => callback(data));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on('terminal-exit', (event, data) => callback(data));
  },

  // Listeners for events from main process
  onAgentOutput: (callback) => {
    ipcRenderer.on('agent-output', (event, data) => callback(data));
  },
  onShowAgentConfigDialog: (callback) => {
    ipcRenderer.on('show-agent-config-dialog', () => callback());
  },
  onBuildOutput: (callback) => {
    ipcRenderer.on('build-output', (event, data) => callback(data));
  },

  // Cleanup
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
