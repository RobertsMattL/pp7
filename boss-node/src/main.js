const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const pty = require('node-pty');

let mainWindow;
const agents = new Map(); // agentId -> { process, repoPath, ... }
const terminals = new Map(); // agentId -> pty process
let currentProjectPath = null; // Path to the current project file

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

// App settings persistence
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const data = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
}

function getReposDir() {
  const settings = loadSettings();
  return settings.repoRoot || path.join(app.getPath('userData'), 'repos');
}

function getCurrentProjectName() {
  try {
    if (currentProjectPath && fs.existsSync(currentProjectPath)) {
      const data = fs.readFileSync(currentProjectPath, 'utf8');
      const project = JSON.parse(data);
      return project.name || null;
    }
  } catch (err) {
    console.error('Failed to get project name:', err);
  }
  return null;
}

// Agent config persistence (legacy - for migration)
const AGENTS_FILE = () => path.join(app.getPath('userData'), 'agents.json');
const DEFAULT_PROJECT_PATH = () => path.join(app.getPath('userData'), 'default-project.ppproject');

function loadSavedAgents() {
  // First check if we have a current project loaded
  if (currentProjectPath && fs.existsSync(currentProjectPath)) {
    return loadProjectAgents(currentProjectPath);
  }

  // Try to load default project
  if (fs.existsSync(DEFAULT_PROJECT_PATH())) {
    currentProjectPath = DEFAULT_PROJECT_PATH();
    return loadProjectAgents(currentProjectPath);
  }

  // Migration: Check for old agents.json file
  if (fs.existsSync(AGENTS_FILE())) {
    console.log('Migrating from agents.json to project format...');
    const agents = migrateFromAgentsJson();
    return agents;
  }

  return [];
}

function migrateFromAgentsJson() {
  try {
    const data = fs.readFileSync(AGENTS_FILE(), 'utf8');
    const agents = JSON.parse(data);

    // Create a default project with these agents
    const project = {
      name: 'Default Project',
      version: '1.0',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      agents: agents
    };

    // Save as default project
    saveProject(DEFAULT_PROJECT_PATH(), project);
    currentProjectPath = DEFAULT_PROJECT_PATH();

    // Rename old agents.json to agents.json.backup
    fs.renameSync(AGENTS_FILE(), AGENTS_FILE() + '.backup');
    console.log('Migration complete. Old agents.json backed up.');

    return agents;
  } catch (err) {
    console.error('Migration failed:', err);
    return [];
  }
}

function loadProjectAgents(projectPath) {
  try {
    const data = fs.readFileSync(projectPath, 'utf8');
    const project = JSON.parse(data);
    return project.agents || [];
  } catch (err) {
    console.error('Failed to load project:', err);
    return [];
  }
}

