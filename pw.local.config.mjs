import base from '/home/claude/temoto-photo/playwright.config.js';
export default { ...base, testDir: '/home/claude/temoto-photo/tests/e2e', use: { ...base.use, launchOptions: { executablePath: '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] } }, webServer: { ...base.webServer, cwd: '/home/claude/temoto-photo' } };
