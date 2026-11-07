(function (exports) {
	'use strict'

	/*
	 * JioSaavn Music Player for Valenced Discord Mobile Client.
	 * Stream ad-free, high quality (up to 320kbps) audio directly inside Discord
	 * with synchronized lyrics (LRCLIB), instant search, queue management,
	 * floating mini-player pill, and background playback.
	 *
	 * Direct CDN streaming via saavncdn.com with embedded DES-ECB decryption.
	 */

	var PLUGIN_ID = 'asaprajx.jiosaavn'
	var SHEET_KEY = 'asaprajx.jiosaavn.panel'
	var TOAST_ID = 'ASAP_JIOSAAVN'

	var defaults = {
		audioQuality: '320', // '320' | '160' | '96'
		autoPlayNext: true,
		showMiniPlayer: true,
		savedQueue: '[]',
		savedHistory: '[]'
	}

	var ACCENT_COLOR = '#2bc5b4' // JioSaavn Signature Cyan / Teal
	var BUTTON_SIZE = 36

	var storage
	var listeners = []
	var timers = []

	var playerState = {
		status: 'idle', // 'idle' | 'loading' | 'playing' | 'paused' | 'error'
		track: null,    // { id, title, artist, album, duration, durationSec, thumbnail, encryptedUrl, has320 }
		streamUrl: '',
		position: 0,
		duration: 0,
		error: '',
		repeat: false,
		shuffle: false
	}

	var queue = []
	var history = []

	var lyricsState = {
		status: 'idle', // 'idle' | 'loading' | 'loaded' | 'error'
		synced: [],     // [ { timeMs: number, text: string } ]
		plain: '',
		activeIndex: -1
	}

	var searchState = {
		query: '',
		loading: false,
		results: [],
		error: ''
	}

	var activeAudioRef = { current: null }
	var activeLyricScrollRef = { current: null }

	// ======================================================================================
	// Core Utilities & Metro Finders
	// ======================================================================================
	function finders() {
		return valenced.modules.finders
	}

	function setting(key) {
		var s = storage && storage.cache
		return s && s[key] !== undefined ? s[key] : defaults[key]
	}

	function save(patch) {
		try { if (storage && typeof storage.set === 'function') storage.set(patch) } catch (e) {}
		try { if (storage && storage.cache) Object.assign(storage.cache, patch) } catch (e) {}
	}

	function setSetting(key, val) {
		var patch = {}
		patch[key] = val
		save(patch)
	}

	function changed() {
		listeners.slice().forEach(function (l) {
			try { l() } catch (e) {}
		})
	}

	function toast(text) {
		try {
			valenced.discord.actions.ToastActionCreators.open(TOAST_ID, { text: String(text) })
		} catch (e) {}
	}

	function copy(text, label) {
		try {
			valenced.externals.ReactNativeClipboard.Clipboard.setString(String(text))
			toast((label || 'Text') + ' copied')
		} catch (e) {
			toast('Could not copy')
		}
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

	function formatTime(totalSec) {
		if (!totalSec || isNaN(totalSec) || totalSec < 0) return '0:00'
		var s = Math.floor(totalSec)
		var m = Math.floor(s / 60)
		var remSec = s % 60
		return String(m) + ':' + (remSec < 10 ? '0' : '') + String(remSec)
	}

	function color(token, fallback) {
		try {
			return valenced.discord.common.tokens.Tokens.default.colors[token] || fallback
		} catch (e) {
			return fallback
		}
	}

	function surface() {
		return color('BACKGROUND_SECONDARY', '#2b2d31')
	}

	function surfaceTertiary() {
		return color('BACKGROUND_TERTIARY', '#1e1f22')
	}

	function textNormal() {
		return color('TEXT_NORMAL', '#dbdee1')
	}

	function textMuted() {
		return color('TEXT_MUTED', '#949ba4')
	}

	function timeoutFetch(url, options, timeoutSec) {
		return new Promise(function (resolve, reject) {
			var done = false
			var controller = typeof AbortController === 'function' ? new AbortController() : null
			var timer = setTimeout(function () {
				if (done) return
				done = true
				if (controller) try { controller.abort() } catch (e) {}
				reject(new Error('Request timed out (' + (timeoutSec || 10) + 's)'))
			}, (timeoutSec || 10) * 1000)

			var opts = Object.assign({}, options || {})
			if (controller) opts.signal = controller.signal

			fetch(url, opts).then(function (res) {
				if (done) return
				done = true
				clearTimeout(timer)
				resolve(res)
			}, function (err) {
				if (done) return
				done = true
				clearTimeout(timer)
				reject(err)
			})
		})
	}

	function decodeHtmlEntities(str) {
		if (!str) return ''
		return String(str)
			.replace(/&quot;/g, '"')
			.replace(/&amp;/g, '&')
			.replace(/&#039;/g, "'")
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&#(\d+);/g, function (m, num) { return String.fromCharCode(Number(num)) })
	}

	// ======================================================================================
	// Pure JavaScript DES-ECB Decryption Engine for JioSaavn Media URLs
	// ======================================================================================
	var DES_KEY_BYTES = [51, 56, 51, 52, 54, 53, 57, 49] // '38346591' in ASCII

	var DES_IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7]
	var DES_FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25]
	var DES_E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1]
	var DES_P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25]
	var DES_PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4]
	var DES_PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32]
	var DES_SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1]
	var DES_S = [
		[14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
		[15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
		[10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
		[7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
		[2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
		[12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
		[4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
		[13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
	]

	function bitsToBytes(bits) {
		var bytes = []
		for (var i = 0; i < bits.length; i += 8) {
			var b = 0
			for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
			bytes.push(b)
		}
		return bytes
	}

	function generateSubkeys(keyBytes) {
		var keyBits = []
		for (var i = 0; i < 8; i++) {
			for (var j = 7; j >= 0; j--) keyBits.push((keyBytes[i] >> j) & 1)
		}
		var pc1Bits = []
		for (var k = 0; k < DES_PC1.length; k++) pc1Bits.push(keyBits[DES_PC1[k] - 1])
		var C = pc1Bits.slice(0, 28)
		var D = pc1Bits.slice(28, 56)
		var subkeys = []
		for (var round = 0; round < 16; round++) {
			var shift = DES_SHIFTS[round]
			C = C.slice(shift).concat(C.slice(0, shift))
			D = D.slice(shift).concat(D.slice(0, shift))
			var CD = C.concat(D)
			var roundKey = []
			for (var p = 0; p < DES_PC2.length; p++) roundKey.push(CD[DES_PC2[p] - 1])
			subkeys.push(roundKey)
		}
		return subkeys
	}

	function desFeistel(R, subkey) {
		var expanded = []
		for (var i = 0; i < DES_E.length; i++) expanded.push(R[DES_E[i] - 1] ^ subkey[i])
		var sOut = []
		for (var b = 0; b < 8; b++) {
			var six = expanded.slice(b * 6, (b + 1) * 6)
			var row = (six[0] << 1) | six[5]
			var col = (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4]
			var val = DES_S[b][row * 16 + col]
			for (var j = 3; j >= 0; j--) sOut.push((val >> j) & 1)
		}
		var pOut = []
		for (var m = 0; m < DES_P.length; m++) pOut.push(sOut[DES_P[m] - 1])
		return pOut
	}

	function decryptBlock(blockBytes, subkeys) {
		var bits = []
		for (var i = 0; i < 8; i++) {
			for (var j = 7; j >= 0; j--) bits.push((blockBytes[i] >> j) & 1)
		}
		var ipBits = []
		for (var k = 0; k < DES_IP.length; k++) ipBits.push(bits[DES_IP[k] - 1])
		var L = ipBits.slice(0, 32)
		var R = ipBits.slice(32, 64)
		for (var round = 15; round >= 0; round--) {
			var f = desFeistel(R, subkeys[round])
			var nextR = []
			for (var m = 0; m < 32; m++) nextR.push(L[m] ^ f[m])
			L = R
			R = nextR
		}
		var preOutput = R.concat(L)
		var fpBits = []
		for (var n = 0; n < DES_FP.length; n++) fpBits.push(preOutput[DES_FP[n] - 1])
		return bitsToBytes(fpBits)
	}

	function desEcbDecrypt(cipherBytes, keyBytes) {
		var subkeys = generateSubkeys(keyBytes)
		var plainBytes = []
		for (var i = 0; i < cipherBytes.length; i += 8) {
			var block = cipherBytes.slice(i, i + 8)
			var dec = decryptBlock(block, subkeys)
			for (var d = 0; d < dec.length; d++) plainBytes.push(dec[d])
		}
		var pad = plainBytes[plainBytes.length - 1]
		if (pad >= 1 && pad <= 8) {
			var ok = true
			for (var k = plainBytes.length - pad; k < plainBytes.length; k++) {
				if (plainBytes[k] !== pad) { ok = false; break }
			}
			if (ok) return plainBytes.slice(0, plainBytes.length - pad)
		}
		return plainBytes
	}

	function base64ToBytes(b64) {
		var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
		var lookup = new Uint8Array(256)
		for (var i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
		var str = String(b64).replace(/[\r\n\t =]/g, '')
		var bytes = []
		var u24 = 0
		var bits = 0
		for (var j = 0; j < str.length; j++) {
			u24 = (u24 << 6) | lookup[str.charCodeAt(j)]
			bits += 6
			if (bits >= 8) {
				bits -= 8
				bytes.push((u24 >> bits) & 0xff)
			}
		}
		return bytes
	}

	function decryptMediaUrl(encB64) {
		if (!encB64) return null
		try {
			var cBytes = base64ToBytes(encB64)
			var pBytes = desEcbDecrypt(cBytes, DES_KEY_BYTES)
			var str = ''
			for (var i = 0; i < pBytes.length; i++) str += String.fromCharCode(pBytes[i])
			return str.trim()
		} catch (e) {
			return null
		}
	}

	// ======================================================================================
	// JioSaavn Search & Stream Resolution
	// ======================================================================================
	var JIOSAAVN_HEADERS = {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		'X-Forwarded-For': '103.57.226.15'
	}

	function searchJioSaavn(query) {
		var q = String(query).trim()
		var url = 'https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&ctx=web6dot0&api_version=4&n=25&p=1&q=' + encodeURIComponent(q)
		return timeoutFetch(url, { headers: JIOSAAVN_HEADERS }, 8).then(function (res) {
			if (!res.ok) throw new Error('JioSaavn status ' + res.status)
			return res.json()
		}).then(function (data) {
			var results = data && (data.results || (data.data && data.data.results))
			if (!Array.isArray(results) || results.length === 0) return []
			return results.map(function (item) {
				var more = item.more_info || {}
				var artists = (more.artistMap && more.artistMap.primary_artists && more.artistMap.primary_artists.map(function (a) { return a.name }).join(', ')) ||
				              (more.music) ||
				              (item.subtitle ? item.subtitle.split(' - ')[0] : '') ||
				              'JioSaavn'
				var durSec = Number(more.duration) || 0
				var img = item.image ? String(item.image).replace('150x150', '500x500') : ''
				return {
					id: item.id,
					title: decodeHtmlEntities(item.title),
					artist: decodeHtmlEntities(artists),
					album: decodeHtmlEntities(more.album || (item.subtitle && item.subtitle.split(' - ')[1]) || ''),
					duration: formatTime(durSec),
					durationSec: durSec,
					thumbnail: img,
					has320: more['320kbps'] === 'true' || more['320kbps'] === true,
					encryptedUrl: more.encrypted_media_url || ''
				}
			})
		})
	}

	function getTrackEncryptedUrl(trackId) {
		var url = 'https://www.jiosaavn.com/api.php?__call=song.getDetails&_format=json&_marker=0&ctx=web6dot0&api_version=4&cc=in&pids=' + encodeURIComponent(trackId)
		return timeoutFetch(url, { headers: JIOSAAVN_HEADERS }, 8).then(function (res) {
			if (!res.ok) throw new Error('Details status ' + res.status)
			return res.json()
		}).then(function (json) {
			var song = (json && json.songs && json.songs[0]) || (json && json[trackId])
			var more = song && (song.more_info || song)
			return (more && more.encrypted_media_url) || null
		})
	}

	function resolveAudioStream(track) {
		var quality = String(setting('audioQuality') || '320')
		var p = track.encryptedUrl ? Promise.resolve(track.encryptedUrl) : getTrackEncryptedUrl(track.id)

		return p.then(function (encUrl) {
			if (!encUrl) throw new Error('No encrypted stream URL available')
			var base = decryptMediaUrl(encUrl)
			if (!base || base.indexOf('saavncdn.com') === -1) {
				throw new Error('Failed to decrypt audio stream')
			}
			// Select quality bitrate
			var finalUrl = base
			if (quality === '320' && track.has320 !== false) {
				finalUrl = base.replace(/_96\.(mp4|mp3)/i, '_320.mp4').replace(/_160\.(mp4|mp3)/i, '_320.mp4')
			} else if (quality === '160') {
				finalUrl = base.replace(/_96\.(mp4|mp3)/i, '_160.mp4').replace(/_320\.(mp4|mp3)/i, '_160.mp4')
			} else if (quality === '96') {
				finalUrl = base.replace(/_320\.(mp4|mp3)/i, '_96.mp4').replace(/_160\.(mp4|mp3)/i, '_96.mp4')
			} else {
				finalUrl = base.replace(/_96\.(mp4|mp3)/i, '_320.mp4').replace(/_160\.(mp4|mp3)/i, '_320.mp4')
			}
			return { url: finalUrl, durationSec: track.durationSec }
		})
	}

	function performSearch(query) {
		var q = String(query || '').trim()
		if (!q) {
			searchState.results = []
			searchState.error = ''
			searchState.loading = false
			changed()
			return
		}

		searchState.query = q
		searchState.loading = true
		searchState.error = ''
		changed()

		searchJioSaavn(q).then(function (songs) {
			searchState.loading = false
			searchState.results = songs || []
			if (!songs || songs.length === 0) {
				searchState.error = 'No songs found for "' + q + '"'
			}
			changed()
		}).catch(function (err) {
			searchState.loading = false
			searchState.error = 'Search failed: ' + String((err && err.message) || err)
			changed()
		})
	}

	// ======================================================================================
	// LRCLIB Synchronized Lyrics Engine
	// ======================================================================================
	function parseLRC(lrcText) {
		if (!lrcText) return []
		var lines = lrcText.split('\n')
		var parsed = []
		var reg = /^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/
		for (var i = 0; i < lines.length; i++) {
			var m = reg.exec(lines[i].trim())
			if (m) {
				var min = Number(m[1])
				var sec = Number(m[2])
				var msStr = m[3]
				var ms = Number(msStr.length === 2 ? msStr + '0' : msStr)
				var timeMs = (min * 60 + sec) * 1000 + ms
				var text = m[4].trim()
				if (text) parsed.push({ timeMs: timeMs, text: text })
			}
		}
		parsed.sort(function (a, b) { return a.timeMs - b.timeMs })
		return parsed
	}

	function loadLyrics(track) {
		if (!track) return
		lyricsState.status = 'loading'
		lyricsState.synced = []
		lyricsState.plain = ''
		lyricsState.activeIndex = -1
		changed()

		var cleanTitle = track.title.replace(/\(.*?\)|\[.*?\]/g, '').replace(/official\s*(music\s*)?video/i, '').trim()
		var getUrl = 'https://lrclib.net/api/get?track_name=' + encodeURIComponent(cleanTitle) + '&artist_name=' + encodeURIComponent(track.artist)

		timeoutFetch(getUrl, {
			headers: { 'User-Agent': 'ValencedJioSaavnPlayer/1.0 (https://github.com/asaprajx/ASAP-plugins)' }
		}, 6).then(function (res) {
			if (res.ok) return res.json()
			throw new Error('Not found directly')
		}).catch(function () {
			var searchUrl = 'https://lrclib.net/api/search?q=' + encodeURIComponent(cleanTitle + ' ' + track.artist)
			return timeoutFetch(searchUrl, {
				headers: { 'User-Agent': 'ValencedJioSaavnPlayer/1.0 (https://github.com/asaprajx/ASAP-plugins)' }
			}, 6).then(function (res) {
				if (!res.ok) throw new Error('LRCLIB search error')
				return res.json()
			}).then(function (list) {
				if (Array.isArray(list) && list.length > 0) {
					var withSync = list.find(function (item) { return item && item.syncedLyrics })
					return withSync || list[0]
				}
				throw new Error('No lyrics found')
			})
		}).then(function (data) {
			if (playerState.track && playerState.track.id === track.id) {
				lyricsState.status = 'loaded'
				lyricsState.plain = data.plainLyrics || ''
				lyricsState.synced = parseLRC(data.syncedLyrics)
				lyricsState.activeIndex = -1
				changed()
			}
		}).catch(function () {
			if (playerState.track && playerState.track.id === track.id) {
				lyricsState.status = 'error'
				lyricsState.synced = []
				lyricsState.plain = ''
				changed()
			}
		})
	}

	function updateLyricPosition(currentTimeSec) {
		if (!lyricsState.synced || lyricsState.synced.length === 0) return
		var curMs = currentTimeSec * 1000
		var foundIdx = -1
		for (var i = 0; i < lyricsState.synced.length; i++) {
			if (lyricsState.synced[i].timeMs <= curMs) {
				foundIdx = i
			} else {
				break
			}
		}
		if (foundIdx !== lyricsState.activeIndex) {
			lyricsState.activeIndex = foundIdx
			changed()
			if (activeLyricScrollRef.current && foundIdx >= 0) {
				try {
					activeLyricScrollRef.current.scrollTo({ y: Math.max(0, foundIdx * 38 - 60), animated: true })
				} catch (e) {}
			}
		}
	}

	// ======================================================================================
	// Player Lifecycle & Controls
	// ======================================================================================
	function playTrack(track) {
		if (!track) return
		playerState.track = track
		playerState.status = 'loading'
		playerState.position = 0
		playerState.duration = track.durationSec || 0
		playerState.error = ''
		changed()

		loadLyrics(track)

		history = [track].concat(history.filter(function (t) { return t.id !== track.id })).slice(0, 50)
		try { setSetting('savedHistory', JSON.stringify(history)) } catch (e) {}

		resolveAudioStream(track).then(function (res) {
			if (playerState.track && playerState.track.id === track.id) {
				var url = typeof res === 'string' ? res : res.url
				var dur = (res && res.durationSec) || (track && track.durationSec) || 0
				playerState.streamUrl = url
				if (dur > 0) playerState.duration = dur
				playerState.status = 'playing'
				toast('Playing: ' + track.title)
				changed()
			}
		}).catch(function (err) {
			if (playerState.track && playerState.track.id === track.id) {
				playerState.status = 'error'
				playerState.error = 'Stream failed: ' + String((err && err.message) || err)
				toast('Stream error: ' + String((err && err.message) || err))
				changed()
			}
		})
	}

	function togglePlayPause() {
		if (playerState.status === 'playing') {
			playerState.status = 'paused'
			changed()
		} else if (playerState.status === 'paused') {
			playerState.status = 'playing'
			changed()
		} else if (playerState.track) {
			playTrack(playerState.track)
		}
	}

	function seekTo(seconds) {
		var clamped = Math.max(0, Math.min(seconds, playerState.duration || 99999))
		playerState.position = clamped
		if (activeAudioRef.current && typeof activeAudioRef.current.seek === 'function') {
			try { activeAudioRef.current.seek(clamped) } catch (e) {}
		}
		updateLyricPosition(clamped)
		changed()
	}

	function nextTrack() {
		if (queue.length > 0) {
			var next = queue.shift()
			try { setSetting('savedQueue', JSON.stringify(queue)) } catch (e) {}
			playTrack(next)
		} else {
			toast('Queue is empty')
		}
	}

	function prevTrack() {
		if (playerState.position > 3) {
			seekTo(0)
		} else if (history.length > 1) {
			var prev = history[1]
			playTrack(prev)
		} else {
			seekTo(0)
		}
	}

	function addToQueue(track) {
		if (!track) return
		queue.push(track)
		try { setSetting('savedQueue', JSON.stringify(queue)) } catch (e) {}
		toast('Added to queue: ' + track.title)
		changed()
	}

	function removeFromQueue(index) {
		if (index >= 0 && index < queue.length) {
			queue.splice(index, 1)
			try { setSetting('savedQueue', JSON.stringify(queue)) } catch (e) {}
			changed()
		}
	}

	function clearQueue() {
		queue = []
		try { setSetting('savedQueue', JSON.stringify(queue)) } catch (e) {}
		toast('Queue cleared')
		changed()
	}

	// ======================================================================================
	// React Native Video / Audio Player Engine Component
	// ======================================================================================
	var cachedVideoComponent = undefined
	function findVideoComponent() {
		if (cachedVideoComponent !== undefined) return cachedVideoComponent
		var f = finders()
		var RN = valenced.react.ReactNative

		// 1. Try finding Video JS component in Metro modules
		try {
			var mods = f.lookupModules(function (m) {
				if (!m) return false
				var target = m.default || m
				return (
					(target && (target.name === 'Video' || target.displayName === 'Video')) ||
					(target && target.Constants && target.Constants.ScaleMode) ||
					(m && m.FilterType && m.ScaleMode)
				)
			})
			if (mods && mods.length > 0) {
				for (var i = 0; i < mods.length; i++) {
					var item = mods[i]
					var exp = (item && item[0]) || item
					var comp = exp && (exp.default || exp)
					if (typeof comp === 'function' || typeof comp === 'object') {
						cachedVideoComponent = comp
						return comp
					}
				}
			}
		} catch (e) {}

		// 2. Try lookupModule with name 'Video'
		try {
			var modWithName = f.lookupModule(f.filters.withName('Video'))
			var compWithName = modWithName && modWithName[0] && (modWithName[0].default || modWithName[0])
			if (compWithName && (typeof compWithName === 'function' || typeof compWithName === 'object')) {
				cachedVideoComponent = compWithName
				return compWithName
			}
		} catch (e2) {}

		// 3. Try Native requireNativeComponent('RCTVideo')
		try {
			if (RN && typeof RN.requireNativeComponent === 'function') {
				var nativeComp = RN.requireNativeComponent('RCTVideo')
				if (nativeComp) {
					cachedVideoComponent = nativeComp
					return nativeComp
				}
			}
		} catch (e3) {}

		cachedVideoComponent = null
		return null
	}

	function AudioPlayerHost() {
		var VideoComp = findVideoComponent()
		if (!VideoComp || !playerState.streamUrl) return null

		var handleLoad = function (data) {
			if (data && typeof data.duration === 'number' && data.duration > 0) {
				playerState.duration = data.duration
				changed()
			}
		}

		var handleProgress = function (data) {
			if (data && typeof data.currentTime === 'number') {
				playerState.position = data.currentTime
				if (data.seekableDuration && !playerState.duration) {
					playerState.duration = data.seekableDuration
				}
				updateLyricPosition(data.currentTime)
				changed()
			}
		}

		var handleEnd = function () {
			if (playerState.repeat) {
				seekTo(0)
			} else if (setting('autoPlayNext') && queue.length > 0) {
				nextTrack()
			} else {
				playerState.status = 'paused'
				playerState.position = 0
				changed()
			}
		}

		var handleError = function (err) {
			playerState.status = 'error'
			var msg = (err && err.error && (err.error.errorString || err.error.message)) ||
			          (err && err.nativeEvent && (err.nativeEvent.errorString || err.nativeEvent.error)) ||
			          'Audio playback error'
			playerState.error = msg
			toast('Player error: ' + msg)
			changed()
		}

		return h(VideoComp, {
			ref: function (ref) {
				activeAudioRef.current = ref
			},
			// Dual source props support both React Native Video wrapper and native RCTVideo
			source: { uri: playerState.streamUrl, type: 'mp4' },
			src: { uri: playerState.streamUrl, isNetwork: true, type: 'mp4' },
			paused: playerState.status !== 'playing',
			volume: 1.0,
			muted: false,
			rate: 1.0,
			playInBackground: true,
			playWhenInactive: true,
			ignoreSilentSwitch: 'ignore',
			audioOnly: true,
			preventsDisplaySleepDuringVideoPlayback: false,
			// Dual event handlers for JS and native event bridges
			onLoad: handleLoad,
			onVideoLoad: handleLoad,
			onProgress: handleProgress,
			onVideoProgress: handleProgress,
			onEnd: handleEnd,
			onVideoEnd: handleEnd,
			onError: handleError,
			onVideoError: handleError,
			// Android Yoga view layout requires non-zero dimensions to attach native surface
			style: { position: 'absolute', width: 1, height: 1, opacity: 0.01, left: -100 }
		})
	}

	// ======================================================================================
	// UI Components: MiniPlayer & Panel
	// ======================================================================================
	function T(props, text) {
		var Design = valenced.discord.design.Design
		var rt = valenced.react.ReactJSXRuntime
		var p = Object.assign({}, props)
		var key = p.key
		delete p.key
		p.children = text
		return rt.jsx(Design.Text, p, key)
	}

	function Button(props) {
		var Design = valenced.discord.design.Design
		return h(Design.Button, {
			text: props.text,
			size: props.size || 'md',
			variant: props.variant || 'secondary',
			loading: props.loading,
			onPress: props.onPress,
			disabled: props.disabled,
			style: props.style
		})
	}

	function findIcon(names) {
		for (var i = 0; i < names.length; i++) {
			var icon = valenced.utils.discord.lookupGeneratedIconComponent(names[i])
			if (icon) return icon
		}
		return null
	}

	/**
	 * Floating MiniPlayer Bar sitting right above the chat input box.
	 */
	function MiniPlayer() {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var tick = React.useState(0)

		React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			return function () { listeners = listeners.filter(function (l) { return l !== update }) }
		}, [])

		if (!setting('showMiniPlayer')) {
			return h(AudioPlayerHost, null)
		}

		var track = playerState.track
		var isPlaying = playerState.status === 'playing'
		var MusicIcon = findIcon(['MusicIcon', 'HeadphonesIcon', 'SparklesIcon'])
		var PlayIcon = findIcon(['PlayIcon', 'ArrowLargeRightIcon'])
		var PauseIcon = findIcon(['PauseIcon', 'StopIcon'])
		var Tap = RN.Pressable || RN.TouchableOpacity

		return h(
			RN.View,
			{
				style: {
					position: 'absolute',
					top: -BUTTON_SIZE - 4,
					left: 12,
					zIndex: 99,
					flexDirection: 'row',
					alignItems: 'center'
				},
				pointerEvents: 'box-none'
			},
			h(
				Tap,
				{
					onPress: function () { openMusicPanel(track ? 'now_playing' : 'search') },
					style: {
						height: BUTTON_SIZE,
						paddingHorizontal: 12,
						borderRadius: BUTTON_SIZE / 2,
						backgroundColor: surface(),
						flexDirection: 'row',
						alignItems: 'center',
						gap: 8,
						maxWidth: 240,
						elevation: 4,
						shadowColor: '#000',
						shadowOffset: { width: 0, height: 2 },
						shadowOpacity: 0.25,
						shadowRadius: 3
					}
				},
				track && track.thumbnail
					? h(RN.Image, {
						source: { uri: track.thumbnail },
						style: { width: 22, height: 22, borderRadius: 11, backgroundColor: surfaceTertiary() }
					})
					: (MusicIcon ? h(MusicIcon, { size: 'sm', color: ACCENT_COLOR }) : null),
				T(
					{ variant: 'text-xs/bold', numberOfLines: 1, style: { color: textNormal(), maxWidth: 130 } },
					track ? track.title : 'JioSaavn'
				),
				track ? h(
					Tap,
					{
						onPress: function (e) {
							if (e && e.stopPropagation) e.stopPropagation()
							togglePlayPause()
						},
						style: { padding: 4 }
					},
					isPlaying
						? (PauseIcon ? h(PauseIcon, { size: 'xs', color: ACCENT_COLOR }) : T({ variant: 'text-xs/bold', style: { color: ACCENT_COLOR } }, '||'))
						: (PlayIcon ? h(PlayIcon, { size: 'xs', color: textNormal() }) : T({ variant: 'text-xs/bold' }, '>'))
				) : null
			),
			h(AudioPlayerHost, null)
		)
	}

	function decorateInput(ret) {
		if (!ret || !ret.props) return ret
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

		var row = findInTree(ret.props.children, function (x) {
			return x && x.type && (x.type.displayName === 'View' || x.type === valenced.react.ReactNative.View) && Array.isArray(x.props && x.props.children)
		})
		if (!row) return ret

		var kids = row.props.children
		if (!kids.some(function (k) { return k && k.key === 'asaprajx-jiosaavn-mini' })) {
			kids.unshift(h(MiniPlayer, { key: 'asaprajx-jiosaavn-mini' }))
		}
		return ret
	}

	// ======================================================================================
	// Plus Menu Injection
	// ======================================================================================
	var PLUS_LABELS = { Camera: 1, Photos: 1, Poll: 1, Files: 1, Apps: 1 }
	var PLUS_ICONS = [
		/ic_camera/i, /ic_image/i, /ic_poll/i, /ic_attachment/i, /ic_thread/i, /ic_gift/i,
		/CameraIcon/i, /PhotosIcon/i, /ImageIcon/i, /PollIcon/i, /FileIcon/i, /ThreadIcon/i, /GiftIcon/i
	]
	var assetNames = new Map()
	function iconName(item) {
		if (!item) return ''
		var src = item.iconSource
		if (typeof src === 'string') return src
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
		var found = 0
		for (var j = 0; j < items.length; j++) {
			var nm = iconName(items[j])
			if (nm) {
				for (var k = 0; k < PLUS_ICONS.length; k++) {
					if (PLUS_ICONS[k].test(nm)) { found++; break }
				}
			}
		}
		return found
	}
	function decoratePlusItems(result, items) {
		for (var i = 0; i < items.length; i++) {
			if (items[i] && items[i].__jioSaavn) return result
		}
		var template = items.find(function (item) { return item && typeof item.label === 'string' })
		if (!template) return result

		var item = Object.assign({}, template, {
			label: 'JioSaavn',
			__jioSaavn: true
		})
		;['id', 'key', 'testID', 'nativeID', 'index', 'state'].forEach(function (n) { delete item[n] })

		var press = function () {
			try { valenced.discord.actions.ActionSheetActionCreators.hideAllActionSheets() } catch (e) {}
			setTimeout(function () { openMusicPanel('now_playing') }, 250)
		}
		;['action', 'onPress', 'onSelect', 'onClick', 'callback', 'handler'].forEach(function (n) {
			if (n in template || n === 'action') item[n] = press
		})

		var Icon = findIcon(['MusicIcon', 'HeadphonesIcon'])
		var assetId
		;['MusicIcon', 'ic_music_24px', 'HeadphonesIcon'].forEach(function (name) {
			if (assetId === undefined) {
				var id = valenced.assets.getAssetIdByName(name)
				if (id != null) assetId = id
			}
		})
		if (assetId !== undefined) item.iconSource = assetId
		else delete item.iconSource

		if ('IconComponent' in template || Icon) {
			if (Icon) item.IconComponent = Icon
			else delete item.IconComponent
		}

		return valenced.react.React.cloneElement(result, { items: items.concat([item]) })
	}

	function decoratePlusMenu(result) {
		try {
			var props = result && result.props
			if (props && Array.isArray(props.items) && props.items.length >= 2 && props.items.length <= 24) {
				var hasKnown = props.items.some(function (it) {
					return it && typeof it.label === 'string' && PLUS_LABELS[it.label]
				})
				if (hasKnown || plusScore(props.items) >= 2) return decoratePlusItems(result, props.items)
			}
			return result
		} catch (e) {
			return result
		}
	}

	function installPlusHook(cleanup) {
		var f = finders()
		var runtime = f.lookupModule(f.filters.withProps('jsx', 'jsxs'))[0] || valenced.react.ReactJSXRuntime
		;['jsx', 'jsxs'].forEach(function (name) {
			if (runtime && typeof runtime[name] === 'function') {
				cleanup(valenced.patcher.after(runtime, name, decoratePlusMenu))
			}
		})
	}

	// ======================================================================================
	// Full Music Player Modal (ActionSheet)
	// ======================================================================================
	function Panel(props) {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var Design = valenced.discord.design.Design

		var tabState = React.useState(props.initialTab || 'now_playing')
		var currentTab = tabState[0]
		var setTab = tabState[1]

		var searchInputState = React.useState(searchState.query)
		var searchInput = searchInputState[0]
		var setSearchInput = searchInputState[1]

		var tick = React.useState(0)
		React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			return function () { listeners = listeners.filter(function (l) { return l !== update }) }
		}, [])

		var track = playerState.track
		var isPlaying = playerState.status === 'playing'
		var isLoading = playerState.status === 'loading'
		var Tap = RN.Pressable || RN.TouchableOpacity

		var PlayIcon = findIcon(['PlayIcon', 'ArrowLargeRightIcon'])
		var PauseIcon = findIcon(['PauseIcon', 'StopIcon'])
		var NextIcon = findIcon(['NextIcon', 'FastForwardIcon'])
		var PrevIcon = findIcon(['PreviousIcon', 'FastBackwardIcon'])
		var RepeatIcon = findIcon(['RepeatIcon', 'SyncIcon'])
		var ShuffleIcon = findIcon(['ShuffleIcon', 'ArrowsExchangeIcon'])
		var SearchIcon = findIcon(['SearchIcon', 'MagnifyingGlassIcon'])
		var ClearIcon = findIcon(['CloseIcon', 'CrossIcon'])
		var TrashIcon = findIcon(['TrashIcon', 'DeleteIcon'])

		var screenHeight = RN.Dimensions.get('window').height || 700
		var scrollMax = Math.max(300, screenHeight - 160)

		return h(
			RN.View,
			{ style: { padding: 16, backgroundColor: surface(), borderTopLeftRadius: 18, borderTopRightRadius: 18 } },
			// Modal Header & Tab Navigation Bar
			h(
				RN.View,
				{
					style: {
						flexDirection: 'row',
						justifyContent: 'space-between',
						alignItems: 'center',
						marginBottom: 16,
						backgroundColor: surfaceTertiary(),
						padding: 4,
						borderRadius: 12
					}
				},
				[
					{ id: 'now_playing', label: 'Now Playing' },
					{ id: 'search', label: 'Search' },
					{ id: 'queue', label: 'Queue (' + queue.length + ')' },
					{ id: 'settings', label: 'Settings' }
				].map(function (tab) {
					var isActive = currentTab === tab.id
					return h(
						Tap,
						{
							key: tab.id,
							onPress: function () { setTab(tab.id) },
							style: {
								flex: 1,
								paddingVertical: 8,
								alignItems: 'center',
								borderRadius: 8,
								backgroundColor: isActive ? surface() : 'transparent'
							}
						},
						T(
							{
								variant: 'text-xs/bold',
								style: { color: isActive ? textNormal() : textMuted() }
							},
							tab.label
						)
					)
				})
			),

			// Content Body Area
			h(
				RN.View,
				{ style: { minHeight: 280 } },
				// TAB 1: NOW PLAYING & SYNCHRONIZED LYRICS
				currentTab === 'now_playing' ? h(
					RN.ScrollView,
					{
						style: { maxHeight: scrollMax - 80 },
						nestedScrollEnabled: true,
						showsVerticalScrollIndicator: true
					},
					track ? h(
						RN.View,
						{ style: { alignItems: 'center' } },
						// Album Artwork
						track.thumbnail
							? h(RN.Image, {
								source: { uri: track.thumbnail },
								style: {
									width: 170,
									height: 170,
									borderRadius: 14,
									backgroundColor: surfaceTertiary(),
									elevation: 6,
									shadowColor: '#000',
									shadowOffset: { width: 0, height: 4 },
									shadowOpacity: 0.35,
									shadowRadius: 5
								}
							})
							: h(
								RN.View,
								{
									style: {
										width: 170,
										height: 170,
										borderRadius: 14,
										backgroundColor: surfaceTertiary(),
										alignItems: 'center',
										justifyContent: 'center'
									}
								},
								T({ variant: 'heading-lg/bold', style: { color: textMuted() } }, 'JioSaavn')
							),

						// Track Metadata
						h(
							RN.View,
							{ style: { alignItems: 'center', marginTop: 14, paddingHorizontal: 16 } },
							T({ variant: 'heading-md/bold', numberOfLines: 1, style: { color: textNormal(), textAlign: 'center' } }, track.title),
							T({ variant: 'text-sm/medium', numberOfLines: 1, style: { color: textMuted(), marginTop: 3, textAlign: 'center' } }, track.artist + (track.album ? ' • ' + track.album : ''))
						),

						// Progress Bar & Duration Labels
						h(
							RN.View,
							{ style: { width: '100%', marginTop: 14, paddingHorizontal: 12 } },
							h(
								Tap,
								{
									onPress: function (evt) {
										var nativeEvt = evt.nativeEvent || {}
										var locationX = nativeEvt.locationX || 0
										RN.Dimensions.get('window')
										var barWidth = 320
										var ratio = Math.max(0, Math.min(1, locationX / barWidth))
										if (playerState.duration > 0) {
											seekTo(ratio * playerState.duration)
										}
									},
									style: {
										height: 24,
										justifyContent: 'center'
									}
								},
								h(
									RN.View,
									{
										style: {
											height: 4,
											backgroundColor: surfaceTertiary(),
											borderRadius: 2,
											overflow: 'hidden'
										}
									},
									h(RN.View, {
										style: {
											height: '100%',
											backgroundColor: ACCENT_COLOR,
											width: String(playerState.duration > 0 ? Math.min(100, Math.round((playerState.position / playerState.duration) * 100)) : 0) + '%'
										}
									})
								)
							),
							h(
								RN.View,
								{ style: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 } },
								T({ variant: 'text-xs/medium', style: { color: textMuted() } }, formatTime(playerState.position)),
								T({ variant: 'text-xs/medium', style: { color: textMuted() } }, formatTime(playerState.duration))
							)
						),

						// Media Control Buttons
						h(
							RN.View,
							{
								style: {
									flexDirection: 'row',
									alignItems: 'center',
									justifyContent: 'center',
									gap: 16,
									marginTop: 10
								}
							},
							// Seek -10s
							h(
								Tap,
								{ onPress: function () { seekTo(playerState.position - 10) }, style: { padding: 8 } },
								T({ variant: 'text-xs/bold', style: { color: textNormal() } }, '-10s')
							),
							// Previous Track
							h(
								Tap,
								{ onPress: prevTrack, style: { padding: 8 } },
								PrevIcon ? h(PrevIcon, { size: 'md', color: textNormal() }) : T({ variant: 'text-sm/bold' }, '|<')
							),
							// Play / Pause Circle
							h(
								Tap,
								{
									onPress: togglePlayPause,
									style: {
										width: 52,
										height: 52,
										borderRadius: 26,
										backgroundColor: ACCENT_COLOR,
										alignItems: 'center',
										justifyContent: 'center',
										elevation: 4
									}
								},
								isPlaying
									? (PauseIcon ? h(PauseIcon, { size: 'lg', color: '#fff' }) : T({ variant: 'heading-lg/bold', style: { color: '#fff' } }, '||'))
									: (PlayIcon ? h(PlayIcon, { size: 'lg', color: '#fff' }) : T({ variant: 'heading-lg/bold', style: { color: '#fff' } }, '>'))
							),
							// Next Track
							h(
								Tap,
								{ onPress: nextTrack, style: { padding: 8 } },
								NextIcon ? h(NextIcon, { size: 'md', color: textNormal() }) : T({ variant: 'text-sm/bold' }, '>|')
							),
							// Seek +10s
							h(
								Tap,
								{ onPress: function () { seekTo(playerState.position + 10) }, style: { padding: 8 } },
								T({ variant: 'text-xs/bold', style: { color: textNormal() } }, '+10s')
							)
						),

						// Secondary Controls: Repeat & Shuffle
						h(
							RN.View,
							{ style: { flexDirection: 'row', gap: 20, marginTop: 12 } },
							h(
								Tap,
								{
									onPress: function () {
										playerState.repeat = !playerState.repeat
										toast('Repeat ' + (playerState.repeat ? 'ON' : 'OFF'))
										changed()
									},
									style: { padding: 6 }
								},
								RepeatIcon
									? h(RepeatIcon, { size: 'sm', color: playerState.repeat ? ACCENT_COLOR : textMuted() })
									: T({ variant: 'text-xs/bold', style: { color: playerState.repeat ? ACCENT_COLOR : textMuted() } }, 'Repeat')
							),
							h(
								Tap,
								{
									onPress: function () {
										if (queue.length > 1) {
											queue = queue.sort(function () { return Math.random() - 0.5 })
											toast('Queue shuffled')
											changed()
										}
									},
									style: { padding: 6 }
								},
								ShuffleIcon
									? h(ShuffleIcon, { size: 'sm', color: textMuted() })
									: T({ variant: 'text-xs/bold', style: { color: textMuted() } }, 'Shuffle')
							)
						),

						// Synchronized Lyrics View
						h(
							RN.View,
							{
								style: {
									width: '100%',
									marginTop: 18,
									backgroundColor: surfaceTertiary(),
									borderRadius: 12,
									padding: 12,
									maxHeight: 220
								}
							},
							T({ variant: 'text-xs/bold', style: { color: textMuted(), marginBottom: 8 } }, 'SYNCHRONIZED LYRICS (LRCLIB)'),
							lyricsState.status === 'loading'
								? T({ variant: 'text-sm/medium', style: { color: textMuted(), fontStyle: 'italic', textAlign: 'center', paddingVertical: 20 } }, 'Loading lyrics...')
								: (lyricsState.synced && lyricsState.synced.length > 0)
									? h(
										RN.ScrollView,
										{
											ref: function (r) { activeLyricScrollRef.current = r },
											style: { maxHeight: 170 },
											nestedScrollEnabled: true,
											showsVerticalScrollIndicator: false
										},
										lyricsState.synced.map(function (item, idx) {
											var isCurrent = lyricsState.activeIndex === idx
											return h(
												Tap,
												{
													key: 'lyric-' + idx,
													onPress: function () { seekTo(item.timeMs / 1000) },
													style: {
														paddingVertical: 5,
														paddingHorizontal: 8,
														borderRadius: 6,
														backgroundColor: isCurrent ? 'rgba(43, 197, 180, 0.2)' : 'transparent'
													}
												},
												T(
													{
														variant: isCurrent ? 'text-sm/bold' : 'text-sm/medium',
														style: {
															color: isCurrent ? '#fff' : textMuted(),
															textAlign: 'center'
														}
													},
													item.text
												)
											)
										})
									)
									: (lyricsState.plain
										? h(
											RN.ScrollView,
											{ style: { maxHeight: 160 }, nestedScrollEnabled: true },
											T({ variant: 'text-sm/medium', style: { color: textNormal() } }, lyricsState.plain)
										)
										: T({ variant: 'text-sm/medium', style: { color: textMuted(), fontStyle: 'italic', textAlign: 'center', paddingVertical: 14 } }, 'No lyrics available for this song.')
									)
						)
					) : h(
						RN.View,
						{ style: { alignItems: 'center', paddingVertical: 40 } },
						T({ variant: 'heading-md/bold', style: { color: textNormal() } }, 'No Song Playing'),
						T({ variant: 'text-sm/medium', style: { color: textMuted(), marginTop: 6, textAlign: 'center' } }, 'Search songs or play from your queue to begin enjoying music on JioSaavn.'),
						Button({
							text: 'Search Songs',
							style: { marginTop: 16 },
							onPress: function () { setTab('search') }
						})
					)
				) : null,

				// TAB 2: SEARCH SONGS (JIOSAAVN)
				currentTab === 'search' ? h(
					RN.View,
					{ style: { maxHeight: scrollMax - 80 } },
					// Search Input Box
					h(
						RN.View,
						{ style: { marginBottom: 12 } },
						h(Design.TextInput, {
							value: searchInput,
							placeholder: 'Search songs, artists, albums...',
							returnKeyType: 'search',
							onSubmitEditing: function () { performSearch(searchInput) },
							onChange: function (val) { setSearchInput(val) },
							style: { color: textNormal(), height: 46 }
						})
					),
					// Quick Search Action Buttons
					h(
						RN.View,
						{ style: { flexDirection: 'row', gap: 8, marginBottom: 14 } },
						h(
							Tap,
							{
								onPress: function () { performSearch(searchInput) },
								style: {
									flex: 3,
									height: 42,
									backgroundColor: '#f2f3f5',
									borderRadius: 8,
									alignItems: 'center',
									justifyContent: 'center'
								}
							},
							T({ variant: 'text-sm/bold', style: { color: '#060607' } }, 'Search')
						),
						h(
							Tap,
							{
								onPress: function () {
									setSearchInput('')
									performSearch('')
								},
								style: {
									flex: 1,
									height: 42,
									backgroundColor: surfaceTertiary(),
									borderRadius: 8,
									alignItems: 'center',
									justifyContent: 'center',
									borderWidth: 1,
									borderColor: '#35363c'
								}
							},
							T({ variant: 'text-sm/bold', style: { color: textNormal() } }, 'Clear')
						)
					),

					// Trending Genre / Artist Search Chips
					h(
						RN.ScrollView,
						{ horizontal: true, showsHorizontalScrollIndicator: false, style: { marginBottom: 12, flexGrow: 0 } },
						['Trending', 'Don Toliver', 'Arijit Singh', 'The Weeknd', 'Taylor Swift', 'Travis Scott', 'Diljit Dosanjh', 'Karan Aujla', 'Dua Lipa'].map(function (chip) {
							return h(
								Tap,
								{
									key: 'chip-' + chip,
									onPress: function () {
										setSearchInput(chip)
										performSearch(chip)
									},
									style: {
										backgroundColor: surfaceTertiary(),
										paddingVertical: 6,
										paddingHorizontal: 12,
										borderRadius: 16,
										marginRight: 8
									}
								},
								T({ variant: 'text-xs/medium', style: { color: textNormal() } }, chip)
							)
						})
					),

					// Search Status / Loading / Errors
					searchState.loading
						? T({ variant: 'text-sm/medium', style: { color: textMuted(), textAlign: 'center', paddingVertical: 20 } }, 'Searching JioSaavn...')
						: (searchState.error
							? T({ variant: 'text-sm/medium', style: { color: '#f23f43', textAlign: 'center', paddingVertical: 12 } }, searchState.error)
							: null
						),

					// Results List
					h(
						RN.ScrollView,
						{ style: { maxHeight: scrollMax - 220 }, nestedScrollEnabled: true, showsVerticalScrollIndicator: true },
						searchState.results.map(function (s) {
							return h(
								RN.View,
								{
									key: s.id,
									style: {
										flexDirection: 'row',
										alignItems: 'center',
										padding: 8,
										borderRadius: 8,
										backgroundColor: surfaceTertiary(),
										marginBottom: 8,
										gap: 10
									}
								},
								s.thumbnail
									? h(RN.Image, {
										source: { uri: s.thumbnail },
										style: { width: 44, height: 44, borderRadius: 6, backgroundColor: surface() }
									})
									: h(
										RN.View,
										{ style: { width: 44, height: 44, borderRadius: 6, backgroundColor: surface(), alignItems: 'center', justifyContent: 'center' } },
										SearchIcon ? h(SearchIcon, { size: 'sm', color: textMuted() }) : null
									),
								h(
									RN.View,
									{ style: { flex: 1 } },
									T({ variant: 'text-sm/bold', numberOfLines: 1, style: { color: textNormal() } }, s.title),
									T({ variant: 'text-xs/medium', numberOfLines: 1, style: { color: textMuted(), marginTop: 2 } }, s.artist + (s.duration && s.duration !== '0:00' ? ' • ' + s.duration : ''))
								),
								h(
									Tap,
									{
										onPress: function () {
											playTrack(s)
											setTab('now_playing')
										},
										style: {
											backgroundColor: ACCENT_COLOR,
											paddingVertical: 6,
											paddingHorizontal: 12,
											borderRadius: 6
										}
									},
									T({ variant: 'text-xs/bold', style: { color: '#fff' } }, 'Play')
								),
								h(
									Tap,
									{
										onPress: function () { addToQueue(s) },
										style: {
											backgroundColor: surface(),
											paddingVertical: 6,
											paddingHorizontal: 10,
											borderRadius: 6
										}
									},
									T({ variant: 'text-xs/bold', style: { color: textNormal() } }, '+ Queue')
								)
							)
						})
					)
				) : null,

				// TAB 3: QUEUE & HISTORY
				currentTab === 'queue' ? h(
					RN.ScrollView,
					{ style: { maxHeight: scrollMax - 80 }, nestedScrollEnabled: true, showsVerticalScrollIndicator: true },
					h(
						RN.View,
						{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
						T({ variant: 'heading-md/bold', style: { color: textNormal() } }, 'Up Next (' + queue.length + ')'),
						queue.length > 0 ? h(
							Tap,
							{ onPress: clearQueue, style: { padding: 4 } },
							T({ variant: 'text-xs/bold', style: { color: '#f23f43' } }, 'Clear All')
						) : null
					),
					queue.length === 0
						? T({ variant: 'text-sm/medium', style: { color: textMuted(), marginBottom: 14 } }, 'No upcoming songs in queue.')
						: queue.map(function (item, idx) {
							return h(
								RN.View,
								{
									key: item.id + '-' + idx,
									style: {
										flexDirection: 'row',
										alignItems: 'center',
										padding: 8,
										borderRadius: 8,
										backgroundColor: surfaceTertiary(),
										marginBottom: 6,
										gap: 8
									}
								},
								T({ variant: 'text-xs/bold', style: { color: textMuted(), width: 20 } }, String(idx + 1)),
								item.thumbnail ? h(RN.Image, { source: { uri: item.thumbnail }, style: { width: 36, height: 36, borderRadius: 6 } }) : null,
								h(
									RN.View,
									{ style: { flex: 1 } },
									T({ variant: 'text-sm/bold', numberOfLines: 1, style: { color: textNormal() } }, item.title),
									T({ variant: 'text-xs/medium', numberOfLines: 1, style: { color: textMuted() } }, item.artist)
								),
								h(
									Tap,
									{ onPress: function () { removeFromQueue(idx) }, style: { padding: 6 } },
									TrashIcon ? h(TrashIcon, { size: 'sm', color: '#f23f43' }) : T({ variant: 'text-xs/bold', style: { color: '#f23f43' } }, 'X')
								)
							)
						}),

					// History Section
					T({ variant: 'heading-md/bold', style: { color: textNormal(), marginTop: 18, marginBottom: 8 } }, 'Recently Played'),
					history.length === 0
						? T({ variant: 'text-sm/medium', style: { color: textMuted() } }, 'No recently played tracks.')
						: history.slice(0, 10).map(function (item, idx) {
							return h(
								RN.View,
								{
									key: 'hist-' + item.id + '-' + idx,
									style: {
										flexDirection: 'row',
										alignItems: 'center',
										padding: 8,
										borderRadius: 8,
										backgroundColor: surfaceTertiary(),
										marginBottom: 6,
										gap: 8
									}
								},
								item.thumbnail ? h(RN.Image, { source: { uri: item.thumbnail }, style: { width: 36, height: 36, borderRadius: 6 } }) : null,
								h(
									RN.View,
									{ style: { flex: 1 } },
									T({ variant: 'text-sm/bold', numberOfLines: 1, style: { color: textNormal() } }, item.title),
									T({ variant: 'text-xs/medium', numberOfLines: 1, style: { color: textMuted() } }, item.artist)
								),
								h(
									Tap,
									{
										onPress: function () {
											playTrack(item)
											setTab('now_playing')
										},
										style: {
											backgroundColor: surface(),
											paddingVertical: 4,
											paddingHorizontal: 8,
											borderRadius: 6
										}
									},
									T({ variant: 'text-xs/bold', style: { color: textNormal() } }, 'Replay')
								)
							)
						})
				) : null,

				// TAB 4: SETTINGS & ABOUT
				currentTab === 'settings' ? h(
					RN.ScrollView,
					{ style: { maxHeight: scrollMax - 80 }, nestedScrollEnabled: true, showsVerticalScrollIndicator: true },
					h(
						Design.TableRowGroup,
						{ title: 'Audio Stream Quality' },
						h(Design.TableRow, {
							key: 'q-desc',
							label: 'Streaming Bitrate',
							subLabel: 'Current: ' + (setting('audioQuality') === '320' ? '320 kbps (High Fidelity AAC)' : (setting('audioQuality') === '160' ? '160 kbps (Standard)' : '96 kbps (Data Saver)'))
						}),
						h(
							RN.View,
							{ style: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 12 } },
							[
								{ id: '320', label: '320 kbps (High)' },
								{ id: '160', label: '160 kbps (Normal)' },
								{ id: '96', label: '96 kbps (Low)' }
							].map(function (opt) {
								var sel = String(setting('audioQuality') || '320') === opt.id
								return h(
									Tap,
									{
										key: opt.id,
										onPress: function () {
											setSetting('audioQuality', opt.id)
											toast('Audio quality set to ' + opt.id + ' kbps')
											changed()
										},
										style: {
											flex: 1,
											paddingVertical: 8,
											borderRadius: 6,
											backgroundColor: sel ? ACCENT_COLOR : surfaceTertiary(),
											alignItems: 'center'
										}
									},
									T({ variant: 'text-xs/bold', style: { color: sel ? '#fff' : textNormal() } }, opt.label)
								)
							})
						)
					),
					h(
						Design.TableRowGroup,
						{ title: 'Playback Preferences' },
						h(Design.TableSwitchRow, {
							key: 'auto-play',
							label: 'Auto-play next track',
							subLabel: 'Automatically start the next track in queue when current track finishes',
							value: Boolean(setting('autoPlayNext')),
							onValueChange: function (v) {
								setSetting('autoPlayNext', v)
								changed()
							}
						}),
						h(Design.TableSwitchRow, {
							key: 'mini-player',
							label: 'Show Mini-Player Bar',
							subLabel: 'Show floating music pill above chat input',
							value: Boolean(setting('showMiniPlayer')),
							onValueChange: function (v) {
								setSetting('showMiniPlayer', v)
								changed()
							}
						})
					),
					h(
						Design.TableRowGroup,
						{ title: 'About' },
						h(Design.TableRow, {
							key: 'abt-1',
							label: 'JioSaavn for Valenced',
							subLabel: 'Version 1.0.6 by asaprajx. High fidelity ad-free music streaming with LRCLIB synchronized lyrics.'
						}),
						h(Design.TableRow, {
							key: 'abt-2',
							label: 'Source & API',
							subLabel: 'Powered by JioSaavn CDN & LRCLIB synced lyrics engine.'
						})
					)
				) : null
			),
			h(AudioPlayerHost, null)
		)
	}

	function openMusicPanel(initialTab) {
		try {
			valenced.discord.actions.ActionSheetActionCreators.openLazy(
				Promise.resolve({
					default: function () { return h(Panel, { initialTab: initialTab }) }
				}),
				SHEET_KEY,
				{}
			)
		} catch (e) {
			toast('Could not open music player: ' + String(e && e.message || e))
		}
	}

	function SettingsComponent() {
		var Design = valenced.discord.design.Design
		var tick = valenced.react.React.useState(0)
		valenced.react.React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			return function () { listeners = listeners.filter(function (l) { return l !== update }) }
		}, [])

		return h(
			Design.ScrollView,
			{ style: { padding: 16 } },
			h(
				Design.TableRowGroup,
				{ title: 'JioSaavn Player' },
				h(Design.TableRow, {
					label: 'Open Player',
					subLabel: 'Tap to launch player modal',
					onPress: function () { openMusicPanel('now_playing') }
				}),
				h(Design.TableSwitchRow, {
					label: 'Auto-play next track',
					value: Boolean(setting('autoPlayNext')),
					onValueChange: function (v) { setSetting('autoPlayNext', v); changed() }
				}),
				h(Design.TableSwitchRow, {
					label: 'Show Mini-Player Bar',
					value: Boolean(setting('showMiniPlayer')),
					onValueChange: function (v) { setSetting('showMiniPlayer', v); changed() }
				})
			),
			h(
				Design.TableRowGroup,
				{ title: 'Audio Stream Quality' },
				h(Design.TableRow, {
					label: 'Bitrate',
					subLabel: setting('audioQuality') === '320' ? '320 kbps (High Fidelity)' : (setting('audioQuality') === '160' ? '160 kbps (Standard)' : '96 kbps (Data Saver)'),
					onPress: function () {
						var cur = String(setting('audioQuality') || '320')
						var next = cur === '320' ? '160' : (cur === '160' ? '96' : '320')
						setSetting('audioQuality', next)
						toast('Audio quality set to ' + next + ' kbps')
						changed()
					}
				})
			),
			h(
				Design.TableRowGroup,
				{ title: 'About' },
				h(Design.TableRow, {
					key: 'set-abt',
					label: 'JioSaavn for Valenced',
					subLabel: 'Version 1.0.6 by asaprajx. Stream ad-free music with LRCLIB synchronized lyrics.'
				})
			)
		)
	}

	// ======================================================================================
	// Plugin Registration & Lifecycle
	// ======================================================================================
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
	exports.default = plugin({
		jsonStorage: { load: true, default: defaults },
		SettingsComponent: SettingsComponent,
		start: function (api) {
			var cleanup = api.cleanup
			storage = api.jsonStorage

			try {
				var savedQ = JSON.parse(setting('savedQueue') || '[]')
				if (Array.isArray(savedQ)) queue = savedQ
			} catch (e) {}

			try {
				var savedH = JSON.parse(setting('savedHistory') || '[]')
				if (Array.isArray(savedH)) history = savedH
			} catch (e) {}

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
								})
							)
						} catch (e) {}
					},
					{ returnNamespace: true }
				)
			)

			try { installPlusHook(cleanup) } catch (e) {}

			cleanup(function () {
				timers.forEach(function (t) { clearInterval(t) })
				timers = []
				listeners = []
				playerState.status = 'paused'
				try { valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(SHEET_KEY) } catch (e) {}
			})
		}
	})

	return exports
})({})
