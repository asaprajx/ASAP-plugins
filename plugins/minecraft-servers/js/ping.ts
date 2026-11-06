import type { MinecraftServer, ServerStatusData } from './types'

function nowMs(): number {
	try {
		return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
	} catch {
		return Date.now()
	}
}

function fetchTimed(url: string, ms: number): Promise<{ dt: number; timeout?: boolean; answered?: boolean; error?: string }> {
	return new Promise((resolve) => {
		let done = false
		const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
		const t0 = nowMs()
		const timer = setTimeout(() => {
			if (done) return
			done = true
			try { ctl?.abort() } catch {}
			resolve({ dt: ms, timeout: true })
		}, ms)

		try {
			fetch(url, { method: 'GET', signal: ctl?.signal }).then(
				() => {
					if (done) return
					done = true
					clearTimeout(timer)
					resolve({ dt: nowMs() - t0, answered: true })
				},
				(e) => {
					if (done) return
					done = true
					clearTimeout(timer)
					resolve({ dt: nowMs() - t0, error: String(e?.message || e) })
				},
			)
		} catch (e) {
			done = true
			clearTimeout(timer)
			resolve({ dt: 0, error: String((e as any)?.message || e) })
		}
	})
}

function median(list: number[]): number | null {
	const a = list.slice().sort((x, y) => x - y)
	const n = a.length
	return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null
}

function pingTarget(server: MinecraftServer, data?: ServerStatusData): { host: string; port: number } {
	let host = server.address
	let port = server.port || 25565
	if (data) {
		if (data.port) port = data.port
		const m = /^(.*):(\d+)$/.exec(data.srv || '')
		if (m) {
			host = m[1]
			port = Number(m[2])
		}
		if (data.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(data.ip) && !m) {
			host = data.ip
		}
	}
	return { host, port }
}

export async function measurePing(
	server: MinecraftServer,
	data?: ServerStatusData,
	samplesCount = 4,
	factor = 2,
): Promise<{ ms: number; raw: number; n: number } | { unsupported: boolean } | null> {
	if (server.edition === 'bedrock') return null

	const t = pingTarget(server, data)
	const want = Math.max(2, Math.min(8, Number(samplesCount) || 4))
	const tries = want + 1
	const good: number[] = []
	let unsupported = false

	for (let i = 0; i < tries; i++) {
		if (unsupported) break
		const r = await fetchTimed(`https://${t.host}:${t.port}/?p=${Math.floor(Math.random() * 1e9)}`, 3500)
		if (r.error && /cleartext|not permitted|disallowed/i.test(r.error)) {
			unsupported = true
			break
		}
		if (i > 0 && !r.timeout && !r.answered && r.dt >= 2) {
			good.push(r.dt)
		}
	}

	if (unsupported) return { unsupported: true }
	if (good.length < 2) return null

	const raw = median(good)!
	const calibrated = Math.max(0.5, Math.min(6, factor || 2))
	return {
		ms: Math.max(1, Math.round(raw / calibrated)),
		raw,
		n: good.length,
	}
}
