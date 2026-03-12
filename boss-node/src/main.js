const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

let mainWindow;
const agents = new Map(); // agentId -> { process, repoPath, ... }

// Console persistence
const CONSOLES_FILE = () => path.join(app.getPath('userData'), 'consoles.json');

function loadConsoles() {
  try {
    const data = fs.readFileSync(CONSOLES_FILE(), 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveConsoles(consoles) {
  const dir = path.dirname(CONSOLES_FILE());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONSOLES_FILE(), JSON.stringify(consoles, null, 2), 'utf8');
}

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

// ADB helpers
function getAdbPath() {
  // Try common locations and PATH
  const candidates = [
    'adb',
    path.join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb'),
    path.join(process.env.ANDROID_HOME || '', 'platform-tools/adb'),
    path.join(process.env.ANDROID_SDK_ROOT || '', 'platform-tools/adb'),
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" version`, { stdio: 'pipe' });
      return candidate;
    } catch {
      // try next
    }
  }
  return 'adb'; // fallback
}

function parseAdbDevices() {
  const adbPath = getAdbPath();
  try {
    const output = execSync(`"${adbPath}" devices -l`, {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env },
    });

    const devices = [];
    const lines = output.split('\n').slice(1); // skip header
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '') continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;

      const serial = parts[0];
      const state = parts[1]; // device, offline, unauthorized, etc.

      // Parse extra info (model, product, etc.)
      let model = '';
      let product = '';
      for (const part of parts.slice(2)) {
        if (part.startsWith('model:')) model = part.replace('model:', '');
        if (part.startsWith('product:')) product = part.replace('product:', '');
      }

      devices.push({
        serial,
        state, // 'device' means online
        model: model || serial,
        product,
      });
    }
    return devices;
  } catch (err) {
    console.error('Failed to run adb devices:', err.message);
    return [];
  }
}

// IPC: Get connected ADB devices
ipcMain.handle('get-adb-devices', async () => {
  return parseAdbDevices();
});

// IPC: Load cached consoles
ipcMain.handle('load-consoles', async () => {
  return loadConsoles();
});

// IPC: Save consoles
ipcMain.handle('save-consoles', async (event, consoles) => {
  saveConsoles(consoles);
  return true;
});

// IPC: Build and launch Android app on device
ipcMain.handle('build-and-launch', async (event, { consoleId, deviceSerial, projectPath }) => {
  const adbPath = getAdbPath();

  // Notify renderer of build start
  mainWindow.webContents.send('build-output', {
    consoleId,
    output: `Building Android project...\n`,
    type: 'system',
  });

  // Determine build command based on project structure
  let buildCmd, buildArgs, cwd;

  if (fs.existsSync(path.join(projectPath, 'gradlew'))) {
    buildCmd = './gradlew';
    buildArgs = ['installDebug', `-PandroidSerial=${deviceSerial}`];
    cwd = projectPath;
  } else if (fs.existsSync(path.join(projectPath, 'app', 'build.gradle')) ||
             fs.existsSync(path.join(projectPath, 'app', 'build.gradle.kts'))) {
    buildCmd = './gradlew';
    buildArgs = ['installDebug'];
    cwd = projectPath;
  } else {
    // Fallback: try to find gradlew in subdirectories
    const dirs = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let found = false;
    for (const dir of dirs) {
      const gradlew = path.join(projectPath, dir, 'gradlew');
      if (fs.existsSync(gradlew)) {
        buildCmd = './gradlew';
        buildArgs = ['installDebug'];
        cwd = path.join(projectPath, dir);
        found = true;
        break;
      }
    }

    if (!found) {
      mainWindow.webContents.send('build-output', {
        consoleId,
        output: `No Android project (gradlew) found in ${projectPath}\n`,
        type: 'error',
      });
      return { success: false, error: 'No gradlew found' };
    }
  }

  // Set ANDROID_SERIAL so gradle installs to the right device
  const env = { ...process.env, ANDROID_SERIAL: deviceSerial };

  return new Promise((resolve) => {
    mainWindow.webContents.send('build-output', {
      consoleId,
      output: `$ ${buildCmd} ${buildArgs.join(' ')} (ANDROID_SERIAL=${deviceSerial})\n`,
      type: 'system',
    });

    const buildProcess = spawn(buildCmd, buildArgs, { cwd, env, shell: true });

    buildProcess.stdout.on('data', (data) => {
      mainWindow.webContents.send('build-output', {
        consoleId,
        output: data.toString(),
        type: 'default',
      });
    });

    buildProcess.stderr.on('data', (data) => {
      mainWindow.webContents.send('build-output', {
        consoleId,
        output: data.toString(),
        type: 'default',
      });
    });

    buildProcess.on('close', (code) => {
      if (code === 0) {
        mainWindow.webContents.send('build-output', {
          consoleId,
          output: `\nBuild successful! Launching app...\n`,
          type: 'system',
        });

        // Try to find and launch the main activity
        try {
          // Get the package name from the installed APK
          const launchOutput = execSync(
            `"${adbPath}" -s ${deviceSerial} shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER -- $(${adbPath} -s ${deviceSerial} shell pm list packages -3 | tail -1 | cut -d: -f2) | tail -1`,
            { encoding: 'utf8', timeout: 10000, env }
          ).trim();

          if (launchOutput && launchOutput.includes('/')) {
            execSync(
              `"${adbPath}" -s ${deviceSerial} shell am start -n ${launchOutput}`,
              { encoding: 'utf8', timeout: 10000, env }
            );
            mainWindow.webContents.send('build-output', {
              consoleId,
              output: `App launched: ${launchOutput}\n`,
              type: 'system',
            });
          }
        } catch (launchErr) {
          mainWindow.webContents.send('build-output', {
            consoleId,
            output: `Build installed but could not auto-launch: ${launchErr.message}\n`,
            type: 'default',
          });
        }

        resolve({ success: true });
      } else {
        mainWindow.webContents.send('build-output', {
          consoleId,
          output: `\nBuild failed with exit code ${code}\n`,
          type: 'error',
        });
        resolve({ success: false, error: `Build failed with code ${code}` });
      }
    });

    buildProcess.on('error', (err) => {
      mainWindow.webContents.send('build-output', {
        consoleId,
        output: `Build error: ${err.message}\n`,
        type: 'error',
      });
      resolve({ success: false, error: err.message });
    });
  });
});

