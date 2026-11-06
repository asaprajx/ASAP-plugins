import type { MinecraftServer, ServerStatusData, PlayerInfo } from './types'

export function parseAddress(text: string, portText?: string | number): { host?: string; port?: number; error?: string } {
	const t = String(text || '')
		.trim()
		.replace(/^[a-z]+:\/\//i, '')
		.replace(/\/.*$/, '')
		.replace(/\s+/g, '')

	if (!t) return { error: 'Enter the server address' }

	let host = t
	let port = 0
	const m = /^(.*):(\d{1,5})$/.exec(t)
	if (m) {
		host = m[1]
		port = Number(m[2])
	}

	if (portText !== undefined && String(portText).trim() !== '') {
		const p = Number(String(portText).trim())
		if (!(p >= 1 && p <= 65535)) return { error: 'The port must be a number from 1 to 65535' }
		port = p
	}

	if (port && (port < 1 || port > 65535)) return { error: 'The port must be a number from 1 to 65535' }
	host = host.toLowerCase()

	if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(host) || host.length > 253) {
		return { error: 'That does not look like a server address' }
	}

	return { host, port }
}

export function formatAddress(server: Pick<MinecraftServer, 'address' | 'port'>): string {
	return server.address + (server.port ? `:${server.port}` : '')
}

