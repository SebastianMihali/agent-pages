import { definePlugin } from 'nitro'
import { getRuntime } from './runtime'

// Static plugin evaluation must finish before Nitro starts listening.
const runtime = await getRuntime()

export default definePlugin((nitro) => {
  nitro.hooks.hook('close', () => runtime.close())
})
