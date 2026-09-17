// electron-builder custom sign hook: runs WIN_SIGN_COMMAND for every file to sign.
// "{file}" in the command is replaced with the quoted file path, e.g.
//   WIN_SIGN_COMMAND=jsign --storetype DIGICERTONE --keystore ... --storepass %DIGICERT_PASS% {file}
const { execSync } = require('child_process');

module.exports = async function sign(configuration) {
  const template = process.env.WIN_SIGN_COMMAND;
  if (!template.includes('{file}')) throw new Error('WIN_SIGN_COMMAND must contain {file}');
  const command = template.split('{file}').join(`"${configuration.path}"`);
  // The command may contain secrets, so only the file name is logged.
  console.log(`[signing] ${configuration.path}`);
  execSync(command, { stdio: 'inherit' });
};
