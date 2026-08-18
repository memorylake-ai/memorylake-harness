/**
 * `memory_setup` — the only tool offered when the plugin is installed but not
 * configured.
 *
 * Its existence is the fix for a specific failure: in opencode a plugin is
 * only present because the user explicitly added it, so a plugin that stays
 * completely silent until configured is indistinguishable from a broken one.
 * The other harnesses can arrive as part of a bundle and are right to stay
 * quiet; here, installation is the opt-in.
 */

import { tool } from '@opencode-ai/plugin'

import { SETUP_INSTRUCTIONS } from '../setup.js'

const DESCRIPTION = `Set up Memory Lake, the long-term memory backend for this plugin. It is installed but not yet configured, so no memory is available until this runs.

Call this when the user asks to set up, configure, connect, or enable memory — or when they ask why memory is not working.

Returns a checklist to work through with the user; it does not perform the setup by itself.`

/**
 * Build the `memory_setup` tool.
 * @returns the tool definition to register.
 */
export function setupTool() {
  return tool({
    description: DESCRIPTION,
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: 'Memory Lake setup' })
      return SETUP_INSTRUCTIONS
    },
  })
}
