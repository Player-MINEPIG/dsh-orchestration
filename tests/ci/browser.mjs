import { testTaskCheckins } from "./browser-task-checkins.mjs";
import { testStewardScopeResponses } from "./browser-steward.mjs";
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { testNativeProject } from './browser-native-project.mjs';
import { testSettings } from './browser-settings.mjs';
import { testExecutorAlerts } from './browser-executor-alerts.mjs';
import { testTaskCenterSelection } from '../../scripts/validation/task-center-selection-browser.mjs';

const output = resolve(process.env.DSH_BROWSER_OUTPUT || join(tmpdir(), 'dsh-ci-browser'));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.DSH_BROWSER_CHANNEL ? { channel: process.env.DSH_BROWSER_CHANNEL } : {}) });
const results = [];
console.log(`Browser evidence: ${output}`);
try {
  for (const [name, run] of [['settings', testSettings], ['executor alerts', testExecutorAlerts], ['responsible task check-ins', testTaskCheckins], ['task center polling selection', testTaskCenterSelection], ['production native project conversation', testNativeProject], ['steward delayed scope responses', testStewardScopeResponses]]) {
    try {
      const result = await run(browser, { output });
      results.push({ name, status: 'passed', result });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, status: 'failed', error: error.stack ?? String(error) });
      throw error;
    } finally { writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n'); }
  }
} finally { await browser.close(); }
