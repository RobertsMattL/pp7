const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  cloneAndStartAgent: (config) => ipcRenderer.invoke('clone-and-start-agent', config),
  getAgents: () => ipcRenderer.invoke('get-agents'),
  sendPromptToAgent: (data) => ipcRenderer.invoke('send-prompt-to-agent', data),

  // Listeners for events from main process
  onAgentOutput: (callback) => {
    ipcRenderer.on('agent-output', (event, data) => callback(data));
  },
  onShowAgentConfigDialog: (callback) => {
    ipcRenderer.on('show-agent-config-dialog', () => callback());
  },

  // Cleanup
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
