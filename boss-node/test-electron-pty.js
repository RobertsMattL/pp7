const { app, ipcMain } = require('electron');
const pty = require('node-pty');
const os = require('os');

app.whenReady().then(() => {
  console.log('Electron ready, testing PTY...');

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const cwd = '/Users/matthewroberts/Library/Application Support/parallelagents-boss-node/repos/a2';

    console.log('Test parameters:');
    console.log('  shell:', shell);
    console.log('  cwd:', cwd);
    console.log('  node-pty path:', require.resolve('node-pty'));

    const env = Object.assign({}, process.env);
    env.TERM = 'xterm-256color';
    if (!env.SHELL) env.SHELL = shell;
    if (!env.HOME) env.HOME = os.homedir();
    if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd,
      env: env
    });

    console.log('SUCCESS: PTY spawned in Electron!');
    ptyProcess.kill();
    setTimeout(() => app.quit(), 100);
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error('Stack:', error.stack);
    console.error('Code:', error.code);
    console.error('Errno:', error.errno);
    setTimeout(() => app.quit(), 100);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
