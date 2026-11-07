/**
 * dsh-jev-plugin — browser half.
 *
 * Registers a JEV page in Settings (`settings.section`) that lets
 * each user pick the provider, point at a custom endpoint, and store their own
 * API key in the DSH credentials service.
 *
 * Written as plain React.createElement (no JSX) in the __ModuleLoader__ bundle
 * format this deployment loads plugin clients with.
 *
 * ON THE ID BELOW. It must equal the package name exactly. The client-modules
 * boot config is keyed by package name —
 * `{"id":"dsh-jev-plugin","url":"/plugins/??dsh-jev-plugin/client.js","inject":[…]}` —
 * and the loader looks this module up by that key. It registered as `dsh-jev`
 * while the package was `dsh-jev-plugin`, so the lookup missed and the client
 * half died with `failed to import loader entry`.
 *
 * It is a literal rather than a shared constant on purpose: DSH concatenates
 * every plugin's client half into ONE script
 * (`/plugins/??a/client.js,b/client.js,…`), so a top-level declaration here would
 * share a scope with ~40 other plugins and a name collision would take the whole
 * bundle down, not just this card. `test/client-bundle.test.mjs` asserts the id
 * matches package.json instead, so a future rename fails the suite rather than
 * the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-jev-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const BRIDGE = '/api/dsh-jev-settings'
    const NS = 'jev'
    // Scoped inside the factory, so it cannot collide with the other plugins
    // concatenated into the same script. Must stay in step with the loader id
    // above; `test/client-bundle.test.mjs` checks both against package.json.
    const PACKAGE = 'dsh-jev-plugin'

    const css = `
.dshjev-card{--jev-bg:#f7f8fa;--jev-panel:#fff;--jev-text:#202a38;--jev-muted:#596779;--jev-line:#dce1e8;--jev-accent:#265bad;--jev-selected:#e9f0fc;--jev-fill:#265bad;--jev-fill-text:#fff;--jev-success:#27734d;--jev-warning:#855b15;--jev-error:#b13544;box-sizing:border-box;border:1px solid var(--jev-line);background:var(--jev-panel);color:var(--jev-text);border-radius:12px;min-width:0;list-style:none;margin:0 0 16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;caret-color:var(--jev-accent)}
.dshjev-card[data-theme=dark]{--jev-bg:#151b24;--jev-panel:#1d2531;--jev-text:#e8edf5;--jev-muted:#a9b6c8;--jev-line:#374457;--jev-accent:#9abfff;--jev-selected:#263d5d;--jev-fill:#9abfff;--jev-fill-text:#15243b;--jev-success:#8ac9aa;--jev-warning:#e1bd7b;--jev-error:#f2a0ad;color-scheme:dark}
.dshjev-card[data-theme=light]{color-scheme:light}
.dshjev-card *{box-sizing:border-box}.dshjev-card ::selection{background:var(--jev-selected);color:var(--jev-text)}
.dshjev-header{width:100%;color:inherit;cursor:pointer;text-align:left;font:inherit;background:transparent;border:0;align-items:center;gap:12px;padding:20px 24px;display:flex;border-radius:12px}
.dshjev-header:hover:not(:disabled){background:var(--jev-bg)}
.dshjev-headText{flex-direction:column;flex:1;gap:5px;min-width:0;display:flex}
.dshjev-name{color:var(--jev-text);font-size:18px;font-weight:650;overflow-wrap:anywhere}
.dshjev-description{color:var(--jev-muted);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.dshjev-badge{flex:none;font-size:11px;padding:3px 8px;border-radius:5px;border:1px solid var(--jev-line);color:var(--jev-muted)}
.dshjev-badgeOk{color:var(--jev-success);border-color:var(--jev-success)}.dshjev-badgeWarn{color:var(--jev-warning);border-color:var(--jev-warning)}
.dshjev-chevron{color:var(--jev-muted);flex:none;width:18px;height:18px;transition:transform 160ms ease}.dshjev-chevronOpen{transform:rotate(180deg)}
.dshjev-body{flex-direction:column;gap:20px;margin:0 24px;padding:24px 0;display:flex;border-top:1px solid var(--jev-line)}
.dshjev-field{flex-direction:column;gap:8px;min-width:0;display:flex;margin:0}
.dshjev-label{color:var(--jev-text);font-size:13px;font-weight:600}
.dshjev-hint{color:var(--jev-muted);font-size:12px;line-height:1.75;max-width:75ch;overflow-wrap:anywhere}
.dshjev-input,.dshjev-select{border:1px solid var(--jev-line);font:inherit;color:var(--jev-text);background:var(--jev-panel);border-radius:7px;padding:9px 12px;font-size:13px;width:100%;min-height:40px;min-width:0}
.dshjev-compact{width:24rem;max-width:100%}.dshjev-select option{background:var(--jev-panel);color:var(--jev-text)}
.dshjev-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}.dshjev-row>.dshjev-input{flex:1;min-width:180px}
.dshjev-btn{cursor:pointer;font:inherit;font-size:13px;border-radius:7px;padding:8px 12px;min-height:40px;border:1px solid var(--jev-line);background:var(--jev-panel);color:var(--jev-text)}
.dshjev-btn:hover:not(:disabled){background:var(--jev-selected);border-color:var(--jev-accent)}.dshjev-btn:disabled,.dshjev-input:disabled,.dshjev-select:disabled{opacity:.6;cursor:not-allowed}
.dshjev-primary{background:var(--jev-fill);color:var(--jev-fill-text);border-color:var(--jev-fill);font-weight:600}.dshjev-primary:hover:not(:disabled){background:var(--jev-fill);filter:brightness(.95)}
.dshjev-ok{color:var(--jev-success);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.dshjev-err{color:var(--jev-error);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.dshjev-usage{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--jev-muted)}
.dshjev-card :is(button,input,select,a):focus-visible{outline:2px solid var(--jev-accent);outline-offset:3px}
@media(max-width:760px){.dshjev-header{padding:18px 16px;flex-wrap:wrap}.dshjev-description{font-size:12px}.dshjev-body{margin:0 16px;padding:20px 0}.dshjev-input,.dshjev-select{font-size:16px;min-height:44px}.dshjev-btn{min-height:44px}.dshjev-row>.dshjev-input{min-width:100%;flex-basis:100%}}
@media(max-width:640px){[role=dialog]:has(.dshjev-card){flex-direction:column;width:calc(100vw - 24px);max-height:calc(100dvh - 24px);min-width:0}[role=dialog]:has(.dshjev-card)>nav{width:100%;height:auto;flex:0 0 auto;padding:16px}[role=dialog]:has(.dshjev-card)>nav>div:last-child{display:flex;flex-direction:row;align-items:center;flex-wrap:wrap;gap:4px;padding-top:12px}[role=dialog]:has(.dshjev-card)>nav>div:last-child>button{width:auto;min-height:44px;flex:0 0 auto;padding:8px 10px}[role=dialog]:has(.dshjev-card)>nav+div{width:100%;min-width:0;min-height:0;flex:1 1 auto}[role=dialog]:has(.dshjev-card)>nav+div>div:last-child{padding:16px}.dshjev-card{max-width:100%}}
@media(prefers-reduced-motion:reduce){.dshjev-card *{transition:none!important;scroll-behavior:auto!important}}
`

    function adoptStyles() {
      const ID = 'dsh-jev-styles'
      if (document.getElementById(ID) !== null) return
      const style = document.createElement('style')
      style.id = ID
      style.textContent = css
      document.head.appendChild(style)
    }

    async function post(route, body) {
      const response = await fetch(`${BRIDGE}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return response.json()
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dshjev-field' },
        h('span', { className: 'dshjev-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dshjev-hint' }, props.hint) : null,
      )
    }

    function JevCard({ expanded = false } = {}) {
      const readTheme = () => {
        const scheme = getComputedStyle(document.documentElement).colorScheme
        return scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
      }
      const [theme, setTheme] = React.useState(readTheme)
      React.useEffect(() => {
        const update = () => setTheme(readTheme())
        const observer = new MutationObserver(update)
        observer.observe(document.documentElement, {attributes:true})
        observer.observe(document.body, {attributes:true})
        const system = matchMedia('(prefers-color-scheme: dark)')
        system.addEventListener('change', update)
        update()
        return () => { observer.disconnect(); system.removeEventListener('change', update) }
      }, [])
      const [open, setOpen] = React.useState(expanded)
      const [view, setView] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [key, setKey] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [test, setTest] = React.useState(null)
      const [keyStatus, setKeyStatus] = React.useState(null)
      const [catalog, setCatalog] = React.useState({providers:[], models:[], provider:'', loading:false, error:null})

      const load = React.useCallback(async () => {
        try {
          const result = await post('describe')
          if (result?.ok) {
            setView(result.value)
            setDraft({
              enabled: result.value.value.enabled !== false,
              provider: result.value.value.provider ?? 'typesafe',
              model: result.value.value.model ?? '',
              baseUrl: result.value.value.baseUrl ?? '',
              nativeProvider: result.value.value.nativeProvider ?? '',
              reasoningEffort: result.value.value.reasoningEffort ?? '',
            })
          } else {
            setNote({ bad: true, text: result?.message ?? 'could not read the settings' })
          }
        } catch (error) {
          setNote({ bad: true, text: String(error?.message ?? error) })
        }
      }, [])

      const resetUsage = async () => {
        setBusy(true)
        try {
          const result = await post('usage', { reset: true })
          // Only the usage figure changes: reloading the whole view would throw
          // away an edit the user has not saved yet.
          if (result?.ok) setView((v) => ({ ...v, usage: result.value }))
          else setNote({ bad: true, text: result?.message ?? 'could not reset the ledger' })
        } catch (error) {
          setNote({ bad: true, text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        if (open && view === null) void load()
      }, [open, view, load])

      const providers = view?.providers ?? []
      const provider = providers.find((p) => p.id === draft?.provider) ?? providers[0]
      const nativeMode = draft?.provider === 'native'
      const models = catalog.provider === draft?.nativeProvider ? catalog.models : []
      const selectedModel = models.find(m => m.id === draft?.model)
      const efforts = selectedModel?.reasoningEfforts ?? []
      React.useEffect(() => {
        if (!open || !nativeMode || draft === null) return
        let disposed = false
        setCatalog(c => ({...c, loading:true, error:null}))
        post('catalog', {provider:draft.nativeProvider || undefined}).then(result => {
          if (disposed) return
          if (result?.ok) setCatalog({...result.value, loading:false, error:null})
          else setCatalog(c => ({...c, loading:false, error:result?.message ?? 'Could not load DSH models.'}))
        }).catch(() => {
          if (!disposed) setCatalog(c => ({...c, loading:false, error:'Could not load DSH models. Reload to retry.'}))
        })
        return () => {disposed = true}
      }, [open, nativeMode, draft?.nativeProvider, view])

      const select = (value, choices, onChange, defaultLabel, disabled = false) => h('select', {
        className:'dshjev-select dshjev-compact', value:value ?? '', disabled:busy || catalog.loading || disabled,
        onChange:event => onChange(event.target.value),
      },
        h('option', {value:'', disabled:defaultLabel.startsWith('Select ')}, defaultLabel),
        value && !choices.some(c => c.id === value) ? h('option', {value, disabled:true}, `${value} (currently configured; unavailable)`) : null,
        choices.map(c => h('option', {key:c.id, value:c.id}, c.name || c.id)),
      )
      const selectedKey = keyStatus?.provider === draft?.provider ? keyStatus : null
      React.useEffect(() => {
        setKeyStatus(null)
        if (!open || !draft || !view || nativeMode || provider?.nativeProvider) return
        let disposed = false
        post('key-describe',{provider:draft.provider, expectedRevision:view.revision}).then(result => {
          if (!disposed && result?.ok) setKeyStatus(result.value)
        }).catch(() => {})
        return () => {disposed = true}
      }, [open, draft?.provider, view?.revision])
      const dirty =
        draft !== null &&
        view !== null &&
        (draft.enabled !== (view.value.enabled !== false) ||
          draft.provider !== (view.value.provider ?? 'typesafe') ||
          draft.model !== (view.value.model ?? '') ||
          draft.baseUrl !== (view.value.baseUrl ?? '') ||
          draft.nativeProvider !== (view.value.nativeProvider ?? '') ||
          draft.reasoningEffort !== (view.value.reasoningEffort ?? ''))

      const run = async (fn) => {
        setBusy(true)
        setNote(null)
        try {
          await fn()
        } catch (error) {
          setNote({ bad: true, text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const save = () =>
        run(async () => {
          const result = await post('mutate', {
            expectedRevision: view?.revision,
            ops: [
              { op: 'set', path: ['enabled'], value: draft.enabled },
              { op: 'set', path: ['provider'], value: draft.provider },
              { op: 'set', path: ['model'], value: draft.model },
              { op: 'set', path: ['baseUrl'], value: draft.baseUrl },
              { op: 'set', path: ['nativeProvider'], value: draft.nativeProvider },
              { op: 'set', path: ['reasoningEffort'], value: draft.reasoningEffort },
            ],
          })
          if (!result?.ok) {
            setNote({ bad: true, text: result?.message ?? 'the settings were rejected' })
            return
          }
          setView(result.value)
          setNote({ text: 'Saved.' })
        })

      const saveKey = () =>
        run(async () => {
          const result = await post('key-set', {value:key, provider:draft.provider, expectedRevision:view.revision})
          if (!result?.ok) {
            setNote({ bad: true, text: result?.message ?? 'the key was rejected' })
            return
          }
          setKey('')
          setView(result.value)
          setKeyStatus(result.key)
          setNote({ text: `Key saved for ${result.key.credential}. Save the provider settings to use it.` })
        })

      const clearKey = () =>
        run(async () => {
          const result = await post('key-unset', {provider:draft.provider, expectedRevision:view.revision})
          if (!result?.ok) {
            setNote({ bad: true, text: result?.message ?? 'the key could not be removed' })
            return
          }
          setView(result.value)
          setKeyStatus(result.key)
          setNote({ text: 'Key removed.' })
        })

      const runTest = () =>
        run(async () => {
          setTest(null)
          const result = await post('test')
          setTest(result)
        })

      const status = () => {
        if (view === null) return h('span', { className: 'dshjev-badge' }, '…')
        if (dirty) return h('span', {className:'dshjev-badge dshjev-badgeWarn'}, 'Unsaved settings')
        if (view.nativeProvider) return h('span', {className:'dshjev-badge dshjev-badgeOk'}, 'DSH Models')
        if (view.keyConfigured) return h('span', { className: 'dshjev-badge dshjev-badgeOk' }, 'key set')
        if (view.envFallback) return h('span', { className: 'dshjev-badge dshjev-badgeOk' }, 'env var')
        return h('span', { className: 'dshjev-badge dshjev-badgeWarn' }, 'no key')
      }

      return h(
        'li',
        { className: open ? 'dshjev-card dshjev-cardOpen' : 'dshjev-card', 'data-theme':theme },
        h(
          'button',
          {
            className: 'dshjev-header',
            type: 'button',
            onClick: () => setOpen(!open),
            'aria-expanded': open,
          },
          h(
            'span',
            { className: 'dshjev-headText' },
            h('span', { className: 'dshjev-name' }, 'Jev'),
            h(
              'span',
              { className: 'dshjev-description' },
              'Typed decisions (noul / choice / score) with probabilities, for judging many items in one call.',
            ),
          ),
          status(),
          h('svg', { className: open ? 'dshjev-chevron dshjev-chevronOpen' : 'dshjev-chevron', viewBox:'0 0 20 20', fill:'none', stroke:'currentColor', strokeWidth:1.5, 'aria-hidden':true }, h('path',{d:'m5 7 5 5 5-5'})),
        ),
        open
          ? h(
              'div',
              { className: 'dshjev-body' },
              h(
                Field,
                { label: 'Provider', hint: 'Decides the endpoint and the model. Each provider has its own API key.' },
                h(
                  'select',
                  {
                    className: 'dshjev-select',
                    value: draft?.provider ?? 'typesafe',
                    disabled: busy || draft === null,
                    onChange: (event) => {setDraft({...draft, provider:event.target.value, model:'', reasoningEffort:''});setKey('');setNote(null);setTest(null)},
                  },
                  providers.map((p) => h('option', { key: p.id, value: p.id }, p.label)),
                ),
              ),
              provider && provider.url
                ? h(
                    'span',
                    { className: 'dshjev-hint' },
                    `Endpoint: ${provider.url} · `
                    + (provider.modelHint ?? `default model ${provider.model}`),
                  )
                : null,
              provider && provider.note
                ? h('span', { className: 'dshjev-hint' }, provider.note)
                : null,
              nativeMode ? h(React.Fragment, null,
                h(Field,{label:'DSH provider',hint:'Choose a registered DSH provider. Credentials are managed in Models.'},
                  select(draft.nativeProvider,catalog.providers,value=>setDraft({...draft,nativeProvider:value,model:'',reasoningEffort:''}),'Select provider')),
                h(Field,{label:'Reasoning effort',hint:'Choices follow the selected model. Leave default to use the provider’s setting.'},
                  select(draft.reasoningEffort,efforts,value=>setDraft({...draft,reasoningEffort:value}),'Provider default',!selectedModel || efforts.length === 0)),
                catalog.error ? h('span',{className:'dshjev-err',role:'alert'},catalog.error) : null,
              ) : null,
              draft?.provider === 'custom'
                ? h(
                    Field,
                    {
                      label: 'Base URL',
                      hint: 'Any endpoint implementing the TypeSafe contract, POST /v1/systemone.',
                    },
                    h('input', {
                      className: 'dshjev-input',
                      value: draft.baseUrl,
                      disabled: busy,
                      placeholder: 'https://example.com/v1/systemone',
                      onChange: (event) => setDraft({ ...draft, baseUrl: event.target.value }),
                    }),
                  )
                : null,
              h(
                Field,
                {
                  label: nativeMode ? 'Model' : 'Model override',
                  hint: nativeMode ? 'Choose a model from the selected DSH provider.' : 'Leave empty to use the provider default shown above.',
                },
                nativeMode ? select(draft.model,models,value=>setDraft({...draft,model:value,reasoningEffort:''}),'Select model',!draft.nativeProvider) : h('input', {
                  className: 'dshjev-input',
                  value: draft?.model ?? '',
                  disabled: busy || draft === null,
                  placeholder: provider?.modelHint ? 'english | multilingual | typed-decisions' : (provider?.model ?? ''),
                  onChange: (event) => setDraft({ ...draft, model: event.target.value }),
                }),
              ),
              (provider?.id === 'native' || provider?.nativeProvider) ? h('p', {className:'dshjev-hint'}, 'Credentials and billing for ordinary models are managed by DSH Models and the selected provider.') : h(
                Field,
                {
                  label: `API key for ${provider?.label ?? 'the selected provider'}`,
                  hint: provider?.keyHint
                    ? `${provider.keyHint}. Stored in the DSH credentials store, never in settings.yaml.`
                    : 'Stored in the DSH credentials store.',
                },
                h(
                  'span',
                  { className: 'dshjev-row' },
                  h('input', {
                    className: 'dshjev-input',
                    style: { flex: '1 1 220px' },
                    type: 'password',
                    value: key,
                    disabled: busy,
                    autoComplete: 'off',
                    placeholder: selectedKey?.configured ? '•••• (configured — type to replace)' : 'paste the key',
                    onChange: (event) => setKey(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      className: 'dshjev-btn',
                      type: 'button',
                      disabled: busy || key.trim().length === 0,
                      onClick: saveKey,
                    },
                    'Save key',
                  ),
                  h(
                    'button',
                    {
                      className: 'dshjev-btn',
                      type: 'button',
                      disabled: busy || !selectedKey?.configured,
                      onClick: clearKey,
                    },
                    'Remove',
                  ),
                ),
              ),
              h(
                'label',
                { className: 'dshjev-row' },
                h('input', {
                  type: 'checkbox',
                  checked: draft?.enabled !== false,
                  disabled: busy || draft === null,
                  onChange: (event) => setDraft({ ...draft, enabled: event.target.checked }),
                }),
                h('span', { className: 'dshjev-label' }, 'Enable Jev model calls and tool'),
              ),
              view?.endpointError
                ? h('span', { className: 'dshjev-err' }, view.endpointError)
                : null,
              note
                ? h('span', { className: note.bad ? 'dshjev-err' : 'dshjev-ok' }, note.text)
                : null,
              test
                ? h(
                    'span',
                    { className: test.ok ? 'dshjev-ok' : 'dshjev-err' },
                    test.ok
                      ? `OK · ${test.value.provider} · ${test.value.model} · ${test.value.latencyMs} ms · ${test.value.inputTokens} input tokens\n${JSON.stringify(test.value.answers)}`
                      : `Failed: ${test.message}`,
                  )
                : null,
              view?.usage
                ? h(
                    'span',
                    { className: 'dshjev-usage' },
                    `Today · ${view.usage.calls} judgment${view.usage.calls === 1 ? '' : 's'}`
                      + ` · ${Number(view.usage.inputTokens).toLocaleString()} input tokens`
                      + ` · $${Number(view.usage.costUsd).toFixed(4)}`
                      + (view.usage.failures > 0 ? ` · ${view.usage.failures} failed` : ''),
                    h(
                      'button',
                      { className: 'dshjev-btn', type: 'button', disabled: busy, onClick: resetUsage },
                      'Reset',
                    ),
                  )
                : null,
              h(
                'span',
                { className: 'dshjev-row' },
                h(
                  'button',
                  {
                    className: 'dshjev-btn dshjev-primary',
                    type: 'button',
                    disabled: busy || !dirty || (nativeMode && (!draft.nativeProvider || !draft.model)),
                    onClick: save,
                  },
                  busy ? 'Working…' : 'Save',
                ),
                h(
                  'button',
                  {
                    className: 'dshjev-btn',
                    type: 'button',
                    disabled: busy || !dirty || view === null,
                    onClick: () =>
                      setDraft({
                        enabled: view.value.enabled !== false,
                        provider: view.value.provider ?? 'typesafe',
                        model: view.value.model ?? '',
                        baseUrl: view.value.baseUrl ?? '',
                        nativeProvider: view.value.nativeProvider ?? '',
                        reasoningEffort: view.value.reasoningEffort ?? '',
                      }),
                  },
                  'Discard',
                ),
                h(
                  'button',
                  { className: 'dshjev-btn', type: 'button', disabled: busy || dirty, onClick: runTest },
                  'Test connection',
                ),
                h(
                  'button',
                  { className: 'dshjev-btn', type: 'button', disabled: busy, onClick: () => void load() },
                  'Reload',
                ),
              ),
            )
          : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      adoptStyles()
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            label: 'JEV',
            order: 31,
            inject: () => ({}),
          },
          () => h(JevCard, { expanded: true }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
