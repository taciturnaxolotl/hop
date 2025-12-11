import { nanoid } from 'nanoid';
import indexHTML from './index.html';
import loginHTML from './login.html';
import notFoundHTML from './404.html';

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Public routes that don't require auth
		if (url.pathname === '/login' && request.method === 'GET') {
			return new Response(loginHTML, {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		const isRedirect = url.pathname !== '/' && !url.pathname.startsWith('/api/');
		if (isRedirect) {
			const shortCode = url.pathname.slice(1);
			const targetUrl = await env.HOP.get(shortCode);

			if (targetUrl) {
				return Response.redirect(targetUrl, 302);
			}

			return new Response(notFoundHTML, {
				status: 404,
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// Login endpoint
		if (url.pathname === '/api/login' && request.method === 'POST') {
			try {
				const { password } = await request.json();

				if (password !== env.AUTH_PASSWORD) {
					return new Response(JSON.stringify({ error: 'Invalid password' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				// Generate session token
				const token = await generateSessionToken();
				const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

				// Store session in KV
				await env.HOP.put(`session:${token}`, JSON.stringify({ expiresAt }), {
					expirationTtl: 86400, // 24 hours
				});

				return new Response(JSON.stringify({ token }), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: 'Invalid request' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		// Logout endpoint
		if (url.pathname === '/api/logout' && request.method === 'POST') {
			const authHeader = request.headers.get('Authorization');
			if (authHeader && authHeader.startsWith('Bearer ')) {
				const token = authHeader.slice(7);
				await env.HOP.delete(`session:${token}`);
			}
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Check auth for all other routes (except / which needs to load first)
		if (url.pathname !== '/') {
			const authHeader = request.headers.get('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const token = authHeader.slice(7);
			const sessionData = await env.HOP.get(`session:${token}`);

			if (!sessionData) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const session = JSON.parse(sessionData);
			if (session.expiresAt < Date.now()) {
				await env.HOP.delete(`session:${token}`);
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		if (url.pathname === '/' && request.method === 'GET') {
			return new Response(indexHTML, {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		if (url.pathname === '/api/urls' && request.method === 'GET') {
			const searchParams = url.searchParams;
			const limit = parseInt(searchParams.get('limit') || '100');
			const cursor = searchParams.get('cursor') || undefined;
			const search = searchParams.get('search') || '';

			const listOptions: KVNamespaceListOptions = {
				limit: Math.min(limit, 1000),
				cursor,
			};

			const list = await env.HOP.list(listOptions);
			
			// Clean up expired sessions in background
			const now = Date.now();
			const sessionKeys = list.keys.filter(key => key.name.startsWith('session:'));
			for (const key of sessionKeys) {
				const sessionData = await env.HOP.get(key.name);
				if (sessionData) {
					try {
						const session = JSON.parse(sessionData);
						if (session.expiresAt < now) {
							ctx.waitUntil(env.HOP.delete(key.name));
						}
					} catch (e) {
						// Invalid session data, delete it
						ctx.waitUntil(env.HOP.delete(key.name));
					}
				}
			}
			
			let urls = await Promise.all(
				list.keys
					.filter(key => !key.name.startsWith('session:'))
					.map(async (key) => ({
						shortCode: key.name,
						url: await env.HOP.get(key.name),
						created: key.metadata?.created || Date.now(),
					}))
			);

			// Filter by search term if provided
			if (search) {
				const searchLower = search.toLowerCase();
				urls = urls.filter(item => 
					item.shortCode.toLowerCase().includes(searchLower) ||
					item.url?.toLowerCase().includes(searchLower)
				);
			}

			return new Response(JSON.stringify({
				urls,
				cursor: list.list_complete ? null : list.cursor,
				hasMore: !list.list_complete,
			}), {
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

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

function generateShortCode(): string {
	return nanoid(6);
}

async function generateSessionToken(): Promise<string> {
	return nanoid(32);
}

interface Env {
	HOP: KVNamespace;
	AUTH_PASSWORD: string;
}
