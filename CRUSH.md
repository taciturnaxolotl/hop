# Project: Hop

Cloudflare Workers project built with Bun.

## Stack

- **Runtime**: Cloudflare Workers
- **Package Manager**: Bun
- **Language**: TypeScript

## Commands

```sh
bun run dev      # Start local dev server (wrangler dev)
bun run deploy   # Deploy to Cloudflare
bun run types    # Generate Cloudflare Workers types
bun test         # Run tests
```

## Architecture

- Worker entry point: `src/index.ts`
- Configuration: `wrangler.toml`
- Compatibility date: `2024-12-11`

## Bun Preferences

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Bun APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

**Note**: When building for Cloudflare Workers, use Web Standard APIs (Request, Response, fetch) instead of Bun-specific APIs, as they won't be available in the Workers runtime.

## Cloudflare Workers Development

Workers use the standard Fetch API handler:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response('Hello World');
  },
} satisfies ExportedHandler<Env>;
```

### Environment Variables

Define bindings in `wrangler.toml` and access via the `env` parameter:

```toml
[vars]
MY_VAR = "value"

[[kv_namespaces]]
binding = "MY_KV"
id = "..."
```

```ts
interface Env {
  MY_VAR: string;
  MY_KV: KVNamespace;
}
```

### Testing

Use `bun test` with Cloudflare Workers types:

```ts
import { test, expect } from "bun:test";

test("worker responds", async () => {
  const request = new Request("http://localhost/");
  const response = await worker.fetch(request, {}, {});
  expect(response.status).toBe(200);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
