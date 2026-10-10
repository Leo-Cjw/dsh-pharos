import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

/** Open only DSH's registered protocol. Its single-instance owner restores/shows/focuses the window. */
export function restoreWindowsDesktop({ platform = process.platform, launch = spawn, systemRoot = process.env.SystemRoot ?? 'C:\\Windows' } = {}) {
  if (platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const child = launch(win32.join(systemRoot, 'explorer.exe'), ['dsh://open'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}
