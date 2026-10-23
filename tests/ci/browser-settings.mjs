import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export async function testSettings(browser, { output } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('http://localhost:43192/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
    await page.goto('http://localhost:43192/');
    for (const [name, file] of [['react', 'react.production.min.js'], ['react-dom', 'react-dom.production.min.js']]) {
      await page.addScriptTag({ content: readFileSync(join(dirname(require.resolve(`${name}/package.json`)), 'umd', file), 'utf8') });
    }
    await page.evaluate(() => {
      const h = React.createElement;
      const primitives = {
        Button: ({ children, variant, ...props }) => h('button', props, children),
        Switch: ({ label, checked, disabled, onChange }) => h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onChange: event => onChange(event.target.checked) }),
        SettingsForm: ({ children }) => h('div', null, children),
        SettingsValueField: ({ id, label, text, disabled, onEdit }) => h('label', null, label, h('input', { id, value: text, disabled, onChange: event => onEdit(event.target.value) })),
      };
      window.__ModuleLoader__ = { load: row => { window.settings = row.factory(name => name === 'react' ? React : name === 'react-dom' ? ReactDOM : primitives); } };
    });
    await page.addScriptTag({ content: readFileSync(new URL('../../packages/task-system/dist/settings-client.js', import.meta.url), 'utf8') });
    await page.evaluate(() => {
      const h = React.createElement;
      let root = ReactDOM.createRoot(document.getElementById('root'));
      window.mountStartup = async (target, options = {}) => {
        root.unmount(); root = ReactDOM.createRoot(document.getElementById('root'));
        const taskValues = { role: 'both', databasePath: '/fixture/tasks.sqlite', nodeId: 'immutable-node', executionAgentPreset: 'ptc', executionTools: null, planningDecisionEnabled: true, sessionDecisionEnabled: false };
        const remoteValues = { role: 'executor', paused: true, endpoint: 'http://127.0.0.2:18440/dsh-task/v1/commands', audience: 'scheduler', pollIntervalMs: 1000, concurrency: 1, taskSessionsEnabled: true, trustedNetworkTarget: { address: '127.0.0.2', port: 18440, localAddress: '127.0.0.3', allowHttp: true } };
        const fixture = window.fixture = { writes: [], checks: [], fail: false, reads: 0, coordinator: new settings.SettingsSaveCoordinator(), values: { ...(target === 'task' ? taskValues : remoteValues), ...options.values } };
        const row = { entryId: `fixture-${target}`, values: fixture.values, loaded: options.loaded !== false, loaderDisabled: !!options.loaderDisabled };
        function View() {
          const [, render] = React.useState(0);
          React.useEffect(() => fixture.coordinator.subscribe(() => render(value => value + 1)), []);
          const state = fixture.coordinator.snapshot();
          return h(React.Fragment, null,
            h(settings.StartupRow, { t: key => settings.zh[key] ?? key, target, row, writable: options.writable !== false, decisionAvailable: options.decisionAvailable !== false,
              readExecutionPresets: async () => ({ items: [{ id: 'ptc', label: 'PTC', available: true }, { id: 'codex', label: 'Codex', available: true }] }),
              saveCoordinator: fixture.coordinator,
              saveStartup: async input => { fixture.writes.push(structuredClone(input)); if (fixture.fail) throw { details: { reason: 'STARTUP_CONFLICT' } }; fixture.values = { ...fixture.values, ...input.changes }; },
              checkConnection: async input => { fixture.checks.push(structuredClone(input)); return { connected: true, paused: true }; },
              onSaved: async () => { fixture.reads++; row.values = fixture.values; return { [target]: { values: fixture.values } }; },
            }),
            h('button', { id: 'fixture-save', disabled: !state.count || state.invalid || state.busy, onClick: () => fixture.coordinator.saveAll() }, 'Save fixture'),
            h('button', { id: 'fixture-discard', disabled: (!state.count && !state.retained) || state.busy, onClick: () => fixture.coordinator.discardAll() }, 'Discard fixture'),
            h('output', { id: 'fixture-save-state' }, JSON.stringify(state)));
        }
        root.render(h(View));
      };
      window.mountStartupSettings = () => {
        root.unmount(); root = ReactDOM.createRoot(document.getElementById('root'));
        const fixture = window.fixture = { reads: 0, writes: [], snapshot: { writable: true, remote: null, task: { entryId: 'task-system', decisionAvailable: true, values: { role: 'both', nodeId: 'immutable-node', databasePath: '/fixture/tasks.sqlite', executionAgentPreset: 'ptc', executionTools: null, planningDecisionEnabled: true, sessionDecisionEnabled: false } } } };
        root.render(h(settings.StartupSettings, { t: key => settings.zh[key] ?? key,
          startup: async () => { fixture.reads++; return structuredClone(fixture.snapshot); },
          readExecutionPresets: async () => ({ items: [{ id: 'ptc', label: 'PTC', available: true }] }),
          readConnectionSettings: async () => ({ exists: false, writable: false, revision: 0, values: { authMode: 'trusted-network', listenerEnabled: false, listenAddress: '127.0.0.1', listenPort: 18440, routePath: '/dsh-task/v1/commands', serviceAudience: 'scheduler', peers: [], outbound: null } }),
          saveStartup: async input => { fixture.writes.push(structuredClone(input)); fixture.snapshot.task.values = { ...fixture.snapshot.task.values, ...input.changes }; }, onSaved: () => {},
        }));
      };
      window.mountGrants = () => {
        root.unmount(); root = ReactDOM.createRoot(document.getElementById('root'));
        const fixture = window.fixture = { writes: [], fail: false, catalog: { enabled: true, revision: 4, items: [
          { registryId: 'a', workspaceId: 'a', label: 'Project', path: '/fixture/one', enabled: true, available: true, state: 'ready', source: 'registry' },
          { registryId: 'b', workspaceId: 'b', label: 'Project', path: '/fixture/two', enabled: false, available: false, state: 'revoked', source: 'registry' },
          { registryId: 'config', workspaceId: 'config', label: 'Policy', path: '/fixture/configured', enabled: true, available: true, state: 'ready', source: 'configuration' },
        ] } };
        root.render(h(settings.ExecutorWorkspaceGrantSettings, { readGrants: async () => structuredClone(fixture.catalog), setGrant: async input => { fixture.writes.push(input); if (fixture.fail) throw { details: { reason: 'CONFIGURATION_BUSY' } }; return { ...fixture.catalog, revision: 5, items: fixture.catalog.items.map(item => item.registryId === input.registryId ? { ...item, enabled: input.enabled, state: 'revoked' } : item) }; } }));
      };
      window.mountSurface = () => {
        root.unmount(); root = ReactDOM.createRoot(document.getElementById('root'));
        const fixture = window.fixture = { surface: new settings.TaskSettingsSurface() };
        const fields = Object.fromEntries(settings.keys.map(key => [key, { text: key === 'maxConcurrent' ? '4' : key === 'localHeartbeatIntervalMs' ? '1000' : 'false' }]));
        let setRuntime;
        const props = { t: key => settings.zh[key] ?? key,
          useTaskSettings: () => { const [state, set] = React.useState({ fields, writable: true, dirty: false, invalid: false, saving: false }); setRuntime = set; return state; },
          edit: (key, text) => setRuntime(old => ({ ...old, dirty: true, fields: { ...old.fields, [key]: { ...old.fields[key], text } } })),
          discard: () => setRuntime(old => ({ ...old, dirty: false, fields })), save: async () => true,
          read: async () => ({ nodeId: 'immutable-node', role: 'executor' }), readQueue: async () => ({ nodeId: 'immutable-node', items: [], sampledAt: new Date().toISOString() }),
        };
        function Surface() {
          const [visible, setVisible] = React.useState(true);
          return h(React.Fragment, null, h('button', { id: 'surface-toggle', onClick: () => setVisible(value => !value) }, 'Toggle settings'), visible ? h(settings.TaskSettingsPanel, { surface: fixture.surface }) : null, h(settings.TaskSettingsPortal, { ...props, surface: fixture.surface }));
        }
        root.render(h(Surface));
      };
    });

    await page.evaluate(() => mountStartup('task'));
    const role = page.locator('#task-startup-task-role');
    await role.selectOption('planner');
    assert.equal(await page.locator('[data-task-executor-decision] [role=switch]').isDisabled(), true);
    assert.equal(await page.locator('[data-task-scheduler-decision] [role=switch]').isDisabled(), false);
    await page.locator('[data-task-scheduler-decision] [role=switch]').uncheck();
    assert.equal(await page.evaluate(() => fixture.writes.length), 0);
    await page.evaluate(() => { fixture.fail = true; });
    await page.locator('#fixture-save').click();
    await page.getByText(/STARTUP_CONFLICT/).waitFor();
    assert.equal(await role.inputValue(), 'planner');
    assert.equal(await page.locator('[data-task-scheduler-decision] [role=switch]').isChecked(), false);
    await page.evaluate(() => { fixture.fail = false; });
    await page.locator('#fixture-save').click();
    await page.waitForFunction(() => fixture.reads === 1);
    const saved = await page.evaluate(() => fixture.writes.at(-1));
    assert.deepEqual(saved.changes, { role: 'planner', planningDecisionEnabled: false });
    assert.equal(saved.expected.nodeId, 'immutable-node');
    assert.equal(saved.changes.nodeId, undefined);
    await role.selectOption('both');
    await page.locator('#fixture-discard').click();
    assert.equal(await role.inputValue(), 'planner', 'discard restores the last saved Host snapshot');
    assert.equal(await page.locator('[data-task-scheduler-decision] [role=switch]').isChecked(), false);

    await page.evaluate(() => mountStartup('task', { writable: false, decisionAvailable: false }));
    await role.waitFor();
    assert.equal(await role.isDisabled(), true);
    assert.equal(await page.locator('[data-task-scheduler-decision] [role=switch]').isDisabled(), true);
    assert.equal(await page.locator('#fixture-save').isDisabled(), true);
    await page.evaluate(() => mountStartup('task', { decisionAvailable: false }));
    await page.getByText(/需要安装并启用 dsh-jev-plugin 决策插件/).waitFor();
    assert.equal(await page.locator('[data-task-executor-decision] [role=switch]').isDisabled(), true);

    await page.evaluate(() => mountStartupSettings());
    await role.selectOption('planner');
    await page.evaluate(() => { fixture.snapshot.task.values.role = 'executor'; fixture.snapshot.task.values.sessionDecisionEnabled = true; });
    await page.getByRole('button', { name: '刷新启动配置', exact: true }).click();
    await page.waitForFunction(() => fixture.reads === 2);
    assert.equal(await role.inputValue(), 'planner', 'refresh retains an edited startup draft');
    await page.getByRole('button', { name: '丢弃草稿', exact: true }).click();
    assert.equal(await role.inputValue(), 'executor', 'discard adopts the refreshed Host snapshot');
    assert.equal(await page.locator('[data-task-executor-decision] [role=switch]').isChecked(), true);
    assert.equal(await page.locator('[data-task-scheduler-decision] [role=switch]').isDisabled(), true);
    assert.equal(await page.evaluate(() => fixture.writes.length), 0);

    await page.evaluate(() => mountStartup('remote'));
    const port = page.locator('#task-startup-remote-connectionPort');
    await port.fill('18441');
    await page.getByRole('button', { name: '检验连接', exact: true }).click();
    await page.waitForFunction(() => fixture.checks.length === 1);
    let connection = await page.evaluate(() => ({ writes: fixture.writes, check: fixture.checks[0] }));
    assert.equal(connection.writes.length, 0);
    assert.equal(connection.check.endpoint, 'http://127.0.0.2:18441/dsh-task/v1/commands');
    assert.equal(connection.check.trustedNetworkTarget.port, 18441);
    assert.equal(connection.check.trustedNetworkTarget.localAddress, '127.0.0.3');
    await page.locator('#fixture-save').click();
    await page.waitForFunction(() => fixture.reads === 1);
    connection = await page.evaluate(() => fixture.writes[0]);
    assert.equal(connection.changes.endpoint, 'http://127.0.0.2:18441/dsh-task/v1/commands');
    assert.equal(connection.changes.trustedNetworkTarget.port, 18441);
    for (const key of ['nodeId', 'authMode', 'grants', 'credentials']) assert.equal(connection.changes[key], undefined);
    await page.getByRole('switch', { name: '启用执行端连接' }).check();
    assert.equal(await page.evaluate(() => fixture.writes.length), 1, 'availability stays staged under unified save');
    await page.locator('#fixture-discard').click();
    assert.equal(await page.getByRole('switch', { name: '启用执行端连接' }).isChecked(), false);
    await page.evaluate(() => mountStartup('remote', { loaderDisabled: true }));
    await port.waitFor();
    assert.equal(await port.isDisabled(), true);
    assert.equal(await page.getByRole('switch', { name: '启用执行端连接' }).isDisabled(), true);

    await page.evaluate(() => mountGrants());
    await page.getByText('/fixture/one', { exact: true }).waitFor();
    assert.equal(await page.getByText('/fixture/two', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '启用此工作区', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '由插件配置管理', exact: true }).isDisabled(), true);
    await page.evaluate(() => { fixture.fail = true; });
    await page.getByRole('button', { name: '停用此工作区', exact: true }).click();
    await page.getByText(/本机仍有活动执行或待回传结果/).waitFor();
    assert.equal(await page.getByRole('button', { name: '停用此工作区', exact: true }).count(), 1);
    await page.evaluate(() => { fixture.fail = false; });
    await page.getByRole('button', { name: '停用此工作区', exact: true }).click();
    await page.getByText(/本机工作区已停用/).waitFor();
    assert.deepEqual(await page.evaluate(() => fixture.writes), [{ registryId: 'a', enabled: false, expectedRevision: 4 }, { registryId: 'a', enabled: false, expectedRevision: 4 }]);

    await page.evaluate(() => mountSurface());
    await page.locator('#task-setting-maxConcurrent').fill('7');
    const node = await page.locator('#task-setting-maxConcurrent').elementHandle();
    await page.locator('#surface-toggle').click();
    assert.equal(await page.locator('#task-setting-maxConcurrent').count(), 0);
    await page.locator('#surface-toggle').click();
    assert.equal(await page.locator('#task-setting-maxConcurrent').inputValue(), '7');
    assert.equal(await page.locator('#task-setting-maxConcurrent').evaluate((current, original) => current === original, node), true);
    await page.getByRole('button', { name: '丢弃全部草稿', exact: true }).click();
    assert.equal(await page.locator('#task-setting-maxConcurrent').inputValue(), '4');
    await node.dispose();
    assert.deepEqual(errors, []);
    return { name: 'settings', realReactLifecycle: true, stagedSaveConflictAndDiscard: true, exactConnectionDraft: true, roleAndPermissionBoundaries: true, localWorkspaceGrants: true, persistentPortal: true };
  } catch (error) {
    if (output) await page.screenshot({ path: join(output, 'settings-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
