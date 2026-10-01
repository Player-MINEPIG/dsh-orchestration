// SPDX-License-Identifier: MIT
// Config and all evidence must reside under an explicit operator-selected export root.
import { createSourceScope } from '../readers/common.mjs';
import { readAutomationDiagnostics } from './index.mjs';

const [root, configFile, format = 'text'] = process.argv.slice(2);
try {
  if (!root || !configFile || !['text', 'json'].includes(format)) throw new Error('usage');
  const scope = await createSourceScope(root, { maxBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
  const config = await scope.json(configFile);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config');
  const report = await readAutomationDiagnostics({ ...config, scope });
  process.stdout.write((format === 'json' ? JSON.stringify(report, null, 2) : report.text) + '\n');
  process.exitCode = report.data_quality.complete ? 0 : 2;
} catch (error) {
  process.stderr.write(`Diagnostics failed (${error.code ?? 'config'}). Usage: node run.mjs ABSOLUTE_EXPORT_ROOT RELATIVE_CONFIG_FILE [text|json]\n`);
  process.exitCode = 1;
}
