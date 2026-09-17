// `npm run share`: starts web/server.js and opens a Cloudflare quick tunnel to it,
// so anyone with the printed https://….trycloudflare.com link can use the site.
// Needs cloudflared (winget install --id Cloudflare.cloudflared); CLOUDFLARED may point to its exe.
//
// The link is printed only once it really opens this site through public DNS. Opening it earlier makes
// resolvers (the ISP's especially) cache "no such domain" for a while, and the link looks broken.
const dns = require('dns');
const https = require('https');
const { spawn } = require('child_process');
const { start } = require('./server');

const INSTALL_HINT = 'Установите cloudflared: winget install --id Cloudflare.cloudflared (затем откройте новый терминал)';
const PUBLIC_DNS = ['1.1.1.1', '1.0.0.1'];
const FIRST_CHECK_DELAY = 5000; // give Cloudflare time to publish the name before anyone asks for it
const CHECK_INTERVAL = 3000;
const CHECK_TIMEOUT = 3 * 60e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
resolver.setServers(PUBLIC_DNS);

// Resolves the host via public DNS only, then fetches the page from that address.
async function opensThisSite(url) {
  const { hostname } = new URL(url);
  const [address] = await resolver.resolve4(hostname);
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { lookup: (_host, opts, cb) => (opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)), timeout: 8000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('web-api.js')));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function waitUntilReachable(url, isStopped) {
  console.log('[tunnel] туннель создан, ждём, пока адрес станет доступен в интернете…');
  await sleep(FIRST_CHECK_DELAY);
  const deadline = Date.now() + CHECK_TIMEOUT;
  while (!isStopped()) {
    if (await opensThisSite(url).catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await sleep(CHECK_INTERVAL);
  }
  return false;
}

async function main() {
  const { server, port } = await start();
  const bin = process.env.CLOUDFLARED || 'cloudflared';
  const tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stopped = false;
  let url = null;
  let connected = false;
  let checking = false;

  const announce = async () => {
    if (checking || !url || !connected) return;
    checking = true;
    const ok = await waitUntilReachable(url, () => stopped);
    if (stopped) return;
    if (ok) {
      console.log(`\n  Ссылка для друзей: ${url}\n  (новая при каждом запуске; Ctrl+C — остановить)\n`);
    } else {
      console.warn(
        `\n  Ссылка: ${url}\n  За ${CHECK_TIMEOUT / 60e3} мин она так и не открылась через публичный DNS — возможно, не заработает.` +
          '\n  Перезапустите npm run share; подробности cloudflared: TUNNEL_DEBUG=1\n',
      );
    }
  };

  const onOutput = (chunk) => {
    const text = chunk.toString();
    const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (found && !url) url = found[0];
    if (/Registered tunnel connection/.test(text)) connected = true;
    if (process.env.TUNNEL_DEBUG || /\bERR\b/.test(text)) process.stderr.write(text);
    announce();
  };
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput);

  tunnel.on('error', (err) => {
    stopped = true;
    console.error(err.code === 'ENOENT' ? `[tunnel] cloudflared не найден. ${INSTALL_HINT}` : `[tunnel] ${err.message}`);
    server.close();
    process.exit(1);
  });
  tunnel.on('exit', (code) => {
    stopped = true;
    console.log(`[tunnel] cloudflared завершился (код ${code})`);
    server.close();
    process.exit(code || 0);
  });

  const stop = () => {
    stopped = true;
    tunnel.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`[share] ${err.message}`);
  process.exit(1);
});
