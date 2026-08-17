'use strict';

const cp = require('child_process');

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || options.allowNonZero) {
        resolve({ code, stdout, stderr });
      } else {
        const error = new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function commandExists(command, args = ['--version']) {
  try {
    const result = await runProcess(command, args, { allowNonZero: true });
    return { ok: result.code === 0, detail: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || `exit ${result.code}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

module.exports = { runProcess, commandExists };
