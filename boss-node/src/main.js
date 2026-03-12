const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
const agents = new Map(); // agentId -> { process, repoPath, ... }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Create application menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'New Agent from GitHub',
          click: () => {
            mainWindow.webContents.send('show-agent-config-dialog');
          },
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Cleanup all agent processes
  agents.forEach((agent) => {
    if (agent.process && !agent.process.killed) {
      agent.process.kill();
    }
  });

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('clone-and-start-agent', async (event, config) => {
  const { githubUrl, agentName } = config;

  try {
    // Create repos directory if it doesn't exist
    const reposDir = path.join(app.getPath('userData'), 'repos');
    if (!fs.existsSync(reposDir)) {
      fs.mkdirSync(reposDir, { recursive: true });
    }

    // Generate a unique directory name for this repo
    const timestamp = Date.now();
    const repoName = githubUrl.split('/').pop().replace('.git', '');
    const repoPath = path.join(reposDir, `${repoName}-${timestamp}`);
    const finalAgentName = agentName || repoName;

    // Generate temporary agent ID for git output (will be replaced by actual agent ID from server)
    const tempAgentId = `temp-${timestamp}`;

    // Clone the repository
    const gitClone = spawn('git', ['clone', githubUrl, repoPath]);

    // Send git output to renderer
    gitClone.stdout.on('data', (data) => {
      mainWindow.webContents.send('agent-output', {
        agentId: tempAgentId,
        output: data.toString(),
        type: 'git',
      });
    });

    gitClone.stderr.on('data', (data) => {
      mainWindow.webContents.send('agent-output', {
        agentId: tempAgentId,
        output: data.toString(),
        type: 'git',
      });
    });

    return new Promise((resolve, reject) => {
      gitClone.on('close', (code) => {
        if (code !== 0) {
          mainWindow.webContents.send('agent-output', {
            agentId: tempAgentId,
            output: `\n✗ Git clone failed with code ${code}\n`,
            type: 'error',
          });
          reject(new Error(`Git clone failed with code ${code}`));
          return;
        }

        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `\n✓ Repository cloned successfully to ${repoPath}\n`,
          type: 'system',
        });

        // Start the ParallelAgents agent process in the cloned directory
        const agentBinaryPath = path.join(__dirname, '../../bin/parallelagents-agent');

        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `Starting agent "${finalAgentName}" in ${repoPath}...\n`,
          type: 'system',
        });

        const agentProcess = spawn(agentBinaryPath, [
          '-name', finalAgentName,
          '-workdir', repoPath,
          '-server', 'ws://localhost:8080/ws/agent',
        ], {
          cwd: repoPath,
          env: process.env,
        });

        // Capture agent process output
        agentProcess.stdout.on('data', (data) => {
          console.log(`[Agent ${finalAgentName}] ${data.toString().trim()}`);
        });

        agentProcess.stderr.on('data', (data) => {
          console.error(`[Agent ${finalAgentName}] ${data.toString().trim()}`);
        });

        agentProcess.on('error', (err) => {
          console.error(`Failed to start agent: ${err.message}`);
          mainWindow.webContents.send('agent-output', {
            agentId: tempAgentId,
            output: `\n✗ Failed to start agent: ${err.message}\n`,
            type: 'error',
          });
        });

        agentProcess.on('close', (code) => {
          console.log(`Agent process exited with code ${code}`);
          agents.delete(tempAgentId);
        });

        // Store agent info
        agents.set(tempAgentId, {
          id: tempAgentId,
          name: finalAgentName,
          repoPath,
          githubUrl,
          process: agentProcess,
        });

        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `✓ Agent process started. Connecting to server...\n`,
          type: 'system',
        });

        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `Agent will appear in the UI once connected to the server.\n`,
          type: 'system',
        });

        resolve({ agentId: tempAgentId, repoPath, agentName: finalAgentName });
      });

      gitClone.on('error', (err) => {
        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `\n✗ Git clone error: ${err.message}\n`,
          type: 'error',
        });
        reject(err);
      });
    });
  } catch (error) {
    throw error;
  }
});

ipcMain.handle('get-agents', async () => {
  return Array.from(agents.values()).map(agent => ({
    id: agent.id,
    name: agent.name,
    repoPath: agent.repoPath,
    githubUrl: agent.githubUrl,
  }));
});

ipcMain.handle('send-prompt-to-agent', async (event, { agentId, prompt }) => {
  // This will be handled by the WebSocket connection in the renderer
  // For now, just echo back for testing
  return { success: true, agentId, prompt };
});
