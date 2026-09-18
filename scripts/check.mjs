import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
for (const file of ['auto-update.js', 'update-check.js', 'update-settings.js', 'diagnostic-archive.js', 'diagnostic-request.js', 'emoji-data.js', 'channel-queue.js', 'recovery-status.js', 'loading-recovery.js', 'settings-backup.js', 'backup-settings-ui.js', 'email-report.js', 'email-settings.js', 'diagnostics.js', 'diagnostic-settings.js', 'notifications.js', 'notification-settings.js', 'readiness.js', 'controller.js', 'channel-manager.js', 'background.js', 'content.js', 'ui.js', 'ui-state.js']) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
for (const file of [manifest.side_panel.default_path, manifest.options_page, manifest.background.service_worker, ...manifest.content_scripts.flatMap(entry => entry.js)]) await access(file);
for (const page of ['popup.html', 'options.html']) {
  const html = await readFile(page, 'utf8');
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\son\w+\s*=/i.test(html)) throw new Error(`${page}: inline script violates extension CSP`);
}
console.log('JavaScript 문법, manifest 참조 파일, HTML CSP 검사 통과');

await access('notification-icon.png');
