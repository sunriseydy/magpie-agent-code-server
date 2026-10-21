import { test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agent, connect } from './code-server.agent.js'
import { CodeServerAdapter } from './adapter.mjs'
import { parseJSONC, stripJsonComments } from './jsonc.mjs'

test('agent descriptor and connect hook adhere to contract', () => {
  expect(agent.id).toBe('code-server')
  expect(agent.name).toBe('code-server')
  expect(agent.model).toBe('model')
  expect(agent.format).toBe('json')
  expect(agent.config).toBe('~/.config/magpie-code-server/connection.json')

  const res = connect({
    gateway: { url: 'http://127.0.0.1:4096', v1: 'http://127.0.0.1:4096/v1', key: 'magpie-code-server' },
    model: { id: 'deepseek/deepseek-chat' },
    models: [{ id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', context: 64000, output: 4096 }],
  })

  expect(res.enabled).toBe(true)
  expect(res['gateway.v1']).toBe('http://127.0.0.1:4096/v1')
  expect(res['gateway.key']).toBe('magpie-code-server')
  expect(res.models).toHaveLength(1)
})

test('JSONC parser strips single and multi-line comments and trailing commas', () => {
  const jsonc = `
  {
    // comment
    "key": "value", /* inline */
    "arr": [1, 2, ],
  }
  `
  const parsed = parseJSONC(jsonc)
  expect(parsed.key).toBe('value')
  expect(parsed.arr).toEqual([1, 2])
})

async function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'))
  const codeServerDir = path.join(tmpDir, 'code-server')
  const stateDir = path.join(tmpDir, 'state')
  const userDir = path.join(codeServerDir, 'User')

  fs.mkdirSync(userDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })

  const adapter = new CodeServerAdapter({
    home: tmpDir,
    codeServerDir,
    stateDir,
    intervalMs: 100000,
  })

  return {
    tmpDir,
    codeServerDir,
    stateDir,
    userDir,
    adapter,
    cleanup: async () => {
      await adapter.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

test('adapter writes customendpoint group and defaultModel on connect, and restores on disconnect', async () => {
  const f = await createFixture()
  try {
    const settingsPath = path.join(f.userDir, 'settings.json')
    const modelsPath = path.join(f.userDir, 'chatLanguageModels.json')

    fs.writeFileSync(settingsPath, `{\n  // My user settings\n  "editor.fontSize": 14,\n  "chat.defaultModel": "gpt-4o"\n}\n`)
    fs.writeFileSync(modelsPath, `[\n  {\n    "name": "Ollama",\n    "vendor": "ollama"\n  }\n]\n`)

    const connectionData = {
      enabled: true,
      model: 'relay/glm-4',
      gateway: { v1: 'http://127.0.0.1:4096/v1', key: 'magpie-code-server' },
      models: [
        { id: 'relay/glm-4', name: 'GLM 4', context: 128000, output: 8192, efforts: ['high', 'medium'] }
      ]
    }
    fs.writeFileSync(f.adapter.connectionFile, JSON.stringify(connectionData, null, 2))

    await f.adapter.tick()

    // 1. Verify settings.json
    const settings = parseJSONC(fs.readFileSync(settingsPath, 'utf8'))
    expect(settings['chat.defaultModel']).toBe('relay/glm-4')
    expect(settings['editor.fontSize']).toBe(14)

    // 2. Verify chatLanguageModels.json
    const models = parseJSONC(fs.readFileSync(modelsPath, 'utf8'))
    expect(models).toHaveLength(2)
    const magpieGroup = models.find(m => m.name === 'magpie')
    expect(magpieGroup).toBeDefined()
    expect(magpieGroup.vendor).toBe('customendpoint')
    expect(magpieGroup.apiType).toBe('chat-completions')
    expect(magpieGroup.models).toHaveLength(1)
    expect(magpieGroup.models[0].id).toBe('relay/glm-4')
    expect(magpieGroup.models[0].url).toBe('http://127.0.0.1:4096/v1/chat/completions')
    expect(magpieGroup.models[0].requestHeaders.Authorization).toBe('Bearer magpie-code-server')
    expect(magpieGroup.models[0].supportsReasoningEffort).toEqual(['high', 'medium'])

    // 3. Test Disconnect
    fs.writeFileSync(f.adapter.connectionFile, JSON.stringify({ enabled: false }))
    await f.adapter.tick()

    const restoredSettings = parseJSONC(fs.readFileSync(settingsPath, 'utf8'))
    expect(restoredSettings['chat.defaultModel']).toBe('gpt-4o')
    expect(restoredSettings['editor.fontSize']).toBe(14)

    const restoredModels = parseJSONC(fs.readFileSync(modelsPath, 'utf8'))
    expect(restoredModels).toHaveLength(1)
    expect(restoredModels[0].name).toBe('Ollama')
  } finally {
    await f.cleanup()
  }
})

test('adapter detects customoai when extension requires it and adjusts headers and tokens', async () => {
  const f = await createFixture()
  try {
    const extDir = path.join(f.codeServerDir, 'extensions', 'github.copilot-chat-0.48.1')
    fs.mkdirSync(extDir, { recursive: true })
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({
        name: 'copilot-chat',
        version: '0.48.1',
        contributes: {
          languageModelChatProviders: [{ vendor: 'customoai' }]
        }
      })
    )

    const connectionData = {
      enabled: true,
      model: 'relay/glm-4',
      gateway: { v1: 'http://127.0.0.1:4096/v1', key: 'magpie-code-server' },
      models: [
        { id: 'relay/glm-4', name: 'GLM 4', context: 100000, output: 8000 }
      ]
    }
    fs.writeFileSync(f.adapter.connectionFile, JSON.stringify(connectionData, null, 2))

    await f.adapter.tick()

    const models = parseJSONC(fs.readFileSync(path.join(f.userDir, 'chatLanguageModels.json'), 'utf8'))
    const magpieGroup = models.find(m => m.name === 'magpie')
    expect(magpieGroup).toBeDefined()
    expect(magpieGroup.vendor).toBe('customoai')
    expect(magpieGroup.models[0].requestHeaders['x-api-key']).toBe('magpie-code-server')
    expect(magpieGroup.models[0].requestHeaders.Authorization).toBeUndefined()
    expect(magpieGroup.models[0].maxInputTokens).toBe(100000 - 8000)
    expect(magpieGroup.models[0].maxOutputTokens).toBe(8000)
  } finally {
    await f.cleanup()
  }
})

test('adapter synchronizes across all profiles listed in storage.json', async () => {
  const f = await createFixture()
  try {
    const workProfileDir = path.join(f.userDir, 'profiles', 'work-1')
    fs.mkdirSync(workProfileDir, { recursive: true })
    fs.mkdirSync(path.join(f.userDir, 'globalStorage'), { recursive: true })
    fs.writeFileSync(
      path.join(f.userDir, 'globalStorage', 'storage.json'),
      JSON.stringify({
        userDataProfiles: [
          { location: 'work-1', name: 'Work' }
        ]
      })
    )

    const workSettings = path.join(workProfileDir, 'settings.json')
    const workModels = path.join(workProfileDir, 'chatLanguageModels.json')
    fs.writeFileSync(workSettings, `{\n  "chat.defaultModel": "custom-work"\n}\n`)
    fs.writeFileSync(workModels, `[]\n`)

    const connectionData = {
      enabled: true,
      model: 'relay/glm-4',
      gateway: { v1: 'http://127.0.0.1:4096/v1', key: 'magpie-code-server' },
      models: [{ id: 'relay/glm-4', name: 'GLM 4' }]
    }
    fs.writeFileSync(f.adapter.connectionFile, JSON.stringify(connectionData, null, 2))

    await f.adapter.tick()

    // Verify profile updated
    const pSettings = parseJSONC(fs.readFileSync(workSettings, 'utf8'))
    expect(pSettings['chat.defaultModel']).toBe('relay/glm-4')
    const pModels = parseJSONC(fs.readFileSync(workModels, 'utf8'))
    expect(pModels.some(m => m.name === 'magpie')).toBe(true)

    // Disconnect
    fs.writeFileSync(f.adapter.connectionFile, JSON.stringify({ enabled: false }))
    await f.adapter.tick()

    const pRestoredSettings = parseJSONC(fs.readFileSync(workSettings, 'utf8'))
    expect(pRestoredSettings['chat.defaultModel']).toBe('custom-work')
    const pRestoredModels = parseJSONC(fs.readFileSync(workModels, 'utf8'))
    expect(pRestoredModels.some(m => m.name === 'magpie')).toBe(false)
  } finally {
    await f.cleanup()
  }
})
