/** Ship the pure decision contract with task-system; the decision service stays optional. */
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('packages/typed-decisions/src/validation.ts', root), 'utf8');
const { outputText, diagnostics } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
if (diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error('Decision contract compilation failed');
// Only the Node crypto import is allowed in this pure, self-contained contract.
if ([...outputText.matchAll(/from ['"]([^'"]+)['"]/g)].some(m => m[1] !== 'node:crypto')) throw Error('Decision contract acquired a runtime dependency; review its packaging');
writeFileSync(new URL('packages/task-system/dist/decision-validation.js', root), '// Generated from typed-decisions/src/validation.ts during the task build.\n' + outputText);
for (const file of ['task-policy.js', 'session-policy.js']) {
  const path = new URL(`packages/task-system/dist/${file}`, root);
  const compiled = readFileSync(path, 'utf8');
  if (!compiled.includes('"@dsh-task/typed-decisions/validation"')) throw Error(`Decision contract import missing in ${file}`);
  writeFileSync(path, compiled.replaceAll('"@dsh-task/typed-decisions/validation"', '"./decision-validation.js"'));
}