function saveProject(projectPath, project) {
  const dir = path.dirname(projectPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  project.modified = new Date().toISOString();
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf8');
}

function saveAgentConfig(agentName, repoPath, githubUrl) {
  const saved = loadSavedAgents();
  // Update existing or add new
  const idx = saved.findIndex(a => a.name === agentName);
  const entry = { name: agentName, repoPath, githubUrl };
  if (idx >= 0) {
    saved[idx] = entry;
  } else {
    saved.push(entry);
  }

  // Save to current project
  const projectPath = currentProjectPath || DEFAULT_PROJECT_PATH();
  let project;

  if (fs.existsSync(projectPath)) {
    const data = fs.readFileSync(projectPath, 'utf8');
    project = JSON.parse(data);
  } else {
    project = {
      name: 'Default Project',
      version: '1.0',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      agents: []
    };
  }

  project.agents = saved;
  saveProject(projectPath, project);
  currentProjectPath = projectPath;
}

function removeAgentConfig(agentName) {
  const saved = loadSavedAgents().filter(a => a.name !== agentName);

  // Save to current project
  const projectPath = currentProjectPath || DEFAULT_PROJECT_PATH();
  if (fs.existsSync(projectPath)) {
    const data = fs.readFileSync(projectPath, 'utf8');
    const project = JSON.parse(data);
    project.agents = saved;
    saveProject(projectPath, project);
  }

  console.log(`Removed agent "${agentName}" from project`);
}

function restoreSavedAgents() {
  const saved = loadSavedAgents();
  for (const { name, repoPath, githubUrl } of saved) {
    // Only restore if repo still exists on disk
    if (!repoPath || !fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
      console.log(`Skipping agent "${name}" — repo not found at ${repoPath}`);
      continue;
    }

    // Check if already running
    let alreadyRunning = false;
    for (const [, agent] of agents) {
      if (agent.name === name) {
        alreadyRunning = true;
        break;
      }
    }
    if (alreadyRunning) continue;

    const tempAgentId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`Restoring agent "${name}" from ${repoPath}`);

    // Update submodules in background when restoring (don't block on this)
    const gitSubmodule = spawn('git', ['submodule', 'update', '--init', '--recursive'], {
      cwd: repoPath
    });

    gitSubmodule.on('close', (code) => {
      if (code === 0) {
        console.log(`Submodules updated for "${name}"`);
      } else {
        console.log(`Submodule update for "${name}" completed with code ${code}`);
      }
    });

    gitSubmodule.on('error', (err) => {
      console.error(`Submodule update error for "${name}":`, err.message);
    });

    // Start agent process (don't wait for submodules)
    startAgentProcess(tempAgentId, name, repoPath, githubUrl || '', true);
  }
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

  // Open DevTools in development
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Create application menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.send('new-project');
          },
        },
        {
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('open-project');
          },
        },
        {
          label: 'Save Project As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            mainWindow.webContents.send('save-project-as');
          },
        },
        { type: 'separator' },
        {
          label: 'Add Agent',
          click: () => {
            mainWindow.webContents.send('show-agent-config-dialog');
          },
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow.webContents.send('show-settings');
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

// IPC: Create new project
ipcMain.handle('new-project', async (event, config) => {
  const { projectName, githubUrl } = config || {};

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Create New Project',
    defaultPath: path.join(app.getPath('documents'), `${projectName || 'Untitled'}.ppproject`),
    filters: [
      { name: 'ParallelAgents Project', extensions: ['ppproject'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  const projectPath = result.filePath;
  const finalProjectName = projectName || path.basename(projectPath, '.ppproject');

  const project = {
    name: finalProjectName,
    version: '1.0',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    githubUrl: githubUrl || '',
    agents: []
  };

  saveProject(projectPath, project);
  currentProjectPath = projectPath;

  // Stop all current agents
  for (const [agentId, agent] of agents) {
    if (agent.process && !agent.process.killed) {
      agent.process.kill();
    }
  }
  agents.clear();

  return { success: true, projectPath, projectName };
});

// IPC: Open existing project
ipcMain.handle('open-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    defaultPath: app.getPath('documents'),
    filters: [
      { name: 'ParallelAgents Project', extensions: ['ppproject'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const projectPath = result.filePaths[0];

  try {
    const data = fs.readFileSync(projectPath, 'utf8');
    const project = JSON.parse(data);

    currentProjectPath = projectPath;

    // Stop all current agents
    for (const [agentId, agent] of agents) {
      if (agent.process && !agent.process.killed) {
        agent.process.kill();
      }
    }
    agents.clear();

    // Start agents from the opened project
    restoreSavedAgents();

    return {
      success: true,
      projectPath,
      projectName: project.name,
      githubUrl: project.githubUrl || '',
      agents: project.agents || []
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: Save project as
ipcMain.handle('save-project-as', async () => {
  const currentAgents = loadSavedAgents();

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Project As',
    defaultPath: path.join(app.getPath('documents'), 'Project.ppproject'),
    filters: [
      { name: 'ParallelAgents Project', extensions: ['ppproject'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  const projectPath = result.filePath;
  const projectName = path.basename(projectPath, '.ppproject');

  let project;
  if (currentProjectPath && fs.existsSync(currentProjectPath)) {
    const data = fs.readFileSync(currentProjectPath, 'utf8');
    project = JSON.parse(data);
    project.name = projectName;
  } else {
    project = {
      name: projectName,
      version: '1.0',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      agents: currentAgents
    };
  }

  saveProject(projectPath, project);
  currentProjectPath = projectPath;

  return { success: true, projectPath, projectName };
});

// IPC: Get current project info
ipcMain.handle('get-current-project', async () => {
  if (!currentProjectPath || !fs.existsSync(currentProjectPath)) {
    return { success: false, noProject: true };
  }

  try {
    const data = fs.readFileSync(currentProjectPath, 'utf8');
    const project = JSON.parse(data);
    return {
      success: true,
      projectPath: currentProjectPath,
      projectName: project.name,
      githubUrl: project.githubUrl || '',
      agentCount: project.agents ? project.agents.length : 0
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: Get settings
ipcMain.handle('get-settings', async () => {
  return loadSettings();
});

// IPC: Save settings
ipcMain.handle('save-settings', async (event, settings) => {
  saveSettings(settings);
  return { success: true };
});

// IPC: Browse for folder
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Repo Root Directory',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return { path: result.filePaths[0] };
});

app.whenReady().then(() => {
  createWindow();
  // Restore previously saved agents after window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    restoreSavedAgents();
  });
});

app.on('window-all-closed', () => {
  // Cleanup all agent processes
  agents.forEach((agent) => {
    if (agent.process && !agent.process.killed) {
      agent.process.kill();
    }
  });

  // Cleanup all terminal processes
  terminals.forEach((ptyProcess) => {
    ptyProcess.kill();
  });
  terminals.clear();

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
          // Determine package name from the project's build files
          let packageName = null;

          // Try reading applicationId from build.gradle or build.gradle.kts
          const gradleFiles = [
            path.join(cwd, 'app', 'build.gradle'),
            path.join(cwd, 'app', 'build.gradle.kts'),
            path.join(cwd, 'build.gradle'),
            path.join(cwd, 'build.gradle.kts'),
          ];
          for (const gf of gradleFiles) {
            if (fs.existsSync(gf)) {
              const content = fs.readFileSync(gf, 'utf8');
              // Match applicationId "com.example.app" or applicationId = "com.example.app"
              const match = content.match(/applicationId\s*[=]?\s*["']([^"']+)["']/);
              if (match) {
                packageName = match[1];
                break;
              }
            }
          }

          // Fallback: try AndroidManifest.xml
          if (!packageName) {
            const manifestPaths = [
              path.join(cwd, 'app', 'src', 'main', 'AndroidManifest.xml'),
              path.join(cwd, 'src', 'main', 'AndroidManifest.xml'),
            ];
            for (const mp of manifestPaths) {
              if (fs.existsSync(mp)) {
                const content = fs.readFileSync(mp, 'utf8');
                const match = content.match(/package="([^"]+)"/);
                if (match) {
                  packageName = match[1];
                  break;
                }
              }
            }
          }

          if (packageName) {
            // Resolve the launcher activity for this specific package
            const launchOutput = execSync(
              `"${adbPath}" -s ${deviceSerial} shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${packageName} | tail -1`,
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
            } else {
              // Fallback: monkey launch
              execSync(
                `"${adbPath}" -s ${deviceSerial} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
                { encoding: 'utf8', timeout: 10000, env }
              );
              mainWindow.webContents.send('build-output', {
                consoleId,
                output: `App launched via monkey: ${packageName}\n`,
                type: 'system',
              });
            }
          } else {
            mainWindow.webContents.send('build-output', {
              consoleId,
              output: `Build installed but could not determine package name to auto-launch.\n`,
              type: 'default',
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

// IPC: Get git submodules for a repo
ipcMain.handle('get-git-submodules', async (event, repoPath) => {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return [];
  }
  try {
    // Check if .gitmodules exists
    const gitmodulesPath = path.join(repoPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) {
      return [];
    }

    // Get list of submodules using git submodule status
    const output = execSync('git submodule status', { cwd: repoPath, encoding: 'utf8', timeout: 5000 });
    // Don't trim the output - the leading space/+/- on each line indicates submodule status
    const lines = output.split('\n').filter(line => line.trim());

    const submodules = lines.map(line => {
      // Format: " <commit> <path> (<describe>)" or "-<commit> <path> (<describe>)" if not initialized
      // Don't trim before matching - the leading character indicates status
      const match = line.match(/^[+-\s]([a-f0-9]+)\s+(\S+)(?:\s+\(([^)]+)\))?/);
      if (match) {
        const [, commit, subPath, describe] = match;
        const fullPath = path.join(repoPath, subPath);
        const name = path.basename(subPath);
        return {
          name,
          path: subPath,
          fullPath,
          commit: commit.substring(0, 7),
          initialized: fs.existsSync(path.join(fullPath, '.git'))
        };
      }
      return null;
    }).filter(Boolean);

    return submodules;
  } catch (err) {
    console.error('Failed to get git submodules:', err);
    return [];
  }
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

// IPC: Git push (stage all, commit, push)
ipcMain.handle('git-push', async (event, { repoPath, message }) => {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { success: false, error: 'Invalid repo path' };
  }
  try {
    const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    if (status.length > 0) {
      execSync('git add -A', { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
      const commitMsg = message || `sync: auto-commit ${new Date().toISOString()}`;
      execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    }
    const output = execSync('git push', { cwd: repoPath, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, output: output || 'Pushed successfully' };
  } catch (err) {
    return { success: false, error: err.stderr || err.message };
  }
});

// IPC: Git pull
ipcMain.handle('git-pull', async (event, { repoPath }) => {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { success: false, error: 'Invalid repo path' };
  }
  try {
    const output = execSync('git pull', { cwd: repoPath, encoding: 'utf8', timeout: 30000 });
    return { success: true, output: output || 'Already up to date' };
  } catch (err) {
    return { success: false, error: err.stderr || err.message };
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

    // Create repos directory if it doesn't exist, nested under project name
    const reposDir = getReposDir();
    const projectName = getCurrentProjectName();
    const projectReposDir = projectName ? path.join(reposDir, projectName) : reposDir;
    if (!fs.existsSync(projectReposDir)) {
      fs.mkdirSync(projectReposDir, { recursive: true });
    }

    // Use the agent name as the directory name (falls back to repo name)
    const repoPath = path.join(projectReposDir, finalAgentName);

    const timestamp = Date.now();
    const tempAgentId = `temp-${timestamp}`;

    // Check if repo already exists on disk
    const repoAlreadyExists = fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));

    if (repoAlreadyExists) {
      // Skip cloning, just notify and update submodules
      mainWindow.webContents.send('agent-output', {
        agentId: tempAgentId,
        output: `Repository already exists at ${repoPath} — skipping clone.\n`,
        type: 'system',
      });

      // Update submodules
      mainWindow.webContents.send('agent-output', {
        agentId: tempAgentId,
        output: `Updating git submodules...\n`,
        type: 'system',
      });

      const gitSubmodule = spawn('git', ['submodule', 'update', '--init', '--recursive'], {
        cwd: repoPath
      });

      gitSubmodule.stdout.on('data', (data) => {
        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: data.toString(),
          type: 'git',
        });
      });

      gitSubmodule.stderr.on('data', (data) => {
        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: data.toString(),
          type: 'git',
        });
      });

      gitSubmodule.on('close', (code) => {
        if (code === 0) {
          mainWindow.webContents.send('agent-output', {
            agentId: tempAgentId,
            output: `✓ Submodules updated successfully\n`,
            type: 'system',
          });
        }
        startAgentProcess(tempAgentId, finalAgentName, repoPath, githubUrl);
      });

      gitSubmodule.on('error', (err) => {
        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `⚠ Git submodule error: ${err.message}\n`,
          type: 'system',
        });
        startAgentProcess(tempAgentId, finalAgentName, repoPath, githubUrl);
      });

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

        // Initialize submodules recursively
        mainWindow.webContents.send('agent-output', {
          agentId: tempAgentId,
          output: `Initializing git submodules...\n`,
          type: 'system',
        });

        const gitSubmodule = spawn('git', ['submodule', 'update', '--init', '--recursive'], {
          cwd: repoPath
        });

        gitSubmodule.stdout.on('data', (data) => {
          mainWindow.webContents.send('agent-output', {
            agentId: tempAgentId,
            output: data.toString(),
            type: 'git',
          });
        });

        gitSubmodule.stderr.on('data', (data) => {
          mainWindow.webContents.send('agent-output', {
            agentId: tempAgentId,
            output: data.toString(),
            type: 'git',
          });
        });

        gitSubmodule.on('close', (submoduleCode) => {
          if (submoduleCode === 0) {
            mainWindow.webContents.send('agent-output', {
              agentId: tempAgentId,
              output: `✓ Submodules initialized successfully\n`,
              type: 'system',
            });
          } else {
            mainWindow.webContents.send('agent-output', {
              agentId: tempAgentId,
              output: `⚠ Submodule initialization completed with code ${submoduleCode}\n`,
              type: 'system',
            });
          }

          // Start agent regardless of submodule status
          startAgentProcess(tempAgentId, finalAgentName, repoPath, githubUrl);
          resolve({ agentId: tempAgentId, repoPath, agentName: finalAgentName });
        });

        gitSubmodule.on('error', (err) => {
          mainWindow.webContents.send('agent-output', {
            agentId: tempAgentId,
            output: `⚠ Git submodule error: ${err.message}\n`,
            type: 'system',
          });
          // Start agent anyway even if submodules fail
          startAgentProcess(tempAgentId, finalAgentName, repoPath, githubUrl);
          resolve({ agentId: tempAgentId, repoPath, agentName: finalAgentName });
        });
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

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function startAgentProcess(tempAgentId, agentName, repoPath, githubUrl, silent = false) {
  const agentBinaryPath = path.join(__dirname, '../../bin/parallelagents-agent');

  if (!silent) {
    sendToRenderer('agent-output', {
      agentId: tempAgentId,
      output: `Starting agent "${agentName}" in ${repoPath}...\n`,
      type: 'system',
    });
  }

  const agentProcess = spawn(agentBinaryPath, [
    '-name', agentName,
    '-workdir', repoPath,
    '-server', 'ws://localhost:8080/ws/agent',
  ], {
    cwd: repoPath,
    env: process.env,
  });

  agentProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        console.log(`[Agent ${agentName}] ${trimmed}`);
        // Send each line to renderer for parsing and display
        // The renderer's parseProgressLine will handle the stream-json format
        sendToRenderer('agent-output', {
          agentId: tempAgentId,
          output: trimmed,
          type: 'default',
        });
      }
    }
  });

  agentProcess.stderr.on('data', (data) => {
    const trimmed = data.toString().trim();
    console.error(`[Agent ${agentName}] ${trimmed}`);

    // Filter out internal agent connection/reconnection logs
    const isInternalLog = trimmed.includes('connected and registered as') ||
                          trimmed.includes('disconnected:') ||
                          trimmed.includes('reconnecting...');

    if (trimmed && !isInternalLog) {
      sendToRenderer('agent-output', {
        agentId: tempAgentId,
        output: trimmed,
        type: 'error',
      });
    }
  });

  agentProcess.on('error', (err) => {
    console.error(`Failed to start agent: ${err.message}`);
    sendToRenderer('agent-output', {
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

  // Persist agent config for restart
  saveAgentConfig(agentName, repoPath, githubUrl);

  if (!silent) {
    sendToRenderer('agent-output', {
      agentId: tempAgentId,
      output: `✓ Agent process started. Connecting to server...\n`,
      type: 'system',
    });

    sendToRenderer('agent-output', {
      agentId: tempAgentId,
      output: `Agent will appear in the UI once connected to the server.\n`,
      type: 'system',
    });
  }
}

ipcMain.handle('stop-agent', async (event, params) => {
  // Support both old format (string agentId) and new format (object with agentId and agentName)
  const agentId = typeof params === 'string' ? params : params.agentId;
  const agentName = typeof params === 'object' ? params.agentName : null;

  // First try to find by exact ID (for temp agents)
  let agent = agents.get(agentId);
  let foundKey = agentId;

  // If not found by ID, try to find by name
  if (!agent && agentName) {
    console.log(`Agent with ID ${agentId} not found, searching by name "${agentName}"`);
    for (const [key, a] of agents) {
      if (a.name === agentName) {
        agent = a;
        foundKey = key;
        console.log(`Found agent by name: ${agentName} (key: ${foundKey})`);
        break;
      }
    }
  }

  // If still not found, we can at least remove from config by name
  if (!agent) {
    console.log(`Agent not found in main process (ID: ${agentId}, Name: ${agentName || 'unknown'})`);

    // Clean up terminal if it exists
    if (terminals.has(agentId)) {
      terminals.get(agentId).kill();
      terminals.delete(agentId);
    }

    // If we have the name, remove from config anyway
    if (agentName) {
      console.log(`Removing agent "${agentName}" from config even though process not found`);
      removeAgentConfig(agentName);
      return { success: true, removed: true };
    }

    return { success: false, message: 'Agent not found' };
  }

  console.log(`Stopping agent "${agent.name}" (${foundKey})`);

  // Kill the agent process
  if (agent.process && !agent.process.killed) {
    agent.process.kill();
  }

  // Kill associated terminal for both the temp ID and real ID
  if (terminals.has(foundKey)) {
    terminals.get(foundKey).kill();
    terminals.delete(foundKey);
  }
  if (terminals.has(agentId) && agentId !== foundKey) {
    terminals.get(agentId).kill();
    terminals.delete(agentId);
  }

  // Remove from persistent config so it won't restore on next launch
  removeAgentConfig(agent.name);

  agents.delete(foundKey);
  return { success: true };
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

// IPC: Create a PTY terminal for an agent
ipcMain.handle('create-terminal', async (event, { agentId, cwd, cols, rows, command }) => {
  // Kill existing terminal for this agent if any
  if (terminals.has(agentId)) {
    terminals.get(agentId).kill();
    terminals.delete(agentId);
  }

  try {
    const fs = require('fs');
    const shell = process.env.SHELL || '/bin/zsh';

    // Build a proper environment for the shell
    const env = Object.assign({}, process.env);
    env.TERM = 'xterm-256color';
    if (!env.SHELL) env.SHELL = shell;
    if (!env.HOME) env.HOME = require('os').homedir();
    if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

    // Validate cwd exists, fall back to HOME if it doesn't
    const targetCwd = cwd || env.HOME;
    if (!fs.existsSync(targetCwd)) {
      console.warn(`Terminal cwd does not exist: ${targetCwd}, falling back to HOME`);
      cwd = env.HOME;
    }

    // Validate shell exists
    if (!fs.existsSync(shell)) {
      throw new Error(`Shell not found: ${shell}`);
    }

    console.log(`Creating terminal for agent ${agentId}:`, {
      shell,
      cwd: cwd || env.HOME,
      command: command || 'none',
      hasHOME: !!env.HOME,
      hasPATH: !!env.PATH,
      shellExists: fs.existsSync(shell),
      cwdExists: fs.existsSync(cwd || env.HOME),
      ptyModule: pty.constructor.name,
      ptyPath: require.resolve('node-pty'),
    });

    // Try to spawn with explicit error handling
    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: cwd || env.HOME,
        env: env,
      });
    } catch (spawnError) {
      console.error(`PTY spawn failed:`, {
        error: spawnError.message,
        stack: spawnError.stack,
        errno: spawnError.errno,
        code: spawnError.code,
      });
      throw spawnError;
    }

    ptyProcess.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-data', { agentId, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      terminals.delete(agentId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-exit', { agentId, exitCode });
      }
    });

    terminals.set(agentId, ptyProcess);

    // Run initial command if provided (e.g., "lazygit")
    if (command) {
      // Give the shell a moment to initialize
      setTimeout(() => {
        ptyProcess.write(`${command}\r`);
      }, 100);
    }

    console.log(`Terminal created successfully for agent ${agentId}`);
    return { success: true };
  } catch (error) {
    console.error(`Failed to create terminal for agent ${agentId}:`, error);
    throw new Error(`Failed to create terminal: ${error.message}`);
  }
});

// IPC: Write data to a PTY terminal
ipcMain.handle('write-terminal', async (event, { agentId, data }) => {
  const ptyProcess = terminals.get(agentId);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

// IPC: Resize a PTY terminal
ipcMain.handle('resize-terminal', async (event, { agentId, cols, rows }) => {
  const ptyProcess = terminals.get(agentId);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

// IPC: Destroy a PTY terminal
ipcMain.handle('destroy-terminal', async (event, agentId) => {
  const ptyProcess = terminals.get(agentId);
  if (ptyProcess) {
    ptyProcess.kill();
    terminals.delete(agentId);
  }
});
