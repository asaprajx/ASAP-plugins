(function (exports) {
	/*
	 * Minecraft Servers for Valenced.
	 * Save Minecraft servers and look at them: online or not, players, who is playing, ping, software, address.
	 * A phone cannot open the raw connection a Minecraft client uses, so the numbers come from public status
	 * websites (mcstatus.io, mcsrvstat.us, minetools.eu). The addresses you save are sent to them.
	 * Keep `(function` as the first thing in this file: Valenced loads it as `return <file>`.
	 */
	var defaults = {
		serversJson: '[]',
		historyJson: '{}',
		provider: 'auto',
		timeout: 8,
		cacheSeconds: 20,
		refreshSeconds: 0,
		refreshSeconds2: 30,
		compact: false,
		heads: true,
		motd: true,
		icons: true,
		sort: 'manual',
		placement: 'menu',
		alerts: false,
		alertSeconds: 120,
		historyLength: 40,
		pingSource: 'phone',
		liveCounts: true,
		plainScroll: false,
		pingSamples: 4,
		pingFactor: 2,
	}
	var SHEET_KEY = 'marklong.minecraft-servers.panel'
	var GREEN = '#23a55a'
	var RED = '#f23f43'
	var AMBER = '#f0b232'
	var GRAY = '#80848e'
	var BLURPLE = '#5865f2'
	var BUTTON_SIZE = 40

	var storage
	var listeners = []
	var results = {} // server id -> { state: 'loading' | 'done', data, at }
	var inflight = {}
	var lastOnline = {} // for the alerts
	var timers = []
	var status = { button: 'not seen yet. Tap + next to the message box.', alerts: 'off', error: '' }

	function finders() { return valenced.modules.finders }
	function setting(key) {
		var s = storage && storage.cache
		return s && s[key] !== undefined ? s[key] : defaults[key]
	}
	function changed() { listeners.slice().forEach(function (l) { try { l() } catch (e) {} }) }
	function toast(text) {
		try { valenced.discord.actions.ToastActionCreators.open('MARKLONG_MC_SERVERS', { text: String(text) }) } catch (e) {}
	}
	function h(type, props) {
		var children = Array.prototype.slice.call(arguments, 2)
		var rt = valenced.react.ReactJSXRuntime
		var p = Object.assign({}, props)
		var key = p.key
		delete p.key
		if (children.length === 1) p.children = children[0]
		else if (children.length > 1) p.children = children
		return (children.length > 1 ? rt.jsxs : rt.jsx)(type, p, key)
	}
	function parse(text, fallback) {
		try { var v = JSON.parse(text); return v === null || v === undefined ? fallback : v } catch (e) { return fallback }
	}
	function errorText(e) { return String((e && e.message) || e) }
	function copy(text, what) {
		try { valenced.externals.ReactNativeClipboard.Clipboard.setString(text); toast((what || 'Text') + ' copied') } catch (e) { toast('Could not copy') }
	}
	function color(token, fallback) {
		try { return valenced.discord.common.tokens.Tokens.default.colors[token] || fallback } catch (e) { return fallback }
	}

	// ======================================================================================
	// What is saved
	// ======================================================================================
	function servers() {
		var list = parse(setting('serversJson'), [])
		return Array.isArray(list) ? list.filter(function (s) { return s && typeof s.id === 'string' && typeof s.address === 'string' }) : []
	}
	function history() {
		var map = parse(setting('historyJson'), {})
		return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
	}
	function save(patch) {
		try { if (storage && typeof storage.set === 'function') storage.set(patch) } catch (e) {}
		try { if (storage && storage.cache) Object.assign(storage.cache, patch) } catch (e) {}
	}
	function saveServers(list) {
		save({ serversJson: JSON.stringify(list) })
		changed()
	}
	function saveHistory(map) { save({ historyJson: JSON.stringify(map) }) }
	function serverById(id) { return servers().filter(function (s) { return s.id === id })[0] }
	function newId() { return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36) }

	/** "mc.example.com:25566", "minecraft://mc.example.com" and "MC.EXAMPLE.COM/" all become a host and a port. */
	function parseAddress(text, portText) {
		var t = String(text || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/\s+/g, '')
		if (!t) return { error: 'Enter the server address' }
		var host = t
		var port = 0
		var m = /^(.*):(\d{1,5})$/.exec(t)
		if (m) { host = m[1]; port = Number(m[2]) }
		if (portText !== undefined && String(portText).trim() !== '') {
			var p = Number(String(portText).trim())
			if (!(p >= 1 && p <= 65535)) return { error: 'The port must be a number from 1 to 65535' }
			port = p
		}
		if (port && (port < 1 || port > 65535)) return { error: 'The port must be a number from 1 to 65535' }
		host = host.toLowerCase()
		if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(host) || host.length > 253) return { error: 'That does not look like a server address' }
		return { host: host, port: port }
	}
	function addressText(server) {
		return server.address + (server.port ? ':' + server.port : '')
	}

	// ======================================================================================
	// Asking the status websites
	// ======================================================================================
	function timeoutFetch(url, seconds) {
		return new Promise(function (resolve, reject) {
			var done = false
			var controller = typeof AbortController === 'function' ? new AbortController() : null
			var timer = setTimeout(function () {
				if (done) return
				done = true
				try { if (controller) controller.abort() } catch (e) {}
				reject(new Error('No answer after ' + seconds + ' seconds'))
			}, seconds * 1000)
			fetch(url, controller ? { signal: controller.signal, headers: { Accept: 'application/json' } } : { headers: { Accept: 'application/json' } }).then(
				function (res) {
					if (done) return
					if (!res.ok) { done = true; clearTimeout(timer); return reject(new Error('The status site said ' + res.status)) }
					return res.json().then(
						function (json) { if (done) return; done = true; clearTimeout(timer); resolve(json) },
						function () { if (done) return; done = true; clearTimeout(timer); reject(new Error('The status site sent something unreadable')) },
					)
				},
				function (e) { if (done) return; done = true; clearTimeout(timer); reject(new Error('Could not reach the status site (' + errorText(e).slice(0, 40) + ')')) },
			)
		})
	}

	function cleanMotd(value) {
		var text = Array.isArray(value) ? value.join('\n') : value && typeof value === 'object' ? value.clean || value.raw || '' : String(value || '')
		if (Array.isArray(text)) text = text.join('\n')
		return String(text).replace(/§./g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
	}

	/** "Paper 1.20.4" is split into the software and the version. */
	function splitVersion(name, software) {
		var out = { version: name || '', software: software || '' }
		var m = /^([A-Za-z][A-Za-z0-9 _.-]*?)[\s/]+(\d+\.\d+.*)$/.exec(String(name || ''))
		if (m && !out.software) { out.software = m[1].trim(); out.version = m[2].trim() }
		else if (m && out.software && m[1].trim().toLowerCase() === out.software.toLowerCase()) out.version = m[2].trim()
		return out
	}

	function base(server, extra) {
		return Object.assign({ online: false, host: server.address, ip: '', port: server.port || (server.edition === 'bedrock' ? 19132 : 25565), version: '', protocol: null, software: '', gamemode: '', srv: '', eula: false, players: { online: 0, max: 0, list: [] }, motd: '', icon: '', ping: null, plugins: [], mods: [], via: [], error: '' }, extra || {})
	}

	function fromMcstatus(server, j) {
		var v = j && j.version
		var name = v ? v.name_clean || v.name_raw || v.name || '' : ''
		var s = splitVersion(name, j && j.software)
		return base(server, {
			online: !!(j && j.online), retrievedAt: (j && j.retrieved_at) || 0, ip: (j && j.ip_address) || '', port: (j && j.port) || undefined, version: s.version, software: s.software,
			srv: j && j.srv_record && j.srv_record.host ? j.srv_record.host + ':' + j.srv_record.port : '', eula: !!(j && j.eula_blocked),
			protocol: v && v.protocol !== undefined ? v.protocol : null, gamemode: (j && j.gamemode) || '',
			players: { online: j && j.players ? j.players.online || 0 : 0, max: j && j.players ? j.players.max || 0 : 0, list: ((j && j.players && j.players.list) || []).map(function (p) { return { name: p.name_clean || p.name_raw || p.name, id: p.uuid || p.id } }).filter(function (p) { return p.name }) },
			motd: cleanMotd(j && j.motd), icon: (j && j.icon) || '',
			plugins: ((j && j.plugins) || []).map(function (p) { return p.name + (p.version ? ' ' + p.version : '') }),
			mods: ((j && j.mods) || []).map(function (p) { return p.name + (p.version ? ' ' + p.version : '') }), via: ['mcstatus.io'],
		})
	}
	function fromMcsrvstat(server, j) {
		var name = j && j.version ? String(j.version) : ''
		var s = splitVersion(name, j && j.software)
		return base(server, {
			online: !!(j && j.online), ip: (j && j.ip) || '', port: (j && j.port) || undefined, version: s.version, software: s.software, eula: !!(j && j.eula_blocked),
			protocol: j && j.protocol ? j.protocol.version : null, gamemode: (j && j.gamemode) || '',
			players: { online: j && j.players ? j.players.online || 0 : 0, max: j && j.players ? j.players.max || 0 : 0, list: ((j && j.players && j.players.list) || []).map(function (p) { return typeof p === 'string' ? { name: p } : { name: p.name, id: p.uuid } }).filter(function (p) { return p.name }) },
			motd: cleanMotd(j && j.motd), icon: (j && j.icon) || '',
			plugins: ((j && j.plugins) || []).map(function (p) { return typeof p === 'string' ? p : p.name + (p.version ? ' ' + p.version : '') }),
			mods: ((j && j.mods) || []).map(function (p) { return typeof p === 'string' ? p : p.name + (p.version ? ' ' + p.version : '') }), via: ['mcsrvstat.us'],
		})
	}
	function fromMinetools(server, j) {
		var ok = j && !j.error && j.players
		var name = ok && j.version ? j.version.name || '' : ''
		var s = splitVersion(name, '')
		return base(server, {
			online: !!ok, version: s.version, software: s.software, protocol: ok && j.version ? j.version.protocol : null,
			players: { online: ok ? j.players.online || 0 : 0, max: ok ? j.players.max || 0 : 0, list: ok ? (j.players.sample || []).map(function (p) { return { name: p.name, id: p.id } }).filter(function (p) { return p.name }) : [] },
			motd: ok ? cleanMotd(typeof j.description === 'object' && j.description ? j.description.text || j.description : j.description) : '', icon: ok ? j.favicon || '' : '',
			ping: ok && typeof j.latency === 'number' ? Math.round(j.latency) : null, via: ['minetools.eu'],
		})
	}

	function target(server) { return encodeURIComponent(server.address + (server.port ? ':' + server.port : '')) }
	var PROVIDERS = {
		mcstatus: {
			label: 'mcstatus.io',
			get: function (server, seconds) {
				var kind = server.edition === 'bedrock' ? 'bedrock' : 'java'
				return timeoutFetch('https://api.mcstatus.io/v2/status/' + kind + '/' + target(server) + '?_ts=' + Date.now(), seconds).then(function (j) { return fromMcstatus(server, j) })
			},
		},
		mcsrvstat: {
			label: 'mcsrvstat.us',
			get: function (server, seconds) {
				var prefix = server.edition === 'bedrock' ? 'bedrock/3/' : '3/'
				return timeoutFetch('https://api.mcsrvstat.us/' + prefix + target(server) + '?_ts=' + Date.now(), seconds).then(function (j) { return fromMcsrvstat(server, j) })
			},
		},
		minetools: {
			label: 'minetools.eu',
			get: function (server, seconds) {
				if (server.edition === 'bedrock') return Promise.reject(new Error('minetools.eu only knows Java servers'))
				return timeoutFetch('https://api.minetools.eu/ping/' + encodeURIComponent(server.address) + '/' + (server.port || 25565) + '?_ts=' + Date.now(), seconds).then(function (j) { return fromMinetools(server, j) })
			},
		},
	}

	/** Combines what several sites said about one server: the first answer is used, the rest fill in what it lacks. */
	function merge(primary, others) {
		var out = Object.assign({}, primary)
		others.forEach(function (o) {
			if (!o) return
			if (out.ping === null && o.ping !== null) out.ping = o.ping
			if (!out.ip && o.ip) out.ip = o.ip
			if (!out.software && o.software) out.software = o.software
			if (!out.version && o.version) out.version = o.version
			if (!out.icon && o.icon) out.icon = o.icon
			if (!out.motd && o.motd) out.motd = o.motd
			if (!out.gamemode && o.gamemode) out.gamemode = o.gamemode
			if (!out.srv && o.srv) out.srv = o.srv
			if (o.eula) out.eula = true
			if (!out.players.list.length && o.players.list.length) out.players = Object.assign({}, out.players, { list: o.players.list })
			if (!out.plugins.length && o.plugins.length) out.plugins = o.plugins
			if (!out.mods.length && o.mods.length) out.mods = o.mods
			o.via.forEach(function (v) { if (out.via.indexOf(v) < 0) out.via.push(v) })
		})
		return out
	}

	/**
	 * Many servers put text lines (a title, "Lobby: 0/100 players online") into the player list of the status answer.
	 * A Java name is 1 to 16 letters, digits or underscores, so anything else (colour codes, spaces, dashes) is not a player.
	 */
	function realPlayers(list, edition) {
		var re = edition === 'bedrock' ? /^[A-Za-z0-9 _.'\-]{1,32}$/ : /^[A-Za-z0-9_]{1,16}$/
		var seen = {}
		var out = []
		var hidden = 0
		;(list || []).forEach(function (p) {
			var n = p && typeof p.name === 'string' ? p.name.trim() : ''
			if (!re.test(n) || n.indexOf('\u00a7') >= 0) { hidden++; return }
			if (seen[n.toLowerCase()]) return
			seen[n.toLowerCase()] = 1
			out.push(p)
		})
		return { list: out, hidden: hidden }
	}

	/** Asks for one server. Resolves to the normalised answer, or { error } when no site could be reached. */
	function query(server) {
		var seconds = Number(setting('timeout')) || 8
		var choice = setting('provider')
		function settle(promises) {
			return Promise.all(promises.map(function (p) { return p.then(function (v) { return { ok: true, v: v } }, function (e) { return { ok: false, e: e } }) }))
		}
		if (choice !== 'auto' && PROVIDERS[choice] && !(choice === 'minetools' && server.edition === 'bedrock')) {
			return PROVIDERS[choice].get(server, seconds).catch(function (e) { return { error: errorText(e), online: false } })
		}
		var java = server.edition !== 'bedrock'
		if (!java) {
			return PROVIDERS.mcstatus.get(server, seconds).catch(function () { return PROVIDERS.mcsrvstat.get(server, seconds) }).catch(function (e) { return { error: errorText(e), online: false } })
		}
		// Java. mcstatus.io has the details (icon, mods, where the name really points) but keeps its answer for a minute or more.
		// minetools.eu asks the server itself, so it is the live one. Both are asked at once, and the live answer wins.
		function applyLive(out, m) {
			out.online = true
			if (setting('liveCounts') && m.players && typeof m.players.online === 'number') {
				out.players = Object.assign({}, out.players, { online: m.players.online, max: m.players.max || out.players.max, list: m.players.list.length ? m.players.list : out.players.list })
				out.countsFrom = 'live'
			}
			return out
		}
		var live = settle([PROVIDERS.minetools.get(server, seconds)]).then(function (g) { return g[0] })
		return PROVIDERS.mcstatus.get(server, seconds).then(
			function (good) {
				return live.then(function (L) {
					var first = L.ok ? L.v : null
					// A name that points somewhere else (an SRV record) has to be asked at its real address.
					var real = /^(.*):(\d+)$/.exec(good.srv || '')
					var again = first && !first.online && real
						? settle([PROVIDERS.minetools.get({ address: real[1], port: Number(real[2]), edition: 'java' }, seconds)]).then(function (g) { return g[0].ok ? g[0].v : first })
						: Promise.resolve(first)
					return again.then(function (m) {
						if (m && m.online) return applyLive(merge(good.online ? good : m, [good.online ? m : good]), m)
						if (good.online && m) {
							// The cached answer says online, the live one says offline: the server probably just went down (or blocks the live site).
							var o = merge(good, [m])
							o.online = false
							o.siteConflict = true
							return o
						}
						if (good.online) return good
						// Offline for both: one more site, in case the first two cannot reach the server.
						return settle([PROVIDERS.mcsrvstat.get(server, seconds)]).then(function (got) {
							var up = got.filter(function (g) { return g.ok && g.v.online }).map(function (g) { return g.v })
							return up.length ? merge(up[0], [good]) : good
						})
					})
				})
			},
			function (firstError) {
				return live.then(function (L) {
					return settle([PROVIDERS.mcsrvstat.get(server, seconds)]).then(function (got) {
						var ok = got.filter(function (g) { return g.ok }).map(function (g) { return g.v })
						if (L.ok) ok.unshift(L.v)
						if (ok.length) {
							var main = ok.filter(function (g) { return g.online })[0] || ok[0]
							var out = merge(main, ok.filter(function (g) { return g !== main }))
							if (L.ok && L.v.online) applyLive(out, L.v)
							return out
						}
						return { error: errorText(firstError), online: false }
					})
				})
			},
		)
	}

	// ======================================================================================
	// Keeping the answers
	// ======================================================================================
	function record(server, data) {
		if (data.error) return
		var map = history()
		var list = map[server.id] || []
		list.push({ t: Date.now(), o: data.online ? 1 : 0, p: data.players.online, ms: data.ping })
		var keep = Number(setting('historyLength')) || 40
		map[server.id] = list.slice(-keep)
		saveHistory(map)
	}

	function checkAlerts(server, data) {
		if (!setting('alerts') || data.error || !server.watch) return
		var before = lastOnline[server.id]
		lastOnline[server.id] = data.online
		if (before === undefined || before === data.online) return
		toast(server.name + (data.online ? ' is online now (' + data.players.online + ' players)' : ' went offline'))
	}

	// ======================================================================================
	// Ping from your own phone
	// ======================================================================================
	// A phone cannot open a plain connection to a Minecraft server, but it can start a secure web request to its address.
	// The server answers that with a close, and the time to that close is two round trips (connect, send, close).
	// So the ping is that time divided by two (the "factor", which you can calibrate in the settings).
	function nowMs() { try { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now() } catch (e) { return Date.now() } }

	function fetchTimed(url, ms) {
		return new Promise(function (resolve) {
			var done = false
			var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
			var t0 = nowMs()
			var timer = setTimeout(function () {
				if (done) return
				done = true
				try { if (ctl) ctl.abort() } catch (e) {}
				resolve({ dt: ms, timeout: true })
			}, ms)
			try {
				fetch(url, { method: 'GET', signal: ctl ? ctl.signal : undefined }).then(
					function () { if (done) return; done = true; clearTimeout(timer); resolve({ dt: nowMs() - t0, answered: true }) },
					function (e) { if (done) return; done = true; clearTimeout(timer); resolve({ dt: nowMs() - t0, error: String((e && e.message) || e) }) },
				)
			} catch (e) {
				done = true
				clearTimeout(timer)
				resolve({ dt: 0, error: String((e && e.message) || e) })
			}
		})
	}
	function median(list) {
		var a = list.slice().sort(function (x, y) { return x - y })
		var n = a.length
		return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null
	}
	function pingFactor() {
		var f = Number(setting('pingFactor'))
		return f >= 0.5 && f <= 6 ? f : 2
	}
	/** Where to measure: the real address behind the name (from the status site), as an IP when there is one. */
	function pingTarget(server, data) {
		var host = server.address
		var port = server.port || (server.edition === 'bedrock' ? 19132 : 25565)
		if (data) {
			if (data.port) port = data.port
			var m = /^(.*):(\d+)$/.exec(data.srv || '')
			if (m) { host = m[1]; port = Number(m[2]) }
			if (data.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(data.ip)) host = data.ip
		}
		return { host: host, port: port }
	}
	/** Resolves to { ms, raw, n } or { unsupported: true } or null. */
	function measureLocal(server, data) {
		var t = pingTarget(server, data)
		var isBedrock = server.edition === 'bedrock'
		var probePort = isBedrock ? 443 : t.port
		var want = Math.max(2, Math.min(8, Number(setting('pingSamples')) || 4))
		var tries = want + 1
		var good = []
		var unsupported = false
		function one(i) {
			if (i >= tries || unsupported) return Promise.resolve()
			return fetchTimed('https://' + t.host + ':' + probePort + '/?p=' + Math.floor(Math.random() * 1e9), 2500).then(function (r) {
				if (r.error && /cleartext|not permitted|disallowed/i.test(r.error)) unsupported = true
				else if (i > 0 && !r.timeout && !r.answered && r.dt >= 2) good.push(r.dt)
				return one(i + 1)
			})
		}
		return one(0).then(function () {
			if (unsupported) return { unsupported: true }
			if (good.length < 2) return null
			good.sort(function (a, b) { return a - b })
			var filtered = good.length >= 3 ? good.slice(0, good.length - 1) : good
			var bestCluster = (filtered[0] + filtered[Math.min(1, filtered.length - 1)]) / 2
			var raw = Math.round(bestCluster)
			var overhead = isBedrock ? 15 : 25
			var netDuration = Math.max(2, bestCluster - overhead)
			var factor = pingFactor()
			var ms = Math.max(1, Math.round(netDuration / factor))
			return { ms: ms, raw: raw, n: good.length }
		})
	}
	var lastRaw = { raw: null, name: '' }

	/** Taps twice to delete: the first tap asks, the second (within 4 seconds) does it. */
	var pendingDelete = { id: '', at: 0 }
	function askDelete(s, after) {
		if (pendingDelete.id === s.id && Date.now() - pendingDelete.at < 4000) {
			pendingDelete = { id: '', at: 0 }
			removeServer(s.id)
			toast('Deleted ' + s.name)
			if (after) after()
			return true
		}
		pendingDelete = { id: s.id, at: Date.now() }
		toast('Tap again to delete ' + s.name)
		changed()
		return false
	}

	/** Checks one server, unless a recent answer is good enough. */
	function check(server, force) {
		var entry = results[server.id]
		var fresh = Number(setting('cacheSeconds')) * 1000
		if (!force && entry && entry.state === 'done' && Date.now() - entry.at < fresh) return Promise.resolve(entry.data)
		if (inflight[server.id]) return inflight[server.id]
		results[server.id] = { state: 'loading', data: entry && entry.data, at: entry ? entry.at : 0 }
		changed()
		inflight[server.id] = query(server).then(
			function (data) {
				delete inflight[server.id]
				results[server.id] = { state: 'done', data: data, at: Date.now() }
				try {
					if (!data.error && data.players && Array.isArray(data.players.list)) {
						var rp = realPlayers(data.players.list, server.edition)
						data.players = Object.assign({}, data.players, { list: rp.list, hidden: rp.hidden })
					}
				} catch (e) {}
				if (!data.error && !data.online && setting('pingSource') !== 'site') {
					// If status sites say offline (often due to 3-5 min CDN cache), verify directly from the phone.
					data.pingFrom = 'measuring'
					changed()
					return measureLocal(server, data).then(
						function (p) {
							if (p && !p.unsupported) {
								data.online = true
								data.phoneReachable = true
								data.ping = p.ms
								data.pingFrom = 'phone'
								data.rawPing = p.raw
								if (!data.motd) data.motd = 'Online (verified directly from your phone)'
							}
							else data.pingFrom = 'none'
							try { record(server, data); checkAlerts(server, data) } catch (e) {}
							changed()
							return data
						},
						function () { data.pingFrom = 'none'; try { record(server, data) } catch (e) {} changed(); return data },
					)
				}
				var measure = setting('pingSource') !== 'site' && !data.error && data.online
				if (!measure) {
					if (!data.error && typeof data.ping === 'number') data.pingFrom = 'site'
					try { record(server, data); checkAlerts(server, data) } catch (e) {}
					changed()
					return data
				}
				// Show the answer now; the ping from this phone follows a moment later.
				data.providerPing = data.ping
				data.ping = null
				data.pingFrom = 'measuring'
				try { checkAlerts(server, data) } catch (e) {}
				changed()
				return measureLocal(server, data).then(
					function (p) {
						if (p && !p.unsupported) { data.ping = p.ms; data.pingFrom = 'phone'; data.rawPing = p.raw; lastRaw = { raw: p.raw, name: server.name } }
						else { data.ping = typeof data.providerPing === 'number' ? data.providerPing : null; data.pingFrom = typeof data.providerPing === 'number' ? 'site' : 'none'; if (p && p.unsupported) data.pingNote = 'This phone does not allow the check' }
						try { record(server, data) } catch (e) {}
						changed()
						return data
					},
					function () {
						data.ping = typeof data.providerPing === 'number' ? data.providerPing : null
						data.pingFrom = data.ping === null ? 'none' : 'site'
						try { record(server, data) } catch (e) {}
						changed()
						return data
					},
				)
			},
			function (e) {
				delete inflight[server.id]
				var data = { error: errorText(e), online: false }
				results[server.id] = { state: 'done', data: data, at: Date.now() }
				changed()
				return data
			},
		)
		return inflight[server.id]
	}
	function checkAll(force) {
		return Promise.all(servers().map(function (s) { return check(s, force) }))
	}

	// ---- Numbers for the screens ---------------------------------------------------------------------
	function pingColor(ms) { return ms === null || ms === undefined ? GRAY : ms < 60 ? GREEN : ms < 150 ? AMBER : RED }
	function ago(t) {
		var s = Math.max(0, Math.round((Date.now() - t) / 1000))
		return s < 5 ? 'just now' : s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'
	}
	function statusOf(server) {
		var r = results[server.id]
		if (!r || (r.state === 'loading' && !r.data)) return { key: 'loading', label: 'Checking…', color: GRAY }
		var d = r.data
		if (!d) return { key: 'loading', label: 'Checking…', color: GRAY }
		if (d.error) return { key: 'error', label: 'No answer', color: AMBER }
		if (d.online || d.phoneReachable) return { key: 'online', label: 'Online', color: GREEN }
		return { key: 'offline', label: 'Offline', color: RED }
	}
	function playersText(d) {
		return d && !d.error && d.online ? d.players.online + (d.players.max ? '/' + d.players.max : '') : '–'
	}
	function stats(server) {
		var list = history()[server.id] || []
		var online = list.filter(function (x) { return x.o }).length
		var pings = list.map(function (x) { return x.ms }).filter(function (x) { return typeof x === 'number' })
		return {
			checks: list.length,
			uptime: list.length ? Math.round((online / list.length) * 100) : null,
			avgPing: pings.length ? Math.round(pings.reduce(function (a, b) { return a + b }, 0) / pings.length) : null,
			bestPing: pings.length ? Math.min.apply(null, pings) : null,
			worstPing: pings.length ? Math.max.apply(null, pings) : null,
			peak: list.reduce(function (m, x) { return Math.max(m, x.p || 0) }, 0),
			list: list,
		}
	}
	function sorted(list) {
		var mode = setting('sort')
		var copy = list.slice()
		var rank = { online: 0, loading: 1, error: 2, offline: 3 }
		function players(s) { var d = results[s.id] && results[s.id].data; return d && !d.error && d.online ? d.players.online : -1 }
		if (mode === 'status') copy.sort(function (a, b) { return rank[statusOf(a).key] - rank[statusOf(b).key] || players(b) - players(a) })
		else if (mode === 'players') copy.sort(function (a, b) { return players(b) - players(a) })
		else if (mode === 'name') copy.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)) })
		else if (mode === 'favorites') copy.sort(function (a, b) { return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) })
		return copy
	}
	function summary() {
		var list = servers()
		var online = 0
		var players = 0
		list.forEach(function (s) {
			var d = results[s.id] && results[s.id].data
			if (d && !d.error && d.online) { online++; players += d.players.online }
		})
		return { total: list.length, online: online, players: players }
	}

	// ======================================================================================
	// Building blocks
	// ======================================================================================
	function T(props, text) {
		var Design = valenced.discord.design.Design
		return h(Design.Text, props, text)
	}
	function tint(hex, alpha) {
		var m = /^#([0-9a-f]{6})$/i.exec(hex)
		if (!m) return hex
		var n = parseInt(m[1], 16)
		return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')'
	}
	function surface() { return color('BACKGROUND_SURFACE_HIGH', '#2b2d31') }
	function raised() { return color('BACKGROUND_SURFACE_HIGHEST', '#35373c') }

	function Card(props) {
		var RN = valenced.react.ReactNative
		return h(RN.View, { style: Object.assign({ backgroundColor: surface(), borderRadius: 14, padding: 14, gap: 10 }, props.style || {}) }, props.children)
	}

	function Chip(props) {
		var RN = valenced.react.ReactNative
		var c = props.color || GRAY
		return h(
			RN.View,
			{ style: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: tint(c, 0.18), alignSelf: 'flex-start' } },
			props.dot ? h(RN.View, { style: { width: 7, height: 7, borderRadius: 4, backgroundColor: c } }) : null,
			T({ variant: 'text-xs/bold', style: { color: c } }, props.text),
		)
	}

	function tileColor(text) {
		var n = 0
		for (var i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) >>> 0
		return ['#5865f2', '#3ba55d', '#eb459e', '#faa81a', '#ed4245', '#1abc9c', '#9b59b6', '#3498db'][n % 8]
	}

	function Avatar(props) {
		var RN = valenced.react.ReactNative
		var size = props.size || 48
		var d = props.data
		var inner = setting('icons') && d && d.icon
			? h(RN.Image, { source: { uri: d.icon }, style: { width: size, height: size, borderRadius: Math.round(size * 0.22) } })
			: h(RN.View, { style: { width: size, height: size, borderRadius: Math.round(size * 0.22), backgroundColor: tileColor(props.server.address), alignItems: 'center', justifyContent: 'center' } }, T({ variant: 'heading-md/bold', style: { color: '#ffffff' } }, String(props.server.name || props.server.address).charAt(0).toUpperCase()))
		return h(
			RN.View,
			{ style: { width: size, height: size } },
			inner,
			props.dotColor ? h(RN.View, { style: { position: 'absolute', right: -3, bottom: -3, width: 16, height: 16, borderRadius: 8, backgroundColor: props.dotColor, borderWidth: 3, borderColor: surface() } }) : null,
		)
	}

	function Segmented(props) {
		var RN = valenced.react.ReactNative
		return h(
			RN.ScrollView,
			{ horizontal: true, showsHorizontalScrollIndicator: false, contentContainerStyle: { gap: props.compact ? 6 : 8 } },
			props.items.map(function (item) {
				var on = item.value === props.value
				return h(
					RN.Pressable,
					{ key: String(item.value), onPress: function () { props.onChange(item.value) } },
					h(RN.View, { style: { paddingHorizontal: props.compact ? 11 : 14, paddingVertical: 7, borderRadius: 999, backgroundColor: on ? BLURPLE : raised() } }, T({ variant: 'text-sm/semibold', style: { color: on ? '#ffffff' : color('TEXT_NORMAL', '#dbdee1') } }, item.label)),
				)
			}),
		)
	}

	/** Bars for the last checks: how many players, and red when the server was off. */
	function Spark(props) {
		var RN = valenced.react.ReactNative
		var list = props.list.slice(-30)
		var peak = Math.max(1, list.reduce(function (m, x) { return Math.max(m, x.p || 0) }, 0))
		return h(
			RN.View,
			{ style: { flexDirection: 'row', alignItems: 'flex-end', height: 46, gap: 3 } },
			list.map(function (x, i) {
				var height = x.o ? Math.max(5, Math.round(((x.p || 0) / peak) * 46)) : 46
				return h(RN.View, { key: i, style: { flex: 1, height: height, borderRadius: 3, backgroundColor: x.o ? GREEN : tint(RED, 0.5) } })
			}),
		)
	}

	function Stat(props) {
		var RN = valenced.react.ReactNative
		return h(
			RN.View,
			{ style: { flexBasis: '48%', flexGrow: 1, backgroundColor: surface(), borderRadius: 14, padding: 14, gap: 4 } },
			T({ variant: 'text-xs/semibold', color: 'text-muted' }, String(props.label).toUpperCase()),
			T({ variant: 'heading-md/bold', numberOfLines: 1, style: props.color ? { color: props.color } : undefined }, props.value),
			props.sub ? T({ variant: 'text-xs/medium', color: 'text-muted', numberOfLines: 1 }, props.sub) : null,
			props.children,
		)
	}

	function Button(props) {
		var Design = valenced.discord.design.Design
		return h(Design.Button, { text: props.text, size: props.size || 'md', variant: props.variant || 'secondary', loading: props.loading, onPress: props.onPress, disabled: props.disabled })
	}
	function Row2(props) {
		var RN = valenced.react.ReactNative
		return h(RN.View, { style: { flexDirection: 'row', gap: 10 } }, props.children.filter(Boolean).map(function (c, i) { return h(RN.View, { key: i, style: { flex: 1 } }, c) }))
	}

	// ---- Sending to the chat --------------------------------------------------------------------
	function statusMessage(server, d) {
		var f = finders()
		var lines = []
		if (!d || d.error) lines.push('**' + server.name + '** (`' + addressText(server) + '`): no answer')
		else if (!d.online) lines.push('**' + server.name + '** (`' + addressText(server) + '`) is **offline**')
		else {
			lines.push('**' + server.name + '** is **online**')
			var bits = ['`' + addressText(server) + '`', d.players.online + (d.players.max ? '/' + d.players.max : '') + ' players']
			if (d.ping !== null) bits.push(d.ping + ' ms')
			var sw = [d.software, d.version].filter(Boolean).join(' ')
			if (sw) bits.push(sw)
			lines.push(bits.join(' · '))
			if (d.players.list.length) lines.push('Playing: ' + d.players.list.slice(0, 12).map(function (p) { return p.name }).join(', ') + (d.players.list.length > 12 ? ' …' : ''))
		}
		return lines.join('\n')
	}
	function sendToChat(server, d) {
		var f = finders()
		var messages = f.lookupModule(f.filters.withProps('sendMessage', 'revealMessage'))[0]
		var channel
		try { channel = valenced.discord.flux.Stores.SelectedChannelStore.getChannelId() } catch (e) {}
		if (!messages || !channel) return toast('Open a chat first, then try again.')
		try {
			messages.sendMessage(channel, { content: statusMessage(server, d), tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, {})
			try { valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(SHEET_KEY) } catch (e) {}
			toast('Sent to the chat')
		} catch (e) {
			toast('Could not send: ' + errorText(e).slice(0, 60))
		}
	}

	// ======================================================================================
	// The list
	// ======================================================================================
	function ServerRow(props) {
		var RN = valenced.react.ReactNative
		var s = props.server
		var st = statusOf(s)
		var r = results[s.id]
		var d = r && r.data
		var online = st.key === 'online'
		var compact = !!setting('compact')
		var meta = online ? [d.software, d.version].filter(Boolean).join(' ') : st.key === 'error' ? String(d.error).slice(0, 50) : st.label
		return h(
			RN.Pressable,
			{ onPress: props.onPress, onLongPress: props.onLongPress, delayLongPress: 350 },
			h(
				RN.View,
				{ style: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: compact ? 10 : 12, borderRadius: 14, backgroundColor: surface() } },
				h(Avatar, { server: s, data: d, size: compact ? 40 : 48, dotColor: st.color }),
				h(
					RN.View,
					{ style: { flex: 1, minWidth: 0, gap: 2 } },
					h(
						RN.View,
						{ style: { flexDirection: 'row', alignItems: 'center', gap: 6 } },
						T({ variant: 'text-md/semibold', numberOfLines: 1, style: { flexShrink: 1 } }, s.name),
						s.favorite ? T({ variant: 'text-sm/bold', style: { color: AMBER } }, '★') : null,
					),
					T({ variant: 'text-sm/medium', color: 'text-muted', numberOfLines: 1 }, addressText(s)),
					compact ? null : T({ variant: 'text-xs/medium', color: 'text-muted', numberOfLines: 1 }, meta || ' '),
				),
				h(
					RN.View,
					{ style: { alignItems: 'flex-end', gap: 4 } },
					T(online ? { variant: 'text-md/bold' } : { variant: 'text-md/bold', style: { color: GRAY } }, playersText(d)),
					online && d.ping !== null ? h(Chip, { text: d.ping + ' ms', color: pingColor(d.ping) }) : h(Chip, { text: st.label, color: st.color }),
				),
			),
		)
	}

	/** Adds the server whose address is on the clipboard, so a copied address is one tap away. */
	function addFromClipboard(go) {
		Promise.resolve(valenced.externals.ReactNativeClipboard.Clipboard.getString()).then(
			function (text) {
				var first = String(text || '').trim().split(/\s+/)[0]
				var parsed = parseAddress(first)
				if (parsed.error) return toast('The clipboard does not hold a server address')
				var list = servers()
				var dup = list.filter(function (x) { return x.address === parsed.host && (x.port || 0) === parsed.port && x.edition === 'java' })[0]
				if (dup) { toast('Already saved as ' + dup.name); return go({ name: 'detail', id: dup.id }) }
				var s = { id: newId(), name: parsed.host, address: parsed.host, port: parsed.port || 0, edition: 'java', note: '', favorite: false, watch: false, addedAt: Date.now() }
				saveServers(list.concat([s]))
				check(s, true)
				go({ name: 'detail', id: s.id })
			},
			function () { toast('Could not read the clipboard') },
		)
	}

	function ListView(props) {
		var RN = valenced.react.ReactNative
		var list = sorted(servers())
		var sum = summary()
		var busy = list.some(function (s) { return results[s.id] && results[s.id].state === 'loading' })
		return h(
			RN.View,
			{ style: { gap: 14 } },
			h(
				RN.View,
				{ style: { gap: 2 } },
				T({ variant: 'heading-lg/bold' }, 'Minecraft servers'),
				T({ variant: 'text-sm/medium', color: 'text-muted' }, sum.total ? sum.online + ' of ' + sum.total + ' online · ' + sum.players + ' player' + (sum.players === 1 ? '' : 's') : 'Save a server to see how it is doing'),
			),
			h(Row2, null, [
				h(Button, { key: 'r', text: busy ? 'Checking…' : 'Refresh all', loading: busy, onPress: function () { checkAll(true) } }),
				h(Button, { key: 'a', text: '+ Add server', variant: 'primary', onPress: function () { props.go({ name: 'edit', id: null }) } }),
			]),
			h(Button, { text: 'Add the address I copied', onPress: function () { addFromClipboard(props.go) } }),
			list.length > 1
				? h(Segmented, { items: [{ value: 'manual', label: 'My order' }, { value: 'status', label: 'Online first' }, { value: 'players', label: 'Most players' }, { value: 'name', label: 'A to Z' }, { value: 'favorites', label: '★ Favorites' }], value: setting('sort'), onChange: function (v) { save({ sort: v }); changed() } })
				: null,
			list.length
				? h(RN.View, { style: { gap: 8 } }, list.map(function (s) { return h(ServerRow, { key: s.id, server: s, onPress: function () { props.go({ name: 'detail', id: s.id }) }, onLongPress: function () { props.go({ name: 'menu', id: s.id }) } }) }))
				: h(
						Card,
						{ style: { alignItems: 'center', paddingVertical: 26 } },
						T({ variant: 'heading-md/bold' }, 'No servers yet'),
						T({ variant: 'text-sm/medium', color: 'text-muted', style: { textAlign: 'center' } }, 'Add the address of a Minecraft server, like play.example.com. You will see if it is online, who is playing and the ping.'),
						h(Button, { text: 'Add your first server', variant: 'primary', onPress: function () { props.go({ name: 'edit', id: null }) } }),
				  ),
		)
	}

	function MenuView(props) {
		var Design = valenced.discord.design.Design
		var RN = valenced.react.ReactNative
		var s = serverById(props.id)
		if (!s) return h(ListView, props)
		var d = results[s.id] && results[s.id].data
		function row(label, sub, onPress) { return h(Design.TableRow, { key: label, label: label, subLabel: sub, onPress: onPress }) }
		return h(
			RN.View,
			{ style: { gap: 14 } },
			h(Button, { text: '‹ Back', onPress: function () { props.go({ name: 'list' }) } }),
			T({ variant: 'heading-lg/bold', numberOfLines: 1 }, s.name),
			h(Design.TableRowGroup, null, [
				row('Open', 'See everything about this server', function () { props.go({ name: 'detail', id: s.id }) }),
				row('Refresh', 'Check it again now', function () { check(s, true); props.go({ name: 'list' }) }),
				row('Copy address', addressText(s), function () { copy(addressText(s), 'Address') }),
				row('Send status to chat', 'Posts a short summary', function () { sendToChat(s, d) }),
				row(s.favorite ? 'Remove from favorites' : 'Add to favorites', 'Favorites can be shown first', function () { updateServer(s.id, { favorite: !s.favorite }); props.go({ name: 'list' }) }),
				row('Edit', 'Name, address and options', function () { props.go({ name: 'edit', id: s.id }) }),
				row(pendingDelete.id === s.id && Date.now() - pendingDelete.at < 4000 ? 'Tap again to delete' : 'Delete server', 'Removes it and its history', function () { askDelete(s, function () { props.go({ name: 'list' }) }) }),
			]),
		)
	}

	// ======================================================================================
	// One server
	// ======================================================================================
	function updateServer(id, patch) {
		saveServers(servers().map(function (s) { return s.id === id ? Object.assign({}, s, patch) : s }))
	}
	function removeServer(id) {
		saveServers(servers().filter(function (s) { return s.id !== id }))
		var map = history()
		delete map[id]
		saveHistory(map)
		delete results[id]
		delete lastOnline[id]
		changed()
	}

	/** A long list of names (the mods of a modpack can be hundreds): searchable, and folded until asked for. */
	function NameList(props) {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var Design = valenced.discord.design.Design
		var query = React.useState('')
		var open = React.useState(false)
		var q = String(query[0]).toLowerCase().trim()
		var all = props.list
		var shown = all.filter(function (n) { return !q || n.toLowerCase().indexOf(q) >= 0 })
		var limit = open[0] || q ? 400 : 12
		return h(
			RN.View,
			{ style: { gap: 10 } },
			all.length > 12 ? h(Design.TextInput, { placeholder: 'Search ' + props.what, size: 'md', value: query[0], onChange: function (v) { query[1](v) } }) : null,
			h(RN.View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 } }, shown.slice(0, limit).map(function (n, i) { return h(RN.View, { key: n + i, style: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: raised() } }, T({ variant: 'text-xs/semibold' }, n)) })),
			shown.length > limit ? h(Button, { text: 'Show all ' + shown.length, size: 'sm', onPress: function () { open[1](true) } }) : null,
			shown.length ? null : T({ variant: 'text-sm/medium', color: 'text-muted' }, 'Nothing matches that.'),
		)
	}

	function PlayerChips(props) {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var Design = valenced.discord.design.Design
		var query = React.useState('')
		var list = props.list
		var q = String(query[0]).toLowerCase().trim()
		var shown = list.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0 })
		return h(
			RN.View,
			{ style: { gap: 10 } },
			list.length > 10 ? h(Design.TextInput, { placeholder: 'Search players', size: 'md', value: query[0], onChange: function (v) { query[1](v) } }) : null,
			h(
				RN.View,
				{ style: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } },
				shown.map(function (p) {
					return h(
						RN.Pressable,
						{ key: p.name, onPress: function () { copy(p.name, 'Name') } },
						h(
							RN.View,
							{ style: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 5, paddingLeft: 5, paddingRight: 11, borderRadius: 999, backgroundColor: raised() } },
							setting('heads') ? h(RN.Image, { source: { uri: 'https://mc-heads.net/avatar/' + encodeURIComponent(p.name) + '/40' }, style: { width: 22, height: 22, borderRadius: 4 } }) : null,
							T({ variant: 'text-sm/semibold' }, p.name),
						),
					)
				}),
			),
			shown.length ? null : T({ variant: 'text-sm/medium', color: 'text-muted' }, 'No player matches that.'),
		)
	}

	function DetailView(props) {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var Design = valenced.discord.design.Design
		var s = serverById(props.id)
		var tabState = React.useState('overview')
		var powerBusyState = React.useState(false)
		var powerMsgState = React.useState(null)
		var showConfigState = React.useState(s ? !s.powerUrl : true)
		var urlState = React.useState(s && s.powerUrl ? s.powerUrl : '')
		var tokenState = React.useState(s && s.powerToken ? s.powerToken : '')
		var csrfState = React.useState(s && s.powerCsrf ? s.powerCsrf : '')
		var cookieState = React.useState(s && s.powerCookie ? s.powerCookie : '')
		var bodyState = React.useState(s && s.powerBody ? s.powerBody : '')

		React.useEffect(function () {
			if (s) {
				urlState[1](s.powerUrl || '')
				tokenState[1](s.powerToken || '')
				csrfState[1](s.powerCsrf || '')
				cookieState[1](s.powerCookie || '')
				bodyState[1](s.powerBody || '')
				showConfigState[1](!s.powerUrl)
				powerMsgState[1](null)
			}
		}, [props.id])
		if (!s) return h(ListView, props)
		var r = results[s.id]
		var d = r && r.data
		var st = statusOf(s)
		var online = st.key === 'online'
		var loading = r && r.state === 'loading'
		var h2 = stats(s)
		var port = d && !d.error && d.port ? d.port : s.port || (s.edition === 'bedrock' ? 19132 : 25565)
		var fill = online && d.players.max ? Math.min(100, Math.round((d.players.online / d.players.max) * 100)) : 0
		var tab = tabState[0]
		var reach = st.key === 'reachable'
		var reachCard = reach ? h(Card, { style: { backgroundColor: tint(AMBER, 0.14) } }, T({ variant: 'text-md/semibold', style: { color: AMBER } }, 'Your phone can reach it'), T({ variant: 'text-sm/medium' }, (d.siteConflict ? 'One status site says this server is online and another says offline, ' : 'The status sites say this server is offline, ') + 'but your phone can reach its address (' + (d.ping !== null ? 'about ' + d.ping + ' ms' : 'it answers') + '). Some servers block the status sites, or are slow to answer them. Player names and the version are not available while only your phone can see it.')) : null
		var backButton = 			h(Button, { text: '‹ All servers', onPress: function () { props.go({ name: 'list' }) } })
		var headerRow = 			h(
				RN.View,
				{ style: { flexDirection: 'row', alignItems: 'center', gap: 14 } },
				h(Avatar, { server: s, data: d, size: 64, dotColor: st.color }),
				h(
					RN.View,
					{ style: { flex: 1, gap: 4 } },
					T({ variant: String(s.name).length > 20 ? 'heading-md/bold' : 'heading-lg/bold', numberOfLines: 2 }, s.name),
					h(
						RN.Pressable,
						{ onPress: function () { copy(addressText(s), 'Address') } },
						T({ variant: 'text-sm/medium', color: 'text-muted', numberOfLines: 1 }, addressText(s) + '  ⧉'),
					),
					h(Chip, { text: loading && !d ? 'Checking…' : st.label, color: st.color, dot: true }),
				),
			)
		var errorCard = 			st.key === 'error'
				? h(Card, { style: { backgroundColor: tint(AMBER, 0.14) } }, T({ variant: 'text-md/semibold', style: { color: AMBER } }, 'Could not get an answer'), T({ variant: 'text-sm/medium' }, String(d.error)), T({ variant: 'text-xs/medium', color: 'text-muted' }, 'Check the address, or try another status site in the plugin settings.'))
				: null
		var motdCard = 			online && setting('motd') && d.motd ? h(Card, null, T({ variant: 'text-xs/semibold', color: 'text-muted' }, 'MESSAGE OF THE DAY'), T({ variant: 'text-md/medium' }, d.motd)) : null
		var playersStat = 				h(Stat, { key: 'players', label: 'Players', value: online ? d.players.online + (d.players.max ? ' / ' + d.players.max : '') : '–', color: online ? undefined : GRAY, sub: online ? (d.countsFrom === 'live' ? 'Live count' : d.retrievedAt ? 'Status site, ' + ago(d.retrievedAt) : undefined) : undefined }, online && d.players.max ? h(RN.View, { style: { height: 6, borderRadius: 3, backgroundColor: raised(), marginTop: 6, overflow: 'hidden' } }, h(RN.View, { style: { width: fill + '%', height: 6, backgroundColor: fill > 85 ? AMBER : GREEN } })) : null)
		var pingStat = 				h(Stat, { key: 'ping', label: 'Ping', value: online && d.ping !== null ? d.ping + ' ms' : online && d.pingFrom === 'measuring' ? '…' : '–', color: online ? pingColor(d.ping) : GRAY, sub: online ? (d.pingFrom === 'phone' ? 'Measured from your phone' : d.pingFrom === 'site' ? 'From the status site, not your phone' : d.pingFrom === 'measuring' ? 'Measuring from your phone' : d.pingNote || 'Not available') : undefined })
		var versionStat = 				h(Stat, { key: 'version', label: 'Version', value: online && d.version ? d.version : '–', sub: online && d.protocol !== null && d.protocol !== undefined ? 'Protocol ' + d.protocol : undefined })
		var softwareStat = 				h(Stat, { key: 'software', label: 'Software', value: online && d.software ? d.software : online ? 'Not shared' : '–', sub: online ? (s.edition === 'bedrock' ? 'Bedrock' : 'Java') + (d.gamemode ? ' · ' + d.gamemode : '') : undefined })
		var ipStat = 				h(Stat, { key: 'ip', label: 'IP address', value: d && d.ip ? d.ip : s.address, sub: d && d.srv ? 'Real address ' + d.srv : d && d.ip ? 'Behind ' + s.address : 'Address you saved' })
		var portStat = 				h(Stat, { key: 'port', label: 'Port', value: String(port), sub: s.port ? 'Set by you' : 'Default' })
		var playersCard = 			online
				? h(
						Card,
						null,
						h(RN.View, { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } }, T({ variant: 'text-md/bold' }, 'Online players'), T({ variant: 'text-sm/medium', color: 'text-muted' }, d.players.online + (d.players.max ? ' of ' + d.players.max : ''))),
						d.players.list.length
							? h(PlayerChips, { list: d.players.list })
							: T({ variant: 'text-sm/medium', color: 'text-muted' }, d.players.online ? 'This server does not share the names of the players.' : 'Nobody is playing right now.'),
						d.players.list.length && d.players.online > d.players.list.length ? T({ variant: 'text-xs/medium', color: 'text-muted' }, 'Showing ' + d.players.list.length + ' names. The server only lists some of its players.') : null,
						d.players.hidden ? T({ variant: 'text-xs/medium', color: 'text-muted' }, d.players.hidden + ' line' + (d.players.hidden === 1 ? '' : 's') + ' the server puts in its player list ' + (d.players.hidden === 1 ? 'is' : 'are') + ' not player names, so ' + (d.players.hidden === 1 ? 'it is' : 'they are') + ' hidden.') : null,
				  )
				: null
		var modsCard = 			online && (d.plugins.length || d.mods.length)
				? h(Card, null, T({ variant: 'text-md/bold' }, d.mods.length ? 'Mods (' + d.mods.length + ')' : 'Plugins (' + d.plugins.length + ')'), h(NameList, { list: d.mods.length ? d.mods : d.plugins, what: d.mods.length ? 'mods' : 'plugins' }))
				: null
		var eulaCard = 			d && !d.error && d.eula ? h(Card, { style: { backgroundColor: tint(RED, 0.14) } }, T({ variant: 'text-md/semibold', style: { color: RED } }, 'Blocked by Mojang'), T({ variant: 'text-sm/medium' }, 'Mojang blocks this server for breaking the Minecraft EULA, so players cannot join it from the normal launcher.')) : null
		var historyCard = 			h(
				Card,
				null,
				h(RN.View, { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } }, T({ variant: 'text-md/bold' }, 'History'), h2.checks ? T({ variant: 'text-sm/medium', color: 'text-muted' }, h2.checks + ' check' + (h2.checks === 1 ? '' : 's')) : null),
				h2.checks > 1 ? h(Spark, { list: h2.list }) : T({ variant: 'text-sm/medium', color: 'text-muted' }, 'Check this server a few times and its history shows up here.'),
				h2.checks
					? h(
							RN.View,
							{ style: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } },
							h(Chip, { text: 'Up ' + h2.uptime + '%', color: h2.uptime > 95 ? GREEN : h2.uptime > 70 ? AMBER : RED }),
							h2.avgPing !== null ? h(Chip, { text: 'Avg ' + h2.avgPing + ' ms', color: pingColor(h2.avgPing) }) : null,
							h2.bestPing !== null ? h(Chip, { text: 'Best ' + h2.bestPing + ' ms', color: GREEN }) : null,
							h2.worstPing !== null ? h(Chip, { text: 'Worst ' + h2.worstPing + ' ms', color: pingColor(h2.worstPing) }) : null,
							h(Chip, { text: 'Peak ' + h2.peak + ' players', color: BLURPLE }),
					  )
					: null,
			)
		var checkedLine = 			r && r.at ? T({ variant: 'text-xs/medium', color: 'text-muted', style: { textAlign: 'center' } }, 'Checked ' + ago(r.at) + (d && d.via && d.via.length ? ' via ' + d.via.join(' + ') : '')) : null
		function sendPower() {
			if (!s.powerUrl) {
				toast('Please enter the Request URL below and tap Save')
				showConfigState[1](true)
				return
			}
			powerBusyState[1](true)
			powerMsgState[1](null)

			var url = s.powerUrl.trim()
			var headers = {
				'Accept': 'application/json, text/plain, */*',
				'Content-Type': 'application/json',
			}

			try {
				var parsed = new URL(url)
				headers['Origin'] = parsed.origin
				headers['Referer'] = parsed.origin + '/'
			} catch (_) {}

			if (url.indexOf('mcserverhost.com') !== -1) {
				headers['Origin'] = 'https://legacy.mcserverhost.com'
				headers['Referer'] = 'https://legacy.mcserverhost.com/'
			}

			if (s.powerCsrf && s.powerCsrf.trim()) {
				headers['X-CSRF-Token'] = s.powerCsrf.trim()
				headers['X-CSRF-TOKEN'] = s.powerCsrf.trim()
			}

			if (s.powerToken && s.powerToken.trim()) {
				var tok = s.powerToken.trim().replace(/^['"]|['"]$/g, '')
				headers['Authorization'] = tok.indexOf('Bearer ') === 0 ? tok : 'Bearer ' + tok
			}

			if (s.powerCookie && s.powerCookie.trim()) {
				headers['Cookie'] = s.powerCookie.trim().replace(/^['"]|['"]$/g, '')
			}

			var bodyStr = s.powerBody && s.powerBody.trim() ? s.powerBody.trim() : JSON.stringify({ action: 'start', signal: 'start', wait_seconds: 0 })

			fetch(url, {
				method: 'POST',
				headers: headers,
				body: bodyStr,
			})
			.then(function (res) {
				return res.text().then(function (t) {
					return { ok: res.ok, status: res.status, text: t }
				}).catch(function () {
					return { ok: res.ok, status: res.status, text: '' }
				})
			})
			.then(function (res) {
				powerBusyState[1](false)
				if (res.ok) {
					toast('🟢 Power signal sent successfully!')
					powerMsgState[1]({ ok: true, msg: 'Power signal sent (' + res.status + ')' })
					setTimeout(function () { check(s, true) }, 4000)
					setTimeout(function () { check(s, true) }, 12000)
					setTimeout(function () { check(s, true) }, 24000)
					setTimeout(function () { check(s, true) }, 40000)
				} else {
					var err = 'Failed (' + res.status + ')'
					if (res.status === 401 || res.status === 403) {
						err = 'Auth failed (' + res.status + '): token or CSRF expired'
					} else if (res.text) {
						err += ': ' + String(res.text).slice(0, 80)
					}
					toast('❌ ' + err)
					powerMsgState[1]({ ok: false, msg: err })
				}
			})
			.catch(function (e) {
				powerBusyState[1](false)
				var err = 'Network error: ' + (e && e.message ? e.message : String(e))
				toast('❌ ' + err)
				powerMsgState[1]({ ok: false, msg: err })
			})
		}

		var powerBusy = powerBusyState[0]
		var powerMsg = powerMsgState[0]
		var showConfig = showConfigState[0]

		var powerCard = h(
			Card,
			null,
			h(RN.View, { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
				T({ variant: 'text-md/bold' }, 'Server Power'),
				s.powerUrl ? h(Chip, { text: 'Configured', color: GREEN, dot: true }) : h(Chip, { text: 'Not set up', color: AMBER, dot: true })
			),
			T({ variant: 'text-sm/medium', color: 'text-muted' }, 'Send a power signal directly to your server host to boot it up.'),
			h(Button, {
				text: powerBusy ? 'Sending power signal…' : 'Power',
				variant: 'primary',
				loading: powerBusy,
				onPress: sendPower
			}),
			powerMsg ? h(Chip, { text: powerMsg.msg, color: powerMsg.ok ? GREEN : RED, dot: true }) : null,
			h(Button, {
				text: showConfig ? 'Hide setup' : (s.powerUrl ? 'Edit setup' : 'Set up host connection'),
				onPress: function () { showConfigState[1](!showConfig) }
			})
		)

		var powerConfigCard = showConfig ? h(
			Card,
			null,
			T({ variant: 'text-md/bold' }, 'Host connection setup'),
			T({ variant: 'text-xs/medium', color: 'text-muted' }, 'Works with MCServerHost, Pterodactyl panels, or any host API. In your browser DevTools (F12) > Network > Fetch/XHR, trigger power on your server and copy:'),
			h(Design.TextInput, {
				label: 'Request URL',
				description: 'The endpoint URL (e.g. https://api.mcserverhost.com/user/servers/.../power)',
				placeholder: 'https://...',
				size: 'md',
				value: urlState[0],
				onChange: function (v) { urlState[1](v) },
				autoCapitalize: 'none',
				autoCorrect: false
			}),
			h(Design.TextInput, {
				label: 'Auth Token / Key (optional)',
				description: 'Bearer token, JWT or API key from request headers',
				placeholder: 'eyJhbGciOi... or ptla_...',
				size: 'md',
				value: tokenState[0],
				onChange: function (v) { tokenState[1](v) },
				autoCapitalize: 'none',
				autoCorrect: false
			}),
			h(Design.TextInput, {
				label: 'CSRF Token (optional)',
				description: 'X-CSRF-Token if required by host',
				placeholder: 'be07118dd...',
				size: 'md',
				value: csrfState[0],
				onChange: function (v) { csrfState[1](v) },
				autoCapitalize: 'none',
				autoCorrect: false
			}),
			h(Design.TextInput, {
				label: 'Cookie (optional)',
				description: 'Session cookie if host authenticates via Cookie',
				placeholder: 'session=...',
				size: 'md',
				value: cookieState[0],
				onChange: function (v) { cookieState[1](v) },
				autoCapitalize: 'none',
				autoCorrect: false
			}),
			h(Design.TextInput, {
				label: 'Custom JSON Payload (optional)',
				description: 'Leave blank for default start signal (supports MCServerHost & Pterodactyl)',
				placeholder: '{"action":"start"} or {"signal":"start"}',
				size: 'md',
				value: bodyState[0],
				onChange: function (v) { bodyState[1](v) },
				autoCapitalize: 'none',
				autoCorrect: false
			}),
			h(Row2, null, [
				h(Button, {
					text: 'Save setup',
					variant: 'primary',
					onPress: function () {
						updateServer(s.id, {
							powerUrl: urlState[0].trim(),
							powerToken: tokenState[0].trim(),
							powerCsrf: csrfState[0].trim(),
							powerCookie: cookieState[0].trim(),
							powerBody: bodyState[0].trim()
						})
						toast('Power setup saved')
						showConfigState[1](false)
						changed()
					}
				}),
				s.powerUrl ? h(Button, {
					text: 'Clear',
					variant: 'destructive',
					onPress: function () {
						updateServer(s.id, {
							powerUrl: '',
							powerToken: '',
							powerCsrf: '',
							powerCookie: '',
							powerBody: ''
						})
						urlState[1]('')
						tokenState[1]('')
						csrfState[1]('')
						cookieState[1]('')
						bodyState[1]('')
						toast('Power setup cleared')
						changed()
					}
				}) : null
			])
		) : null

		var clearButton = 			h2.checks ? h(Button, { text: 'Clear this history', onPress: function () { var map = history(); delete map[s.id]; saveHistory(map); changed() } }) : null
		var grid = function (list) { return h(RN.View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 } }, list) }
		var tabs = h(Segmented, { compact: true, value: tab, onChange: function (v) { tabState[1](v) }, items: [{ value: 'overview', label: 'Overview' }, { value: 'players', label: 'Players' }, { value: 'info', label: 'Info' }, { value: 'history', label: 'History' }, { value: 'power', label: 'Power' }] })
		var page = tab === 'players'
			? [playersCard || T({ key: 'np', variant: 'text-sm/medium', color: 'text-muted' }, 'The server is offline, so there is no player list.'), checkedLine]
			: tab === 'info'
			? [grid([ipStat, portStat]), modsCard || T({ key: 'nm', variant: 'text-sm/medium', color: 'text-muted' }, online ? 'This server does not share a list of mods or plugins.' : 'The server is offline.')]
			: tab === 'history'
			? [historyCard, clearButton]
			: tab === 'power'
			? [powerCard, powerConfigCard]
				: [errorCard, reachCard, eulaCard, motdCard, grid([playersStat, pingStat, versionStat, softwareStat]), checkedLine]
		var content = h(RN.View, { style: { gap: 14 } }, backButton, headerRow, tabs, page)
		var asking = pendingDelete.id === s.id && Date.now() - pendingDelete.at < 4000
		var footer = [
			h(Row2, { key: 'a' }, [
				h(Button, { key: 'r', text: loading ? 'Checking…' : 'Refresh', loading: loading, variant: 'primary', onPress: function () { check(s, true) } }),
				h(Button, { key: 'e', text: 'Edit', onPress: function () { props.go({ name: 'edit', id: s.id }) } }),
			]),
			h(Row2, { key: 'b' }, [
				h(Button, { key: 's', text: 'Send to chat', onPress: function () { sendToChat(s, d) } }),
				h(Button, { key: 'd', text: asking ? 'Tap again to delete' : 'Delete', variant: 'destructive', onPress: function () { askDelete(s, function () { props.go({ name: 'list' }) }) } }),
			]),
		]
		return h(SheetBody, { footer: footer }, content)
	}

	// ======================================================================================
	// Adding and editing
	// ======================================================================================
	function EditView(props) {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var Design = valenced.discord.design.Design
		var existing = props.id ? serverById(props.id) : null
		var form = React.useState({
			name: existing ? existing.name : '',
			address: existing ? addressText(existing) : '',
			edition: existing ? existing.edition || 'java' : 'java',
			note: existing ? existing.note || '' : '',
			favorite: existing ? !!existing.favorite : false,
			watch: existing ? !!existing.watch : false,
		})
		var test = React.useState(null)
		var copied = React.useState('')
		React.useEffect(function () {
			if (existing) return
			Promise.resolve(valenced.externals.ReactNativeClipboard.Clipboard.getString()).then(function (text) {
				var first = String(text || '').trim().split(/\s+/)[0]
				if (first && !parseAddress(first).error) copied[1](first)
			}, function () {})
		}, [])
		var f = form[0]
		function put(patch) { form[1](function (prev) { return Object.assign({}, prev, patch) }) }
		function build() {
			var parsed = parseAddress(f.address)
			if (parsed.error) { toast(parsed.error); return null }
			return { id: existing ? existing.id : newId(), name: f.name.trim() || parsed.host, address: parsed.host, port: parsed.port || 0, edition: f.edition, note: f.note.trim(), favorite: f.favorite, watch: f.watch, addedAt: existing ? existing.addedAt : Date.now() }
		}
		function run() {
			var s = build()
			if (!s) return
			test[1]({ loading: true })
			query(s).then(function (d) { test[1]({ data: d, server: s }) })
		}
		function doSave() {
			var s = build()
			if (!s) return
			var list = servers()
			var duplicate = list.filter(function (x) { return x.id !== s.id && x.address === s.address && (x.port || 0) === s.port && x.edition === s.edition })[0]
			if (duplicate) return toast('You already saved ' + duplicate.name + ' with that address')
			saveServers(existing ? list.map(function (x) { return x.id === s.id ? s : x }) : list.concat([s]))
			check(s, true)
			props.go({ name: 'detail', id: s.id })
		}
		var t = test[0]
		var footer = [
			h(Row2, { key: 'buttons' }, [
				h(Button, { key: 'cancel', text: 'Cancel', onPress: function () { props.go(existing ? { name: 'detail', id: existing.id } : { name: 'list' }) } }),
				h(Button, { key: 'save', text: existing ? 'Save changes' : 'Save server', variant: 'primary', onPress: doSave }),
			]),
			existing ? h(Button, { key: 'del', text: pendingDelete.id === existing.id && Date.now() - pendingDelete.at < 4000 ? 'Tap again to delete' : 'Delete server', variant: 'destructive', onPress: function () { askDelete(existing, function () { props.go({ name: 'list' }) }) } }) : null,
		]
		return h(
			SheetBody,
			{ footer: footer },
			h(RN.View, { style: { gap: 14 } },
			h(Button, { text: '‹ Back', onPress: function () { props.go(existing ? { name: 'detail', id: existing.id } : { name: 'list' }) } }),
			T({ variant: 'heading-lg/bold' }, existing ? 'Edit server' : 'Add a server'),
			!existing && copied[0] && !f.address ? h(Button, { text: 'Use the copied address: ' + copied[0].slice(0, 40), onPress: function () { put({ address: copied[0] }) } }) : null,
			h(Design.TextInput, { label: 'Server address', description: 'Like play.example.com or play.example.com:25566', placeholder: 'play.example.com', size: 'md', value: f.address, onChange: function (v) { put({ address: v }) }, autoCapitalize: 'none', autoCorrect: false }),
			h(Design.TextInput, { label: 'Name (optional)', placeholder: 'My survival server', size: 'md', maxLength: 40, value: f.name, onChange: function (v) { put({ name: v }) } }),
			h(RN.View, { style: { gap: 8 } }, T({ variant: 'text-sm/semibold' }, 'Edition'), h(Segmented, { items: [{ value: 'java', label: 'Java' }, { value: 'bedrock', label: 'Bedrock' }], value: f.edition, onChange: function (v) { put({ edition: v }) } })),
			h(Design.TextInput, { label: 'Note (optional)', placeholder: 'Whitelist: ask Sam', size: 'md', maxLength: 120, value: f.note, onChange: function (v) { put({ note: v }) } }),
			h(Design.TableRowGroup, null, [
				h(Design.TableSwitchRow, { key: 'fav', label: 'Favorite', subLabel: 'Shown with a star, and first when sorted by favorites', value: f.favorite, onValueChange: function (v) { put({ favorite: v }) } }),
				h(Design.TableSwitchRow, { key: 'watch', label: 'Tell me when it goes online or offline', subLabel: 'Needs "Alerts" turned on in the plugin settings', value: f.watch, onValueChange: function (v) { put({ watch: v }) } }),
			]),
			h(Button, { text: t && t.loading ? 'Checking…' : 'Test this address', loading: !!(t && t.loading), onPress: run }),
			t && t.data
				? h(
						Card,
						null,
						t.data.error
							? [T({ key: 'e', variant: 'text-md/semibold', style: { color: AMBER } }, 'No answer'), T({ key: 'm', variant: 'text-sm/medium' }, t.data.error)]
							: t.data.online
							? [
									h(Chip, { key: 'c', text: 'Online', color: GREEN, dot: true }),
									T({ key: 'p', variant: 'text-md/semibold' }, t.data.players.online + (t.data.players.max ? '/' + t.data.players.max : '') + ' players' + (t.data.ping !== null ? ' · ' + t.data.ping + ' ms' : '')),
									T({ key: 'v', variant: 'text-sm/medium', color: 'text-muted' }, [t.data.software, t.data.version].filter(Boolean).join(' ') || 'Version not shared'),
							  ]
							: [h(Chip, { key: 'c', text: 'Offline', color: RED, dot: true }), T({ key: 'm', variant: 'text-sm/medium', color: 'text-muted' }, 'The server answered that it is not online, or it is not reachable.')],
				  )
				: null,
			),
		)
	}

	// ======================================================================================
	// The panel (list, one server, add and edit, all in one sheet)
	// ======================================================================================
	function Panel(props) {
		var React = valenced.react.React
		var tick = React.useState(0)
		var view = React.useState(props.initial || { name: 'list' })
		React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			checkAll(false)
			var seconds = Number(setting('refreshSeconds2'))
			var timer = seconds ? setInterval(function () { checkAll(true) }, seconds * 1000) : null
			return function () {
				listeners = listeners.filter(function (l) { return l !== update })
				if (timer) clearInterval(timer)
			}
		}, [])
		var v = view[0]
		function go(next) { view[1](next) }
		var body = v.name === 'detail' ? h(DetailView, { id: v.id, go: go }) : v.name === 'edit' ? h(EditView, { id: v.id, go: go }) : v.name === 'menu' ? h(MenuView, { id: v.id, go: go }) : h(ListView, { go: go })
		return v.name === 'edit' || v.name === 'detail' ? body : h(SheetBody, null, body)
	}

	// ---- The scrolling part of a sheet ---------------------------------------------------------------
	// Inside a bottom sheet a plain scroll view can lose its touches to the sheet. The sheet library has its own scroll view for that;
	// use it when it can be found, and fall back to the plain one if it cannot be drawn.
	var scrollPick = null
	var boundaryClass = null
	function sheetScrollComponent() {
		var RN = valenced.react.ReactNative
		if (scrollPick) return scrollPick
		var pick = RN.ScrollView
		try {
			if (!setting('plainScroll')) {
				var D = valenced.discord.design.Design
				var c = D && (D.BottomSheetScrollView || D.ActionSheetScrollView)
				if (!c) { var f = finders(); var m = f.lookupModule(f.filters.withProps('BottomSheetScrollView'))[0]; c = m && m.BottomSheetScrollView }
				if (c) pick = c
			}
		} catch (e) {}
		scrollPick = pick
		return pick
	}
	function scrollBoundary() {
		if (boundaryClass) return boundaryClass
		var React = valenced.react.React
		if (typeof React.Component !== 'function') return null
		boundaryClass = class extends React.Component {
			constructor(p) { super(p); this.state = { bad: false } }
			static getDerivedStateFromError() { return { bad: true } }
			componentDidCatch() {}
			render() { return this.state.bad ? this.props.fallback : this.props.children }
		}
		return boundaryClass
	}
	function scrollView(RN, scrollProps, children) {
		var Scroll = sheetScrollComponent()
		var plain = h(RN.ScrollView, scrollProps, children)
		var Boundary = Scroll === RN.ScrollView ? null : scrollBoundary()
		if (!Boundary) return plain
		return h(Boundary, { fallback: plain }, h(Scroll, scrollProps, children))
	}

	/**
	 * How tall the scrolling part of a sheet may be: the window, minus the fixed buttons, minus the room the sheet itself
	 * needs (the gap above it, its handle, the bottom bar of the phone). Too tall and the buttons end up below the screen.
	 */
	function sheetScrollMax(windowHeight, footer) {
		var rows = footer ? (Array.isArray(footer) ? footer.filter(Boolean).length : 1) : 0
		var footerH = rows ? rows * 52 + (rows - 1) * 8 + 28 : 0
		return Math.max(200, Math.round(windowHeight - footerH - (rows ? 200 : 150)))
	}
	/** A sheet whose buttons can stay at the bottom: `footer` is not part of the scrolling part. */
	function SheetBody(props) {
		var Design = valenced.discord.design.Design
		var RN = valenced.react.ReactNative
		var size = RN.useWindowDimensions ? RN.useWindowDimensions() : { height: 800 }
		return h(
			Design.ActionSheet,
			null,
			scrollView(RN, { style: { maxHeight: sheetScrollMax(size.height, props.footer) }, contentContainerStyle: { padding: 16, paddingBottom: props.footer ? 12 : 28 }, keyboardShouldPersistTaps: 'handled', nestedScrollEnabled: true, scrollEnabled: true, bounces: true, showsVerticalScrollIndicator: true }, props.children),
			props.footer ? h(RN.View, { style: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 18, gap: 8 } }, props.footer) : null,
		)
	}

	function openPanel(initial) {
		try {
			valenced.discord.actions.ActionSheetActionCreators.openLazy(Promise.resolve({ default: function () { return h(Panel, { initial: initial }) } }), SHEET_KEY, {})
		} catch (e) {
			toast('Could not open the list: ' + errorText(e).slice(0, 60))
		}
	}

	// ======================================================================================
	// The + menu: a "Minecraft servers" row, shown when + is tapped (not in the hold-down menus)
	// ======================================================================================
	var PLUS_LABELS = { Camera: 1, Photos: 1, Poll: 1, Files: 1, Apps: 1 }
	var PLUS_ICONS = [/camera/i, /image|photo|picture|gallery/i, /poll/i, /paperclip|attach|file|document/i, /\bapps?\b|sparkle|robot|bot/i]
	var assetNames = new Map()

	/** The name of an icon, from its asset ID or its icon component. The same in every language. */
	function iconName(item) {
		if (!item || typeof item !== 'object') return ''
		var src = item.iconSource
		if (typeof src === 'number') {
			if (assetNames.has(src)) return assetNames.get(src)
			var name = ''
			try {
				var a = valenced.assets.AssetsRegistry.getAssetByID(src)
				name = (a && a.name) || ''
			} catch (e) {}
			assetNames.set(src, name)
			return name
		}
		var Component = item.IconComponent
		return (Component && (Component.displayName || Component.name)) || ''
	}
	function plusScore(items) {
		var found = {}
		var strong = false
		items.forEach(function (item) {
			var name = iconName(item)
			if (!name) return
			PLUS_ICONS.forEach(function (re, i) {
				if (re.test(name)) {
					found[i] = true
					if (i === 0 || i === 2) strong = true
				}
			})
		})
		return strong ? Object.keys(found).length : 0
	}
	function countLabels(list, labels) {
		var hits = 0
		for (var i = 0; i < list.length; i++) {
			var label = list[i] && typeof list[i] === 'object' && list[i].label
			if (typeof label === 'string' && labels[label] === 1) hits++
		}
		return hits
	}
	function findIconComponent(names) {
		for (var i = 0; i < names.length; i++) {
			var icon = valenced.utils.discord.lookupGeneratedIconComponent(names[i])
			if (icon) return icon
		}
	}

	/** Discord's menus are data driven, so the row goes into the list of items before the menu draws anything. */
	function decoratePlusItems(result, items) {
		if (setting('placement') !== 'menu') return result
		if (countLabels(items, PLUS_LABELS) < 2 && plusScore(items) < 3) return result
		for (var i = 0; i < items.length; i++) if (items[i] && items[i].__mcServers) return result
		var template = items.find(function (item) { return item && typeof item.label === 'string' })
		if (!template) return result
		var item = Object.assign({}, template, { label: 'Minecraft servers', __mcServers: true })
		;['id', 'key', 'testID', 'nativeID', 'index', 'state'].forEach(function (n) { delete item[n] })
		var lastPress = 0
		var press = function () {
			if (Date.now() - lastPress < 1500) return
			lastPress = Date.now()
			try { valenced.discord.actions.ActionSheetActionCreators.hideAllActionSheets() } catch (e) {}
			setTimeout(function () { openPanel({ name: 'list' }) }, 250)
		}
		;['action', 'onPress', 'onSelect', 'onClick', 'callback', 'handler'].forEach(function (n) { if (n in template || n === 'action') item[n] = press })
		var asset
		;['GlobeEarthIcon', 'ic_globe_24px', 'ServerIcon', 'GameControllerIcon'].forEach(function (name) { if (asset === undefined) { var id = valenced.assets.getAssetIdByName(name); if (id != null) asset = id } })
		var Icon = findIconComponent(['GlobeEarthIcon', 'ServerIcon', 'GameControllerIcon'])
		if (asset !== undefined) item.iconSource = asset
		else delete item.iconSource
		if ('IconComponent' in template || Icon) {
			if (Icon) item.IconComponent = Icon
			else delete item.IconComponent
		}
		status.button = 'added to the + menu'
		changed()
		return valenced.react.React.cloneElement(result, { items: items.concat([item]) })
	}

	function decoratePlusMenu(result) {
		try {
			var props = result && result.props
			if (props && Array.isArray(props.items) && props.items.length >= 2 && props.items.length <= 24) return decoratePlusItems(result, props.items)
			return result
		} catch (e) {
			return result
		}
	}

	function installPlusHook(cleanup) {
		var f = finders()
		var runtime = f.lookupModule(f.filters.withProps('jsx', 'jsxs'))[0] || valenced.react.ReactJSXRuntime
		;['jsx', 'jsxs'].forEach(function (name) {
			if (runtime && typeof runtime[name] === 'function') cleanup(valenced.patcher.after(runtime, name, decoratePlusMenu))
		})
	}

	// ======================================================================================
	// The button by the message box
	// ======================================================================================
	var styles
	function findIcon(names) {
		for (var i = 0; i < names.length; i++) {
			var icon = valenced.utils.discord.lookupGeneratedIconComponent(names[i])
			if (icon) return icon
		}
	}
	function findInTree(node, test, depth) {
		depth = depth || 0
		if (!node || depth > 25) return undefined
		if (Array.isArray(node)) {
			for (var i = 0; i < node.length; i++) {
				var hit = findInTree(node[i], test, depth + 1)
				if (hit) return hit
			}
			return undefined
		}
		if (typeof node !== 'object') return undefined
		if (test(node)) return node
		return node.props ? findInTree(node.props.children, test, depth + 1) : undefined
	}

	function ServersButton() {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var Design = valenced.discord.design.Design
		var tick = React.useState(0)
		React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			return function () { listeners = listeners.filter(function (l) { return l !== update }) }
		}, [])
		var side = setting('placement')
		if (side !== 'left' && side !== 'right') return null
		var sum = summary()
		var Icon = findIcon(['GlobeEarthIcon', 'ServerIcon', 'GameControllerIcon'])
		var Tap = RN.Pressable || RN.TouchableOpacity
		var placed = side === 'right' ? { right: 0, marginRight: 8 } : { left: 0, marginLeft: 8 }
		return h(
			RN.View,
			{ style: Object.assign({ flexDirection: 'row', position: 'absolute', top: -BUTTON_SIZE, zIndex: 3 }, placed), pointerEvents: 'box-none' },
			h(
				Tap,
				{ accessibilityLabel: 'Minecraft servers', onPress: function () { openPanel({ name: 'list' }) }, style: { borderRadius: 2147483647, height: BUTTON_SIZE, minWidth: BUTTON_SIZE, paddingHorizontal: sum.total ? 12 : 0, marginTop: -4, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: surface() } },
				Icon ? h(Icon, { size: 'md' }) : T({ variant: 'text-sm/bold' }, 'MC'),
				sum.total ? T({ variant: 'text-sm/bold', style: { color: sum.online ? GREEN : RED } }, String(sum.online) + '/' + sum.total) : null,
			),
		)
	}

	function decorateInput(ret) {
		var place = setting('placement')
		if ((place !== 'left' && place !== 'right') || !ret || !ret.props) return ret
		var row = findInTree(ret.props.children, function (x) {
			return x && x.type && (x.type.displayName === 'View' || x.type === valenced.react.ReactNative.View) && Array.isArray(x.props && x.props.children)
		})
		if (!row) return ret
		var kids = row.props.children
		if (kids.some(function (k) { return k && k.key === 'minecraft-servers-button' })) return ret
		kids.unshift(h(ServersButton, { key: 'minecraft-servers-button' }))
		status.button = 'floating button added above the message box'
		return ret
	}

	// ======================================================================================
	// Background checks for the alerts
	// ======================================================================================
	function applyTimers() {
		timers.forEach(function (t) { clearInterval(t) })
		timers = []
		if (!setting('alerts')) { status.alerts = 'off'; return }
		var seconds = Math.max(30, Number(setting('alertSeconds')) || 120)
		var watched = function () { return servers().filter(function (s) { return s.watch }) }
		status.alerts = 'checking watched servers every ' + (seconds >= 60 ? seconds / 60 + ' min' : seconds + ' s') + ' while Discord is open'
		timers.push(setInterval(function () { watched().forEach(function (s) { check(s, true) }) }, seconds * 1000))
		watched().forEach(function (s) { check(s, false) })
	}

	// ======================================================================================
	// Backups
	// ======================================================================================
	function importText(text, replace) {
		var added = []
		var data = parse(text, null)
		var items = Array.isArray(data) ? data : data && Array.isArray(data.servers) ? data.servers : null
		if (!items) items = String(text).split(/[\r\n,;]+/).map(function (line) { return { address: line.trim() } }).filter(function (x) { return x.address })
		var list = replace ? [] : servers()
		items.forEach(function (item) {
			if (!item || typeof item.address !== 'string') return
			var parsed = parseAddress(item.address, item.port)
			if (parsed.error) return
			var edition = item.edition === 'bedrock' ? 'bedrock' : 'java'
			if (list.some(function (s) { return s.address === parsed.host && (s.port || 0) === parsed.port && s.edition === edition })) return
			var s = { id: newId(), name: String(item.name || parsed.host).slice(0, 40), address: parsed.host, port: parsed.port || 0, edition: edition, note: String(item.note || '').slice(0, 120), favorite: !!item.favorite, watch: !!item.watch, addedAt: Date.now() }
			list.push(s)
			added.push(s)
		})
		saveServers(list)
		added.forEach(function (s) { check(s, true) })
		return added.length
	}

	// ======================================================================================
	// Settings
	// ======================================================================================
	function SettingsComponent(props) {
		var React = valenced.react.React
		var Design = valenced.discord.design.Design
		var RN = valenced.react.ReactNative
		storage = props.api.jsonStorage
		storage.use()
		var tick = React.useState(0)
		React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			return function () { listeners = listeners.filter(function (l) { return l !== update }) }
		}, [])
		var list = sorted(servers())
		var sum = summary()
		var current = {
			provider: setting('provider'), timeout: String(setting('timeout')), cacheSeconds: String(setting('cacheSeconds')), refreshSeconds2: String(setting('refreshSeconds2')),
			sort: setting('sort'), pingSource: setting('pingSource'), pingSamples: String(setting('pingSamples')), placement: setting('placement'), alertSeconds: String(setting('alertSeconds')), historyLength: String(setting('historyLength')),
		}
		function put(key, value) {
			var patch = {}
			patch[key] = value
			save(patch)
			if (key === 'alerts' || key === 'alertSeconds') applyTimers()
			changed()
		}
		function radio(title, key, items, asNumber) {
			return h(
				Design.TableRadioGroup,
				{ key: key, title: title, value: current[key], onChange: function (v) { put(key, asNumber ? Number(v) : v) } },
				items.map(function (r) { return h(Design.TableRadioRow, { key: r.value, label: r.label, subLabel: r.subLabel, value: r.value }) }),
			)
		}
		function toggle(key, label, subLabel) {
			return h(Design.TableSwitchRow, { key: key, label: label, subLabel: subLabel, value: !!setting(key), onValueChange: function (v) { put(key, v) } })
		}
		function row(label, subLabel, onPress, extra) {
			return h(Design.TableRow, Object.assign({ key: label, label: label, subLabel: subLabel, onPress: onPress }, extra || {}))
		}
		function dot(c) { return h(RN.View, { style: { width: 14, height: 14, borderRadius: 7, backgroundColor: c } }) }
		var serverRows = list.map(function (s) {
			var st = statusOf(s)
			var d = results[s.id] && results[s.id].data
			return h(Design.TableRow, { key: s.id, label: (s.favorite ? '★ ' : '') + s.name, subLabel: addressText(s) + ' · ' + (st.key === 'online' ? d.players.online + (d.players.max ? '/' + d.players.max : '') + ' players' + (d.ping !== null ? ' · ' + d.ping + ' ms' : '') : st.label), icon: dot(st.color), onPress: function () { openPanel({ name: 'detail', id: s.id }) } })
		})
		return h(
			RN.ScrollView,
			{ style: { flex: 1 }, contentContainerStyle: { paddingBottom: 38 }, keyboardShouldPersistTaps: 'handled' },
			h(
				Design.Stack,
				{ style: { paddingVertical: 24, paddingHorizontal: 12 }, spacing: 24 },
				h(
					Card,
					null,
					T({ variant: 'heading-lg/bold' }, 'Minecraft servers'),
					T({ variant: 'text-sm/medium', color: 'text-muted' }, sum.total ? sum.online + ' of ' + sum.total + ' online · ' + sum.players + ' player' + (sum.players === 1 ? '' : 's') + ' playing' : 'No servers saved yet.'),
					h(Row2, null, [
						h(Button, { key: 'open', text: 'Open the list', variant: 'primary', onPress: function () { openPanel({ name: 'list' }) } }),
						h(Button, { key: 'add', text: '+ Add server', onPress: function () { openPanel({ name: 'edit', id: null }) } }),
					]),
				),
				h(
					Design.TableRowGroup,
					{ title: 'Your servers (' + list.length + ')' },
					serverRows.length ? serverRows : [h(Design.TableRow, { key: 'none', label: 'Nothing saved yet', subLabel: 'Tap + Add server above, or paste a list under Backup.' })],
				),
				radio('Where the numbers come from', 'provider', [
					{ value: 'auto', label: 'Automatic', subLabel: 'mcstatus.io, with minetools.eu for the ping and mcsrvstat.us as a backup' },
					{ value: 'mcstatus', label: 'mcstatus.io', subLabel: 'Java and Bedrock. No ping' },
					{ value: 'mcsrvstat', label: 'mcsrvstat.us', subLabel: 'Java and Bedrock. No ping' },
					{ value: 'minetools', label: 'minetools.eu', subLabel: 'Java only. Gives the ping' },
				]),
				radio('Where the ping comes from', 'pingSource', [
					{ value: 'phone', label: 'Your phone (recommended)', subLabel: 'Measured from your own network, so it matches what you get in the game' },
					{ value: 'site', label: 'The status site', subLabel: 'Measured from the site\'s computer, which may be far from you' },
				]),
				toggle('plainScroll', 'Plain scrolling in panels', 'Turn this on if a panel will not scroll or looks wrong. Off uses the sheet\'s own scrolling when it can be found.'),
				toggle('liveCounts', 'Live player count', 'Status sites keep an answer for a minute or more, so a player who just joined can be missing. This also asks minetools.eu, which asks the server itself.'),
				radio('Ping measurements', 'pingSamples', [{ value: '3', label: '3 tries', subLabel: 'Quicker' }, { value: '4', label: '4 tries' }, { value: '6', label: '6 tries', subLabel: 'Steadier' }], true),
				radio('Wait for an answer', 'timeout', [{ value: '5', label: '5 seconds' }, { value: '8', label: '8 seconds' }, { value: '12', label: '12 seconds' }, { value: '20', label: '20 seconds' }], true),
				radio('Keep an answer', 'cacheSeconds', [{ value: '0', label: 'Always check again' }, { value: '20', label: '20 seconds', subLabel: 'Opening the list again right away does not ask again' }, { value: '60', label: '1 minute' }, { value: '300', label: '5 minutes' }], true),
				radio('While a panel is open', 'refreshSeconds2', [{ value: '0', label: 'Only when I tap Refresh' }, { value: '15', label: 'Every 15 seconds' }, { value: '30', label: 'Every 30 seconds', subLabel: 'The list and a server\'s screen update by themselves' }, { value: '60', label: 'Every minute' }], true),
				h(
					Design.TableRowGroup,
					{ title: 'How it looks' },
					toggle('compact', 'Compact rows', 'Smaller rows with less text, so more servers fit'),
					toggle('icons', 'Server icons', 'Shows each server\'s own icon when it has one'),
					toggle('motd', 'Message of the day', 'Shows the text a server shows in the Minecraft server list'),
					toggle('heads', 'Player heads', 'Shows each player\'s Minecraft head next to their name'),
				),
				radio('Order of the list', 'sort', [{ value: 'manual', label: 'The order I added them' }, { value: 'status', label: 'Online first' }, { value: 'players', label: 'Most players first' }, { value: 'name', label: 'A to Z' }, { value: 'favorites', label: 'Favorites first' }]),
				radio('Where to open the list', 'placement', [{ value: 'menu', label: 'In the + menu', subLabel: 'A Minecraft servers row appears when you tap + next to the message box. Nothing else is added to the chat' }, { value: 'left', label: 'Button, left', subLabel: 'A small button above the message box, always visible' }, { value: 'right', label: 'Button, right', subLabel: 'The same button on the right' }, { value: 'off', label: 'Only from this page', subLabel: 'Open the list from the settings' }]),
				h(
					Design.TableRowGroup,
					{ title: 'Alerts' },
					toggle('alerts', 'Tell me when a server goes online or offline', 'Only for servers marked "Tell me when it goes online or offline", and only while Discord is open'),
				),
				setting('alerts') ? radio('How often to check', 'alertSeconds', [{ value: '60', label: 'Every minute' }, { value: '120', label: 'Every 2 minutes' }, { value: '300', label: 'Every 5 minutes' }, { value: '600', label: 'Every 10 minutes' }], true) : null,
				radio('Remember how many checks', 'historyLength', [{ value: '20', label: '20 checks' }, { value: '40', label: '40 checks' }, { value: '60', label: '60 checks' }], true),
				h(
					Design.TableRowGroup,
					{ title: 'Actions' },
					row('Check every server now', 'Ignores saved answers', function () { checkAll(true).then(function () { toast('Done') }) }),
					row('Clear all history', 'Forgets the past checks of every server', function () { saveHistory({}); toast('History cleared'); changed() }),
				),
				h(
					Design.TableRowGroup,
					{ title: 'Backup' },
					row('Copy my servers', 'Copies them as text you can keep or share', function () { copy(JSON.stringify(servers().map(function (s) { return { name: s.name, address: addressText(s), edition: s.edition, note: s.note, favorite: s.favorite, watch: s.watch } }), null, 1), 'Servers') }),
					row('Add servers from the clipboard', 'Copied text from "Copy my servers", or one address per line', function () {
						Promise.resolve(valenced.externals.ReactNativeClipboard.Clipboard.getString()).then(function (text) {
							var n = importText(text, false)
							toast(n ? 'Added ' + n + ' server' + (n === 1 ? '' : 's') : 'No new servers found in that text')
						}, function () { toast('Could not read the clipboard') })
					}),
					row('Replace everything from the clipboard', 'Removes your servers first', function () {
						Promise.resolve(valenced.externals.ReactNativeClipboard.Clipboard.getString()).then(function (text) {
							var n = importText(text, true)
							toast(n ? 'Loaded ' + n + ' server' + (n === 1 ? '' : 's') : 'Nothing was loaded')
						}, function () { toast('Could not read the clipboard') })
					}),
				),
				h(
					Design.TableRowGroup,
					{ title: 'About' },
					h(Design.TableRow, { key: 'privacy', label: 'Where the addresses go', subLabel: 'A phone cannot talk to a Minecraft server directly, so the addresses you save are sent to the status site you chose above, which asks the server for you.' }),
					h(Design.TableRow, { key: 'ping', label: 'About the ping', subLabel: 'By default the ping is measured from your own phone, so it follows your own network. It is an estimate: it times how fast the server closes a connection and divides by the factor you set under Ping. The status sites measure from their own computers, which are often far away.' }),
					h(Design.TableRow, { key: 'names', label: 'About player names', subLabel: 'Many servers only share a few names, or none. The count is always right.' }),
					h(Design.TableRow, { key: 'status', label: 'Where it opens from', subLabel: status.button }),
					h(Design.TableRow, { key: 'alerts', label: 'Alerts', subLabel: status.alerts }),
					status.error ? h(Design.TableRow, { key: 'error', label: 'Problem', subLabel: status.error }) : null,
				),
			),
		)
	}

	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
	exports.default = plugin({
		jsonStorage: { load: true, default: defaults },
		SettingsComponent: SettingsComponent,
		start: function (api) {
			var cleanup = api.cleanup
			storage = api.jsonStorage
			var f = finders()
			cleanup(
				f.getModules(
					f.filters.withName('ChatInputGuardWrapper'),
					function (module) {
						if (!module || typeof module.default !== 'function') return
						try {
							cleanup(
								valenced.patcher.instead(module, 'default', function (args, original) {
									var ret = Reflect.apply(original, this, args)
									try { return decorateInput(ret) } catch (e) { return ret }
								}),
							)
						} catch (e) {
							status.button = 'could not be added: ' + errorText(e).slice(0, 60)
						}
					},
					{ returnNamespace: true },
				),
			)
			try { installPlusHook(cleanup) } catch (e) { status.error = errorText(e).slice(0, 80) }
			try { applyTimers() } catch (e) { status.error = errorText(e).slice(0, 80) }
			// Servers that were saved get a first check in the background, so the button already shows how many are online.
			setTimeout(function () { try { checkAll(false) } catch (e) {} }, 4000)
			cleanup(function () {
				timers.forEach(function (t) { clearInterval(t) })
				timers = []
				listeners = []
				try { valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(SHEET_KEY) } catch (e) {}
			})
		},
	})
	return exports
})({})
