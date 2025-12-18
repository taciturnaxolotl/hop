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

		const isRedirect = url.pathname.startsWith('/h/');
		if (isRedirect) {
			const shortCode = url.pathname.slice(3);
			const targetUrl = await env.HOP.get(shortCode);

			if (targetUrl) {
				return Response.redirect(targetUrl, 302);
			}

			return new Response(notFoundHTML, {
				status: 404,
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// OAuth initiation endpoint
		if (url.pathname === '/api/login' && request.method === 'GET') {
			const state = nanoid(32);
			const codeVerifier = generateCodeVerifier();
			const codeChallenge = await generateCodeChallenge(codeVerifier);

			// Store state and verifier in KV
			await env.HOP.put(`oauth:${state}`, JSON.stringify({ codeVerifier }), {
				expirationTtl: 600, // 10 minutes
			});

			// Build redirect URI from HOST env var or request origin
			const redirectUri = env.HOST 
				? `${env.HOST}/api/callback`
				: new URL('/api/callback', request.url).toString();
			console.log('OAuth initiation - redirect URI:', redirectUri);

			const authUrl = new URL('/auth/authorize', env.INDIKO_URL);
			authUrl.searchParams.set('response_type', 'code');
			authUrl.searchParams.set('client_id', env.INDIKO_CLIENT_ID);
			authUrl.searchParams.set('redirect_uri', redirectUri);
			authUrl.searchParams.set('state', state);
			authUrl.searchParams.set('code_challenge', codeChallenge);
			authUrl.searchParams.set('code_challenge_method', 'S256');
			authUrl.searchParams.set('scope', 'profile email');

			return Response.redirect(authUrl.toString(), 302);
		}

		// OAuth callback endpoint
		if (url.pathname === '/api/callback' && request.method === 'GET') {
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');

			if (!code || !state) {
				return Response.redirect(new URL('/login?error=missing_params', request.url).toString(), 302);
			}

			// Retrieve and verify state
			const oauthData = await env.HOP.get(`oauth:${state}`);
			if (!oauthData) {
				return Response.redirect(new URL('/login?error=invalid_state', request.url).toString(), 302);
			}

			const { codeVerifier } = JSON.parse(oauthData);
			await env.HOP.delete(`oauth:${state}`);

			// Exchange code for token
			try {
				// Build redirect URI from HOST env var or request origin
				const redirectUri = env.HOST 
					? `${env.HOST}/api/callback`
					: new URL('/api/callback', request.url).toString();
				console.log('Token exchange - redirect URI:', redirectUri);

				const tokenUrl = new URL('/auth/token', env.INDIKO_URL);
				const tokenBody = new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					client_id: env.INDIKO_CLIENT_ID,
					client_secret: env.INDIKO_CLIENT_SECRET,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				});

				const tokenResponse = await fetch(tokenUrl.toString(), {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: tokenBody.toString(),
				});

				if (!tokenResponse.ok) {
					const errorText = await tokenResponse.text();
					console.error('Token exchange failed:', tokenResponse.status, errorText);
					return Response.redirect(new URL('/login?error=token_exchange_failed', request.url).toString(), 302);
				}

				const tokenData = await tokenResponse.json();

				// Check if user has admin role
				if (tokenData.role !== 'admin') {
					return Response.redirect(new URL('/login?error=unauthorized_role', request.url).toString(), 302);
				}

				// Generate session token
				const sessionToken = nanoid(32);
				const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

				// Store session with user profile
				await env.HOP.put(
					`session:${sessionToken}`,
					JSON.stringify({
						expiresAt,
						profile: tokenData.profile,
						me: tokenData.me,
						role: tokenData.role,
					}),
					{ expirationTtl: 86400 } // 24 hours
				);

				// Redirect to main app with session token
				const redirectUrl = new URL('/', request.url);
				redirectUrl.searchParams.set('token', sessionToken);
				return Response.redirect(redirectUrl.toString(), 302);
			} catch (error) {
				return Response.redirect(new URL('/login?error=unknown', request.url).toString(), 302);
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
			if (!authHeader) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Check for API key authentication
			if (authHeader.startsWith('Bearer ')) {
				const token = authHeader.slice(7);
				
				// Check if it's an API key
				if (token === env.API_KEY) {
					// Valid API key, continue
				} else {
					// Check if it's a session token
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
			} else {
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
					.filter(key => !key.name.startsWith('session:') && !key.name.startsWith('oauth:'))
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

function generateCodeVerifier(): string {
	return nanoid(64);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(buffer: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < buffer.byteLength; i++) {
		binary += String.fromCharCode(buffer[i]);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

interface Env {
	HOP: KVNamespace;
	API_KEY: string;
	HOST?: string;
	INDIKO_URL: string;
	INDIKO_CLIENT_ID: string;
	INDIKO_CLIENT_SECRET: string;
}
