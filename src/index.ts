import { nanoid } from 'nanoid';
import indexHTML from './index.html';

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/' && request.method === 'GET') {
			return new Response(indexHTML, {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		if (url.pathname === '/api/urls' && request.method === 'GET') {
			const list = await env.HOP.list();
			const urls = await Promise.all(
				list.keys.map(async (key) => ({
					shortCode: key.name,
					url: await env.HOP.get(key.name),
					created: key.metadata?.created || Date.now(),
				}))
			);
			return new Response(JSON.stringify(urls), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.pathname.startsWith('/api/urls/') && request.method === 'PUT') {
			const shortCode = url.pathname.split('/')[3];
			try {
				const { url: newUrl } = await request.json();
				
				if (!newUrl) {
					return new Response(JSON.stringify({ error: 'URL is required' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				const existing = await env.HOP.get(shortCode);
				if (!existing) {
					return new Response(JSON.stringify({ error: 'Short URL not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				const metadata = await env.HOP.getWithMetadata(shortCode);
				await env.HOP.put(shortCode, newUrl, {
					metadata: metadata.metadata || { created: Date.now() },
				});

				return new Response(JSON.stringify({ shortCode, url: newUrl }), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: 'Invalid request' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		if (url.pathname.startsWith('/api/urls/') && request.method === 'DELETE') {
			const shortCode = url.pathname.split('/')[3];
			
			const existing = await env.HOP.get(shortCode);
			if (!existing) {
				return new Response(JSON.stringify({ error: 'Short URL not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			await env.HOP.delete(shortCode);

			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.pathname === '/api/shorten' && request.method === 'POST') {
			try {
				const { url: targetUrl, slug } = await request.json();

				if (!targetUrl) {
					return new Response(JSON.stringify({ error: 'URL is required' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				const shortCode = slug || generateShortCode();
				const existing = await env.HOP.get(shortCode);

				if (existing) {
					return new Response(JSON.stringify({ error: 'Slug already exists' }), {
						status: 409,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				await env.HOP.put(shortCode, targetUrl, {
					metadata: { created: Date.now() },
				});

				return new Response(JSON.stringify({ shortCode, url: targetUrl }), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: 'Invalid request' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		const shortCode = url.pathname.slice(1);
		if (shortCode && !shortCode.startsWith('api/')) {
			const targetUrl = await env.HOP.get(shortCode);

			if (targetUrl) {
				return Response.redirect(targetUrl, 302);
			}

			return new Response('Short URL not found', {
				status: 404,
				headers: { 'Content-Type': 'text/plain' },
			});
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

function generateShortCode(): string {
	return nanoid(6);
}

interface Env {
	HOP: KVNamespace;
}
