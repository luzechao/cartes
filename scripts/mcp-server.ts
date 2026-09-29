/**
 * Run the cartes MCP server over stdio:
 *
 *   npm run mcp
 *
 * Register it with an MCP client as a command, e.g. `npx tsx scripts/mcp-server.ts`, run from the
 * repository root (the IDD table is generated there by `npm run setup`).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCartesServer } from '../src/mcp/server.js'

await createCartesServer().connect(new StdioServerTransport())
