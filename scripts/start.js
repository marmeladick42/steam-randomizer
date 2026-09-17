// Starts Electron with a clean env: ELECTRON_RUN_AS_NODE (set by some editors) would run it as plain Node.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env, cwd: `${__dirname}/..` });
child.on('close', (code) => process.exit(code ?? 0));