// IPC: Get git commit info for a repo path
ipcMain.handle('get-git-info', async (event, repoPath) => {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return null;
  }
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    const message = execSync('git log -1 --pretty=%s', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    // Check for uncommitted changes (staged + unstaged + untracked)
    const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    const dirty = status.length > 0;
    const changedFiles = dirty ? status.split('\n').length : 0;
    return { hash, message, branch, dirty, changedFiles };
  } catch {
    return null;
  }
});

// IPC handlers (existing)
ipcMain.handle('clone-and-start-agent', async (event, config) => {
  const { githubUrl, agentName } = config;

  try {
    const repoName = githubUrl.split('/').pop().replace('.git', '');
    const finalAgentName = agentName || repoName;

    // Check for duplicate agent name among running agents
    for (const [, agent] of agents) {
      if (agent.name === finalAgentName) {
        return { agentId: null, repoPath: agent.repoPath, agentName: finalAgentName, error: `Agent "${finalAgentName}" already exists` };
      }
    }

    // Create repos directory if it doesn't exist
    const reposDir = path.join(app.getPath('userData'), 'repos');
    if (!fs.existsSync(reposDir)) {
      fs.mkdirSync(reposDir, { recursive: true });
    }

    // Use a stable directory name based on repo name (no timestamp)
    const repoPath = path.join(reposDir, repoName);

    const timestamp = Date.now();
    const tempAgentId = `temp-${timestamp}`;

    // Check if repo already exists on disk
    const repoAlreadyExists = fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));

    if (repoAlreadyExists) {
      // Skip cloning, just notify and start the agent
      mainWindow.webContents.send('agent-output', {
        agentId: tempAgentId,
        output: `Repository already exists at ${repoPath} — skipping clone.\n`,
        type: 'system',
      });

      startAgentProcess(tempAgentId, finalAgentName, repoPath, githubUrl);

      return { agentId: tempAgentId, repoPath, agentName: finalAgentName };
    }

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
            output: `\n✗ Git clone failed with code ${code}. Check the URL and try again.\n`,
            type: 'error',
          });
          resolve({ agentId: tempAgentId, repoPath: null, agentName: finalAgentName, error: `Git clone failed with code ${code}` });
          return;
        }

        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `\n✓ Repository cloned successfully to ${repoPath}\n`,
          type: 'system',
        });

        startAgentProcess(tempAgentId, finalAgentName, repoPath, githubUrl);

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

function startAgentProcess(tempAgentId, agentName, repoPath, githubUrl) {
  const agentBinaryPath = path.join(__dirname, '../../bin/parallelagents-agent');

  mainWindow.webContents.send('agent-output', {
    agentId: tempAgentId,
    output: `Starting agent "${agentName}" in ${repoPath}...\n`,
    type: 'system',
  });

  const agentProcess = spawn(agentBinaryPath, [
    '-name', agentName,
    '-workdir', repoPath,
    '-server', 'ws://localhost:8080/ws/agent',
  ], {
    cwd: repoPath,
    env: process.env,
  });

  agentProcess.stdout.on('data', (data) => {
    console.log(`[Agent ${agentName}] ${data.toString().trim()}`);
  });

  agentProcess.stderr.on('data', (data) => {
    console.error(`[Agent ${agentName}] ${data.toString().trim()}`);
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

  agents.set(tempAgentId, {
    id: tempAgentId,
    name: agentName,
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
}

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