export function cleanMotd(value: any): string {
	let text = Array.isArray(value)
		? value.join('\n')
		: value && typeof value === 'object'
			? value.clean || value.raw || ''
			: String(value || '')
	if (Array.isArray(text)) text = text.join('\n')
	return String(text)
		.replace(/§./g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

export function splitVersion(name?: string, software?: string): { version: string; software: string } {
	const out = { version: name || '', software: software || '' }
	const m = /^([A-Za-z][A-Za-z0-9 _.-]*?)[\s/]+(\d+\.\d+.*)$/.exec(String(name || ''))
	if (m && !out.software) {
		out.software = m[1].trim()
		out.version = m[2].trim()
	} else if (m && out.software && m[1].trim().toLowerCase() === out.software.toLowerCase()) {
		out.version = m[2].trim()
	}
	return out
}

export function createBaseStatus(server: MinecraftServer, extra: Partial<ServerStatusData> = {}): ServerStatusData {
	return {
		online: false,
		host: server.address,
		ip: '',
		port: server.port || (server.edition === 'bedrock' ? 19132 : 25565),
		version: '',
		protocol: null,
		software: '',
		gamemode: '',
		srv: '',
		eula: false,
		players: { online: 0, max: 0, list: [] },
		motd: '',
		icon: '',
		ping: null,
		plugins: [],
		mods: [],
		via: [],
		error: '',
		...extra,
	}
}

export function filterRealPlayers(list: PlayerInfo[] = [], edition: 'java' | 'bedrock'): { list: PlayerInfo[]; hidden: number } {
	const re = edition === 'bedrock' ? /^[A-Za-z0-9 _.'\-]{1,32}$/ : /^[A-Za-z0-9_]{1,16}$/
	const seen = new Set<string>()
	const out: PlayerInfo[] = []
	let hidden = 0

	for (const p of list) {
		const n = p && typeof p.name === 'string' ? p.name.trim() : ''
		if (!re.test(n) || n.includes('§')) {
			hidden++
			continue
		}
		const key = n.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(p)
	}

	return { list: out, hidden }
}

export function mergeStatus(primary: ServerStatusData, others: (ServerStatusData | null | undefined)[]): ServerStatusData {
	const out = { ...primary }
	for (const o of others) {
		if (!o) continue
		if (out.ping === null && o.ping !== null) out.ping = o.ping
		if (!out.ip && o.ip) out.ip = o.ip
		if (!out.software && o.software) out.software = o.software
		if (!out.version && o.version) out.version = o.version
		if (!out.icon && o.icon) out.icon = o.icon
		if (!out.motd && o.motd) out.motd = o.motd
		if (!out.gamemode && o.gamemode) out.gamemode = o.gamemode
		if (!out.srv && o.srv) out.srv = o.srv
		if (o.eula) out.eula = true
		if (!out.players.list.length && o.players.list.length) {
			out.players = { ...out.players, list: o.players.list }
		}
		if (!out.plugins?.length && o.plugins?.length) out.plugins = o.plugins
		if (!out.mods?.length && o.mods?.length) out.mods = o.mods
		if (o.via) {
			out.via = Array.from(new Set([...(out.via || []), ...o.via]))
		}
	}
	return out
}

function timeoutFetch(url: string, seconds: number): Promise<any> {
	return new Promise((resolve, reject) => {
		let done = false
		const controller = typeof AbortController === 'function' ? new AbortController() : null
		const timer = setTimeout(() => {
			if (done) return
			done = true
			try { controller?.abort() } catch {}
			reject(new Error(`No answer after ${seconds} seconds`))
		}, seconds * 1000)

		fetch(url, controller ? { signal: controller.signal, headers: { Accept: 'application/json' } } : { headers: { Accept: 'application/json' } }).then(
			(res) => {
				if (done) return
				if (!res.ok) {
					done = true
					clearTimeout(timer)
					return reject(new Error(`The status site said ${res.status}`))
				}
				return res.json().then(
					(json) => {
						if (done) return
						done = true
						clearTimeout(timer)
						resolve(json)
					},
					() => {
						if (done) return
						done = true
						clearTimeout(timer)
						reject(new Error('The status site sent unreadable data'))
					},
				)
			},
			(e) => {
				if (done) return
				done = true
				clearTimeout(timer)
				reject(new Error(`Could not reach status site (${String(e?.message || e).slice(0, 40)})`))
			},
		)
	})
}

function targetParam(server: MinecraftServer): string {
	return encodeURIComponent(server.address + (server.port ? `:${server.port}` : ''))
}

export const PROVIDERS = {
	mcstatus: {
		label: 'mcstatus.io',
		get: async (server: MinecraftServer, seconds: number): Promise<ServerStatusData> => {
			const kind = server.edition === 'bedrock' ? 'bedrock' : 'java'
			const j = await timeoutFetch(`https://api.mcstatus.io/v2/status/${kind}/${targetParam(server)}`, seconds)
			const v = j?.version
			const name = v ? v.name_clean || v.name_raw || v.name || '' : ''
			const s = splitVersion(name, j?.software)
			return createBaseStatus(server, {
				online: !!j?.online,
				retrievedAt: j?.retrieved_at || 0,
				ip: j?.ip_address || '',
				port: j?.port,
				version: s.version,
				software: s.software,
				srv: j?.srv_record?.host ? `${j.srv_record.host}:${j.srv_record.port}` : '',
				eula: !!j?.eula_blocked,
				protocol: v?.protocol ?? null,
				gamemode: j?.gamemode || '',
				players: {
					online: j?.players?.online || 0,
					max: j?.players?.max || 0,
					list: ((j?.players?.list) || [])
						.map((p: any) => ({ name: p.name_clean || p.name_raw || p.name, id: p.uuid || p.id }))
						.filter((p: any) => p.name),
				},
				motd: cleanMotd(j?.motd),
				icon: j?.icon || '',
				plugins: (j?.plugins || []).map((p: any) => p.name + (p.version ? ` ${p.version}` : '')),
				mods: (j?.mods || []).map((p: any) => p.name + (p.version ? ` ${p.version}` : '')),
				via: ['mcstatus.io'],
			})
		},
	},
	mcsrvstat: {
		label: 'mcsrvstat.us',
		get: async (server: MinecraftServer, seconds: number): Promise<ServerStatusData> => {
			const prefix = server.edition === 'bedrock' ? 'bedrock/3/' : '3/'
			const j = await timeoutFetch(`https://api.mcsrvstat.us/${prefix}${targetParam(server)}`, seconds)
			const name = j?.version ? String(j.version) : ''
			const s = splitVersion(name, j?.software)
			return createBaseStatus(server, {
				online: !!j?.online,
				ip: j?.ip || '',
				port: j?.port,
				version: s.version,
				software: s.software,
				eula: !!j?.eula_blocked,
				protocol: j?.protocol ? j.protocol.version : null,
				gamemode: j?.gamemode || '',
				players: {
					online: j?.players?.online || 0,
					max: j?.players?.max || 0,
					list: ((j?.players?.list) || [])
						.map((p: any) => (typeof p === 'string' ? { name: p } : { name: p.name, id: p.uuid }))
						.filter((p: any) => p.name),
				},
				motd: cleanMotd(j?.motd),
				icon: j?.icon || '',
				plugins: (j?.plugins || []).map((p: any) => (typeof p === 'string' ? p : p.name + (p.version ? ` ${p.version}` : ''))),
				mods: (j?.mods || []).map((p: any) => (typeof p === 'string' ? p : p.name + (p.version ? ` ${p.version}` : ''))),
				via: ['mcsrvstat.us'],
			})
		},
	},
	minetools: {
		label: 'minetools.eu',
		get: async (server: MinecraftServer, seconds: number): Promise<ServerStatusData> => {
			if (server.edition === 'bedrock') {
				throw new Error('minetools.eu only supports Java servers')
			}
			const j = await timeoutFetch(`https://api.minetools.eu/ping/${encodeURIComponent(server.address)}/${server.port || 25565}`, seconds)
			const ok = j && !j.error && j.players
			const name = ok && j.version ? j.version.name || '' : ''
			const s = splitVersion(name, '')
			return createBaseStatus(server, {
				online: !!ok,
				version: s.version,
				software: s.software,
				protocol: ok && j.version ? j.version.protocol : null,
				players: {
					online: ok ? j.players.online || 0 : 0,
					max: ok ? j.players.max || 0 : 0,
					list: ok
						? ((j.players.sample || []).map((p: any) => ({ name: p.name, id: p.id })).filter((p: any) => p.name))
						: [],
				},
				motd: ok ? cleanMotd(typeof j.description === 'object' && j.description ? j.description.text || j.description : j.description) : '',
				icon: ok ? j.favicon || '' : '',
				ping: ok && typeof j.latency === 'number' ? Math.round(j.latency) : null,
				via: ['minetools.eu'],
			})
		},
	},
}

export async function queryServer(server: MinecraftServer, providerChoice = 'auto', timeoutSeconds = 8, liveCounts = true): Promise<ServerStatusData> {
	if (providerChoice !== 'auto' && (PROVIDERS as any)[providerChoice]) {
		if (providerChoice === 'minetools' && server.edition === 'bedrock') {
			// fallback
		} else {
			try {
				return await (PROVIDERS as any)[providerChoice].get(server, timeoutSeconds)
			} catch (e: any) {
				return createBaseStatus(server, { error: String(e?.message || e), online: false })
			}
		}
	}

	if (server.edition === 'bedrock') {
		try {
			return await PROVIDERS.mcstatus.get(server, timeoutSeconds)
		} catch {
			try {
				return await PROVIDERS.mcsrvstat.get(server, timeoutSeconds)
			} catch (e: any) {
				return createBaseStatus(server, { error: String(e?.message || e), online: false })
			}
		}
	}

	// Java: query minetools (live) and mcstatus (details) concurrently
	const minetoolsPromise = PROVIDERS.minetools.get(server, timeoutSeconds).then(v => ({ ok: true, v }), e => ({ ok: false, e }))
	try {
		const good = await PROVIDERS.mcstatus.get(server, timeoutSeconds)
		const L = await minetoolsPromise
		let first = L.ok ? (L as any).v : null
		const real = /^(.*):(\d+)$/.exec(good.srv || '')
		if (first && !first.online && real) {
			try {
				const again = await PROVIDERS.minetools.get({ ...server, address: real[1], port: Number(real[2]) }, timeoutSeconds)
				first = again
			} catch {}
		}

		if (first && first.online) {
			const merged = mergeStatus(good.online ? good : first, [good.online ? first : good])
			merged.online = true
			if (liveCounts && first.players?.online !== undefined) {
				merged.players = { ...merged.players, online: first.players.online, max: first.players.max || merged.players.max }
				merged.countsFrom = 'live'
			}
			return merged
		}

		if (good.online && first) {
			const merged = mergeStatus(good, [first])
			merged.online = false
			merged.siteConflict = true
			return merged
		}

		if (good.online) return good

		// Fallback to mcsrvstat
		try {
			const fallback = await PROVIDERS.mcsrvstat.get(server, timeoutSeconds)
			return fallback.online ? mergeStatus(fallback, [good]) : good
		} catch {
			return good
		}
	} catch (firstError: any) {
		const L = await minetoolsPromise
		try {
			const fallback = await PROVIDERS.mcsrvstat.get(server, timeoutSeconds)
			const candidates = [L.ok ? (L as any).v : null, fallback].filter(Boolean)
			if (candidates.length) {
				const main = candidates.find(c => c.online) || candidates[0]
				return mergeStatus(main, candidates.filter(c => c !== main))
			}
		} catch {}
		return createBaseStatus(server, { error: String(firstError?.message || firstError), online: false })
	}
}
