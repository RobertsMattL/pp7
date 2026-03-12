const pty = require('node-pty');
const os = require('os');
const fs = require('fs');

try {
  const shell = process.env.SHELL || '/bin/zsh';
  const cwd = '/Users/matthewroberts/Library/Application Support/parallelagents-boss-node/repos/a2';

  console.log('Testing node-pty with:');
  console.log('  shell:', shell);
  console.log('  cwd:', cwd);
  console.log('  cwd exists:', fs.existsSync(cwd));

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

  console.log('SUCCESS: PTY spawned successfully');
  setTimeout(() => {
    ptyProcess.kill();
    process.exit(0);
  }, 100);
} catch (error) {
  console.error('ERROR:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
