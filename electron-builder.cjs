// electron-builder config (v26: win.signtoolOptions / win.azureSignOptions).
// Named .cjs on purpose: cmd.exe would run a local "electron-builder.js" via Windows Script Host instead of the CLI.
// Code signing is optional and driven only by env vars (shell or the git-ignored electron-builder.env,
// which the CLI loads before this file), so certificates and passwords never land in the repo.
const env = process.env;

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));

function windowsSigning() {
  const publisherName = env.WIN_SIGN_PUBLISHER;

  // Azure Trusted Signing; auth comes from AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
  if (env.AZURE_SIGN_ENDPOINT) {
    const azure = compact({
      publisherName,
      endpoint: env.AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
      certificateProfileName: env.AZURE_SIGN_PROFILE,
    });
    const missing = ['publisherName', 'codeSigningAccountName', 'certificateProfileName'].filter((k) => !azure[k]);
    if (missing.length) {
      throw new Error('Azure Trusted Signing: set WIN_SIGN_PUBLISHER, AZURE_SIGN_ACCOUNT and AZURE_SIGN_PROFILE');
    }
    console.log('[signing] Azure Trusted Signing');
    return { azureSignOptions: azure };
  }

  // Any other cloud HSM with its own CLI (jsign, eSigner CodeSignTool, ...): see scripts/sign-command.js.
  if (env.WIN_SIGN_COMMAND) {
    console.log('[signing] custom command (WIN_SIGN_COMMAND)');
    return { signtoolOptions: compact({ sign: './scripts/sign-command.js', signingHashAlgorithms: ['sha256'], publisherName }) };
  }

  // Certificate in the Windows store: hardware token or a cloud HSM exposed through a KSP.
  if (env.WIN_SIGN_CERT_SHA1 || env.WIN_SIGN_CERT_SUBJECT) {
    console.log('[signing] signtool, certificate from the Windows store');
    return {
      signtoolOptions: compact({
        certificateSha1: env.WIN_SIGN_CERT_SHA1,
        certificateSubjectName: env.WIN_SIGN_CERT_SUBJECT,
        rfc3161TimeStampServer: env.WIN_SIGN_TIMESTAMP_URL,
        signingHashAlgorithms: ['sha256'],
        publisherName,
      }),
    };
  }

  // .pfx/.p12 file: electron-builder reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD (or CSC_*) by itself.
  if (env.WIN_CSC_LINK || env.CSC_LINK) {
    console.log('[signing] signtool, certificate file from WIN_CSC_LINK');
    return {
      signtoolOptions: compact({
        rfc3161TimeStampServer: env.WIN_SIGN_TIMESTAMP_URL,
        signingHashAlgorithms: ['sha256'],
        publisherName,
      }),
    };
  }

  console.warn('[signing] WARNING: no code signing certificate configured, the build will be UNSIGNED (see README)');
  return {};
}

module.exports = {
  appId: 'local.steam-randomizer',
  productName: 'Steam Randomizer',
  files: ['main.js', 'preload.js', 'lib/**/*', 'renderer/**/*', 'package.json'],
  directories: { output: 'dist' },
  electronLanguages: ['ru', 'en-US'],
  compression: 'maximum',
  win: {
    target: ['portable'],
    icon: 'build/icon.ico',
    // No spaces in file names: the inner app exe and the distributables (no version either).
    executableName: 'SteamRandomizer',
    ...windowsSigning(),
  },
  portable: { artifactName: 'SteamRandomizer.${ext}' },
  nsis: { artifactName: 'SteamRandomizer-Setup.${ext}' },
  afterAllArtifactBuild: './scripts/checksums.mjs',
};
