import { CodeServerAdapter } from './adapter.mjs'

const instance = Symbol.for('magpie.agent-code-server.adapter.v1')

export default async function CodeServerPlugin(input) {
  if (!globalThis[instance]) {
    const log = msg => {
      try {
        void input?.client?.app?.log?.({
          body: { service: 'code-server-agent', level: 'info', message: msg }
        })?.catch?.(() => {})
      } catch {}
    }
    const adapter = await new CodeServerAdapter({ log }).start()
    globalThis[instance] = adapter

    // On process exit, synchronously restore original configuration if still active.
    // Never install SIGINT/SIGTERM handlers in shared host.
    process.once('exit', () => adapter.restoreOnExit())
  }
  return {}
}
