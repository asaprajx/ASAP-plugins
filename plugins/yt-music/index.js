(function (exports) {
	'use strict'

	/*
	 * YouTube Music Player for Valenced Discord Mobile Client.
	 * Stream music ad-free directly inside Discord with synchronized lyrics, search, queue management,
	 * floating mini-player, and background playback.
	 *
	 * Uses official YouTube Music InnerTube search API with multi-instance Invidious stream extraction,
	 * paired with LRCLIB for synchronized time-coded lyrics.
	 */

	var PLUGIN_ID = 'asaprajx.yt-music'
	var SHEET_KEY = 'asaprajx.yt-music.panel'
	var TOAST_ID = 'ASAP_YT_MUSIC'

	var DEFAULT_INSTANCES = [
		'https://yt.chocolatemoo53.com',
		'https://invidious.nerdvpn.de',
		'https://invidious.tiekoetter.com',
		'https://inv.nadeko.net'
	]

	var defaults = {
		customInstance: '',
		audioQuality: 'medium',
		autoPlayNext: true,
		showMiniPlayer: true,
		miniPlayerPlacement: 'above_input', // 'above_input' | 'none'
		recentSearches: '[]',
		savedQueue: '[]',
		savedHistory: '[]'
	}

	var ACCENT_COLOR = '#ff0033'
	var BUTTON_SIZE = 38

	var storage
	var listeners = []
	var timers = []

	var playerState = {
		status: 'idle', // 'idle' | 'loading' | 'playing' | 'paused' | 'error'
		track: null,    // { videoId, title, artist, album, duration, durationSec, thumbnail }
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
		return (
			valenced.modules.finders || {
				lookupModule: function (predicate) {
					return [valenced.metro.find(predicate)].filter(Boolean)
				},
				filters: {
					withProps: function () {
						var props = Array.prototype.slice.call(arguments)
						return function (m) {
							return m && props.every(function (p) { return m[p] !== undefined })
						}
					},
					withName: function (name) {
						return function (m) {
							return m && (m.name === name || m.displayName === name || (m.default && (m.default.name === name || m.default.displayName === name)))
						}
					}
				}
			}
		)
	}

	function setting(key) {
		var s = storage && storage.cache
		return s && s[key] !== undefined ? s[key] : defaults[key]
	}

	function setSetting(key, val) {
		if (!storage) return
		storage.set(key, val)
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

	// ======================================================================================
	// YouTube Music Search & Stream Resolution
	// ======================================================================================
	function getInstances() {
		var list = []
		var custom = String(setting('customInstance') || '').trim()
		if (custom) list.push(custom.replace(/\/+$/, ''))
		DEFAULT_INSTANCES.forEach(function (inst) {
			if (list.indexOf(inst) === -1) list.push(inst)
		})
		return list
	}

	/**
	 * Primary Search: Official YouTube Music InnerTube WEB_REMIX endpoint.
	 * Fast, ad-free, high quality official track metadata and thumbnails.
	 */
	function searchYTM(query) {
		var postBody = JSON.stringify({
			context: {
				client: {
					clientName: 'WEB_REMIX',
					clientVersion: '1.20231106.01.00',
					hl: 'en',
					gl: 'US'
				}
			},
			query: String(query).trim()
		})

		return timeoutFetch('https://music.youtube.com/youtubei/v1/search', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Origin': 'https://music.youtube.com',
				'Referer': 'https://music.youtube.com/'
			},
			body: postBody
		}, 8).then(function (res) {
			if (!res.ok) throw new Error('YTM search status ' + res.status)
			return res.json()
		}).then(function (json) {
			var songs = []
			var seen = {}

			function scan(obj) {
				if (!obj || typeof obj !== 'object') return
				if (obj.musicResponsiveListItemRenderer) {
					var item = obj.musicResponsiveListItemRenderer
					var videoId = item.playlistItemData && item.playlistItemData.videoId
					if (!videoId && item.doubleTapCommand && item.doubleTapCommand.watchEndpoint) {
						videoId = item.doubleTapCommand.watchEndpoint.videoId
					}
					if (!videoId && item.overlay && item.overlay.musicItemThumbnailOverlayRenderer) {
						var playBtn = item.overlay.musicItemThumbnailOverlayRenderer.content && item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
						if (playBtn && playBtn.playNavigationEndpoint && playBtn.playNavigationEndpoint.watchEndpoint) {
							videoId = playBtn.playNavigationEndpoint.watchEndpoint.videoId
						}
					}

					var flexColumns = item.flexColumns || []
					var title = flexColumns[0] && flexColumns[0].musicResponsiveListItemFlexColumnRenderer && flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text && flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs && flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0] && flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text
					var secondCol = flexColumns[1] && flexColumns[1].musicResponsiveListItemFlexColumnRenderer && flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text && flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs
					var artist = ''
					var album = ''
					var duration = ''

					if (Array.isArray(secondCol)) {
						if (secondCol[0] && secondCol[0].text) artist = secondCol[0].text
						if (secondCol[2] && secondCol[2].text) album = secondCol[2].text
						var lastRun = secondCol[secondCol.length - 1]
						if (lastRun && lastRun.text && /^\d+:\d+$/.test(lastRun.text)) duration = lastRun.text
					}

					var thumbs = (item.thumbnail && item.thumbnail.musicThumbnailRenderer && item.thumbnail.musicThumbnailRenderer.thumbnail && item.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || []
					var thumbnail = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : ''

					if (videoId && title && !seen[videoId]) {
						seen[videoId] = true
						var sec = 0
						if (duration) {
							var parts = duration.split(':').map(Number)
							if (parts.length === 2) sec = parts[0] * 60 + parts[1]
							else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2]
						}
						songs.push({
							videoId: videoId,
							title: title,
							artist: artist || 'Unknown Artist',
							album: album,
							duration: duration || '0:00',
							durationSec: sec,
							thumbnail: thumbnail
						})
					}
				}
				for (var k in obj) {
					if (Object.prototype.hasOwnProperty.call(obj, k)) {
						scan(obj[k])
					}
				}
			}

			scan(json)
			return songs
		})
	}

	/**
	 * Fallback Search: Invidious video search.
	 */
	function searchInvidious(query) {
		var instances = getInstances()
		var p = Promise.reject(new Error('No instances'))
		instances.forEach(function (base) {
			p = p.catch(function () {
				var url = base + '/api/v1/search?q=' + encodeURIComponent(query) + '&type=video'
				return timeoutFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 7)
					.then(function (res) {
						if (!res.ok) throw new Error('Invidious search error ' + res.status)
						return res.json()
					})
					.then(function (list) {
						if (!Array.isArray(list)) throw new Error('Invalid Invidious response')
						return list.map(function (v) {
							var sec = v.lengthSeconds || 0
							return {
								videoId: v.videoId,
								title: v.title,
								artist: v.author || 'YouTube',
								album: '',
								duration: formatTime(sec),
								durationSec: sec,
								thumbnail: (v.videoThumbnails && v.videoThumbnails[0] && v.videoThumbnails[0].url) || ''
							}
						})
					})
			})
		})
		return p
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

		searchYTM(q).catch(function () {
			return searchInvidious(q)
		}).then(function (songs) {
			searchState.loading = false
			searchState.results = songs || []
			if (songs.length === 0) searchState.error = 'No songs found for "' + q + '"'
			changed()
		}).catch(function (err) {
			searchState.loading = false
			searchState.error = 'Search failed: ' + String(err && err.message || err)
			changed()
		})
	}

	/**
	 * Audio Stream Extraction: Queries Invidious instances for AAC (m4a, itag 140) or Opus audio streams.
	 */
	function resolveAudioStream(videoId) {
		var instances = getInstances()
		var lastErr = null

		function tryInstance(idx) {
			if (idx >= instances.length) {
				return Promise.reject(lastErr || new Error('All audio stream instances failed'))
			}
			var base = instances[idx]

			// Method 1: Query Invidious video metadata for direct adaptive formats
			return timeoutFetch(base + '/api/v1/videos/' + encodeURIComponent(videoId), {
				headers: { 'User-Agent': 'Mozilla/5.0' }
			}, 7).then(function (res) {
				if (!res.ok) throw new Error('Status ' + res.status)
				return res.json()
			}).then(function (data) {
				var formats = data && data.adaptiveFormats
				if (!Array.isArray(formats)) throw new Error('No adaptiveFormats')
				var audios = formats.filter(function (f) {
					return f && f.type && f.type.indexOf('audio/') === 0 && f.url
				})
				if (audios.length === 0) throw new Error('No direct audio formats')

				// Prefer AAC 128kbps (universal hardware support on Android/iOS)
				var best = audios.find(function (f) {
					return f.type.indexOf('mp4') !== -1 && f.audioQuality === 'AUDIO_QUALITY_MEDIUM'
				}) || audios.find(function (f) {
					return f.type.indexOf('mp4') !== -1
				}) || audios[0]

				return best.url
			}).catch(function (err) {
				lastErr = err
				// Method 2: Invidious proxied companion stream redirect
				var proxiedUrl = base + '/latest_version?id=' + encodeURIComponent(videoId) + '&itag=140&local=true'
				return timeoutFetch(proxiedUrl, { method: 'HEAD' }, 5).then(function (headRes) {
					if (headRes.ok || headRes.status === 302 || headRes.status === 200) {
						return headRes.url || proxiedUrl
					}
					throw new Error('Proxied stream unavailable')
				}).catch(function (err2) {
					lastErr = err2
					return tryInstance(idx + 1)
				})
			})
		}

		return tryInstance(0)
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
			headers: { 'User-Agent': 'ValencedMusicPlayer/1.0 (https://github.com/asaprajx/ASAP-plugins)' }
		}, 6).then(function (res) {
			if (res.ok) return res.json()
			throw new Error('Not found directly')
		}).catch(function () {
			// Fallback: search LRCLIB
			var searchUrl = 'https://lrclib.net/api/search?q=' + encodeURIComponent(cleanTitle + ' ' + track.artist)
			return timeoutFetch(searchUrl, {
				headers: { 'User-Agent': 'ValencedMusicPlayer/1.0 (https://github.com/asaprajx/ASAP-plugins)' }
			}, 6).then(function (res) {
				if (!res.ok) throw new Error('LRCLIB search error')
				return res.json()
			}).then(function (list) {
				if (Array.isArray(list) && list.length > 0) {
					// Prefer entry with synced lyrics
					var withSync = list.find(function (item) { return item && item.syncedLyrics })
					return withSync || list[0]
				}
				throw new Error('No lyrics found')
			})
		}).then(function (data) {
			if (playerState.track && playerState.track.videoId === track.videoId) {
				lyricsState.status = 'loaded'
				lyricsState.plain = data.plainLyrics || ''
				lyricsState.synced = parseLRC(data.syncedLyrics)
				lyricsState.activeIndex = -1
				changed()
			}
		}).catch(function () {
			if (playerState.track && playerState.track.videoId === track.videoId) {
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
					activeLyricScrollRef.current.scrollTo({ y: Math.max(0, foundIdx * 40 - 80), animated: true })
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

		// Fetch lyrics concurrently
		loadLyrics(track)

		// Record in history
		history = [track].concat(history.filter(function (t) { return t.videoId !== track.videoId })).slice(0, 50)
		try { setSetting('savedHistory', JSON.stringify(history)) } catch (e) {}

		resolveAudioStream(track.videoId).then(function (url) {
			if (playerState.track && playerState.track.videoId === track.videoId) {
				playerState.streamUrl = url
				playerState.status = 'playing'
				toast('Playing: ' + track.title)
				changed()
			}
		}).catch(function (err) {
			if (playerState.track && playerState.track.videoId === track.videoId) {
				playerState.status = 'error'
				playerState.error = 'Failed to load audio stream: ' + String(err && err.message || err)
				toast('Stream error: ' + String(err && err.message || err))
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
		var candidates = [
			function () { return f.lookupModule(f.filters.withProps('seek', 'presentFullscreenPlayer'))[0] },
			function () { return f.lookupModule(f.filters.withProps('onAudioBecomingNoisy'))[0] },
			function () { return f.lookupModule(f.filters.withProps('FilterType', 'ScaleMode'))[0] },
			function () { return valenced.metro.findByProps('seek', 'presentFullscreenPlayer') },
			function () { return valenced.metro.findByName('Video') },
			function () { return valenced.metro.findByProps('dismissFullscreenPlayer') }
		]
		for (var i = 0; i < candidates.length; i++) {
			try {
				var mod = candidates[i]()
				var comp = mod && (mod.default || mod)
				if (comp && (typeof comp === 'function' || typeof comp === 'object')) {
					cachedVideoComponent = comp
					return comp
				}
			} catch (e) {}
		}
		cachedVideoComponent = null
		return null
	}

	function AudioPlayerHost() {
		var React = valenced.react.React
		var VideoComp = findVideoComponent()

		if (!VideoComp || !playerState.streamUrl) return null

		return h(VideoComp, {
			ref: function (ref) {
				activeAudioRef.current = ref
			},
			source: { uri: playerState.streamUrl },
			paused: playerState.status !== 'playing',
			volume: 1.0,
			rate: 1.0,
			playInBackground: true,
			playWhenInactive: true,
			ignoreSilentSwitch: 'ignore',
			audioOnly: true,
			preventsDisplaySleepDuringVideoPlayback: false,
			onLoad: function (data) {
				if (data && typeof data.duration === 'number' && data.duration > 0) {
					playerState.duration = data.duration
					changed()
				}
			},
			onProgress: function (data) {
				if (data && typeof data.currentTime === 'number') {
					playerState.position = data.currentTime
					if (data.seekableDuration && !playerState.duration) {
						playerState.duration = data.seekableDuration
					}
					updateLyricPosition(data.currentTime)
					changed()
				}
			},
			onEnd: function () {
				if (playerState.repeat) {
					seekTo(0)
				} else if (setting('autoPlayNext') && queue.length > 0) {
					nextTrack()
				} else {
					playerState.status = 'paused'
					playerState.position = 0
					changed()
				}
			},
			onError: function (err) {
				playerState.status = 'error'
				playerState.error = (err && err.error && err.error.errorString) || 'Playback error'
				changed()
			},
			style: { position: 'absolute', width: 0, height: 0, opacity: 0 }
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

		if (!setting('showMiniPlayer') || setting('miniPlayerPlacement') === 'none') return null

		var track = playerState.track
		var isPlaying = playerState.status === 'playing'
		var isLoading = playerState.status === 'loading'
		var progressPct = playerState.duration > 0 ? Math.min(1, playerState.position / playerState.duration) : 0

		var MusicIcon = findIcon(['MusicIcon', 'HeadphonesIcon', 'SparklesIcon'])
		var PlayIcon = findIcon(['PlayIcon', 'ArrowLargeRightIcon'])
		var PauseIcon = findIcon(['PauseIcon', 'StopIcon'])
		var NextIcon = findIcon(['NextIcon', 'FastForwardIcon'])

		var Tap = RN.Pressable || RN.TouchableOpacity

		// When no track is active: Show a sleek compact music button
		if (!track) {
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
						onPress: function () { openMusicPanel('search') },
						style: {
							height: BUTTON_SIZE,
							paddingHorizontal: 12,
							borderRadius: 20,
							backgroundColor: surface(),
							flexDirection: 'row',
							alignItems: 'center',
							gap: 6,
							shadowColor: '#000',
							shadowOffset: { width: 0, height: 2 },
							shadowOpacity: 0.25,
							shadowRadius: 3.84,
							elevation: 5
						}
					},
					MusicIcon ? h(MusicIcon, { size: 'sm', color: ACCENT_COLOR }) : null,
					T({ variant: 'text-xs/bold', style: { color: textNormal() } }, 'YouTube Music')
				),
				h(AudioPlayerHost, null)
			)
		}

		// When a track is active: Show rich mini-player bar
		return h(
			RN.View,
			{
				style: {
					position: 'absolute',
					top: -54,
					left: 8,
					right: 8,
					zIndex: 99,
					height: 48,
					borderRadius: 12,
					backgroundColor: surface(),
					overflow: 'hidden',
					shadowColor: '#000',
					shadowOffset: { width: 0, height: 2 },
					shadowOpacity: 0.3,
					shadowRadius: 4,
					elevation: 6
				}
			},
			h(
				Tap,
				{
					onPress: function () { openMusicPanel('now_playing') },
					style: {
						flex: 1,
						flexDirection: 'row',
						alignItems: 'center',
						paddingHorizontal: 8,
						gap: 10
					}
				},
				// Album Art Thumbnail
				track.thumbnail
					? h(RN.Image, {
						source: { uri: track.thumbnail },
						style: { width: 34, height: 34, borderRadius: 6, backgroundColor: surfaceTertiary() }
					})
					: (MusicIcon ? h(MusicIcon, { size: 'md', color: ACCENT_COLOR }) : null),
				// Title & Artist
				h(
					RN.View,
					{ style: { flex: 1, justifyContent: 'center' } },
					T({ variant: 'text-sm/bold', numberOfLines: 1, style: { color: textNormal() } }, track.title),
					T({ variant: 'text-xs/medium', numberOfLines: 1, style: { color: textMuted() } }, (isLoading ? 'Loading stream... ' : '') + track.artist)
				),
				// Controls
				h(
					Tap,
					{
						onPress: function (e) {
							if (e && e.stopPropagation) e.stopPropagation()
							togglePlayPause()
						},
						style: { padding: 8 }
					},
					isPlaying
						? (PauseIcon ? h(PauseIcon, { size: 'sm', color: textNormal() }) : T({ variant: 'text-xs/bold' }, '||'))
						: (PlayIcon ? h(PlayIcon, { size: 'sm', color: textNormal() }) : T({ variant: 'text-xs/bold' }, '>'))
				),
				h(
					Tap,
					{
						onPress: function (e) {
							if (e && e.stopPropagation) e.stopPropagation()
							nextTrack()
						},
						style: { padding: 8 }
					},
					NextIcon ? h(NextIcon, { size: 'sm', color: textNormal() }) : T({ variant: 'text-xs/bold' }, '>>')
				)
			),
			// Bottom Progress Line
			h(RN.View, {
				style: {
					height: 3,
					backgroundColor: ACCENT_COLOR,
					width: String(Math.round(progressPct * 100)) + '%'
				}
			}),
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
		if (!kids.some(function (k) { return k && k.key === 'asaprajx-yt-music-mini' })) {
			row.props.children = kids.concat([
				h(MiniPlayer, { key: 'asaprajx-yt-music-mini' })
			])
		}
		return ret
	}

	// ======================================================================================
	// Plus Menu Injection
	// ======================================================================================
	var PLUS_LABELS = { Camera: 1, Photos: 1, Poll: 1, Files: 1, Apps: 1 }
	function decoratePlusItems(result, items) {
		for (var i = 0; i < items.length; i++) {
			if (items[i] && items[i].__ytMusic) return result
		}
		var template = items.find(function (item) { return item && typeof item.label === 'string' })
		if (!template) return result

		var item = Object.assign({}, template, {
			label: 'YouTube Music',
			__ytMusic: true
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
				if (hasKnown) return decoratePlusItems(result, props.items)
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
		var tabState = React.useState(props.initialTab || (playerState.track ? 'now_playing' : 'search'))
		var currentTab = tabState[0]
		var setTab = tabState[1]

		var searchInputState = React.useState(searchState.query || '')
		var searchText = searchInputState[0]
		var setSearchText = searchInputState[1]

		var tick = React.useState(0)
		React.useEffect(function () {
			var update = function () { tick[1](function (n) { return n + 1 }) }
			listeners.push(update)
			return function () { listeners = listeners.filter(function (l) { return l !== update }) }
		}, [])

		var PlayIcon = findIcon(['PlayIcon', 'ArrowLargeRightIcon'])
		var PauseIcon = findIcon(['PauseIcon', 'StopIcon'])
		var NextIcon = findIcon(['NextIcon', 'FastForwardIcon'])
		var PrevIcon = findIcon(['PreviousIcon', 'RewindIcon'])
		var SearchIcon = findIcon(['SearchIcon', 'MagnifyingGlassIcon'])
		var MusicIcon = findIcon(['MusicIcon', 'HeadphonesIcon'])
		var TrashIcon = findIcon(['TrashIcon', 'DeleteIcon'])

		var track = playerState.track
		var isPlaying = playerState.status === 'playing'
		var isLoading = playerState.status === 'loading'
		var Tap = RN.Pressable || RN.TouchableOpacity

		var win = RN.useWindowDimensions ? RN.useWindowDimensions() : { height: 750 }
		var scrollMax = Math.max(300, Math.round(win.height - 180))

		// Tab Header Bar
		var tabButtons = [
			{ key: 'now_playing', label: 'Now Playing' },
			{ key: 'search', label: 'Search' },
			{ key: 'queue', label: 'Queue (' + queue.length + ')' },
			{ key: 'settings', label: 'Settings' }
		]

		return h(
			Design.ActionSheet,
			null,
			h(
				RN.View,
				{ style: { padding: 16, maxHeight: scrollMax } },
				// Top Tab Bar
				h(
					RN.View,
					{
						style: {
							flexDirection: 'row',
							backgroundColor: surfaceTertiary(),
							borderRadius: 10,
							padding: 4,
							marginBottom: 14
						}
					},
					tabButtons.map(function (b) {
						var active = currentTab === b.key
						return h(
							Tap,
							{
								key: b.key,
								onPress: function () { setTab(b.key) },
								style: {
									flex: 1,
									paddingVertical: 8,
									alignItems: 'center',
									borderRadius: 8,
									backgroundColor: active ? surface() : 'transparent'
								}
							},
							T({ variant: 'text-xs/bold', style: { color: active ? textNormal() : textMuted() } }, b.label)
						)
					})
				),

				// TAB 1: NOW PLAYING & LYRICS
				currentTab === 'now_playing' ? h(
					RN.ScrollView,
					{ showsVerticalScrollIndicator: false, contentContainerStyle: { alignItems: 'center', paddingBottom: 20 } },
					track ? [
						// Big Cover Art
						track.thumbnail
							? h(RN.Image, {
								key: 'cover',
								source: { uri: track.thumbnail },
								style: { width: 180, height: 180, borderRadius: 16, marginBottom: 14, backgroundColor: surfaceTertiary() }
							})
							: (MusicIcon ? h(MusicIcon, { key: 'icon', size: 'xxl', color: ACCENT_COLOR, style: { marginBottom: 14 } }) : null),
						// Song Title & Artist
						T({ key: 'title', variant: 'heading-lg/bold', numberOfLines: 1, style: { textAlign: 'center', color: textNormal() } }, track.title),
						T({ key: 'artist', variant: 'text-md/medium', numberOfLines: 1, style: { textAlign: 'center', color: textMuted(), marginTop: 4 } }, track.artist + (track.album ? ' • ' + track.album : '')),

						// Scrubber & Times
						h(
							RN.View,
							{ key: 'scrubber', style: { width: '100%', marginTop: 14 } },
							h(
								RN.View,
								{
									style: {
										height: 6,
										backgroundColor: surfaceTertiary(),
										borderRadius: 3,
										overflow: 'hidden'
									}
								},
								h(RN.View, {
									style: {
										height: '100%',
										backgroundColor: ACCENT_COLOR,
										width: String(Math.round((playerState.duration > 0 ? playerState.position / playerState.duration : 0) * 100)) + '%'
									}
								})
							),
							h(
								RN.View,
								{ style: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 } },
								T({ variant: 'text-xs/medium', style: { color: textMuted() } }, formatTime(playerState.position)),
								T({ variant: 'text-xs/medium', style: { color: textMuted() } }, formatTime(playerState.duration))
							)
						),

						// Interactive Seek & Main Controls
						h(
							RN.View,
							{ key: 'controls', style: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12 } },
							// Seek -10s
							h(
								Tap,
								{ onPress: function () { seekTo(playerState.position - 10) }, style: { padding: 8 } },
								T({ variant: 'text-xs/bold', style: { color: textMuted() } }, '-10s')
							),
							// Prev Track
							h(
								Tap,
								{ onPress: prevTrack, style: { padding: 8 } },
								PrevIcon ? h(PrevIcon, { size: 'md', color: textNormal() }) : T({ variant: 'text-sm/bold' }, '|<')
							),
							// Play/Pause Big Button
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
									? (PauseIcon ? h(PauseIcon, { size: 'md', color: '#fff' }) : T({ variant: 'text-md/bold', style: { color: '#fff' } }, '||'))
									: (PlayIcon ? h(PlayIcon, { size: 'md', color: '#fff' }) : T({ variant: 'text-md/bold', style: { color: '#fff' } }, '>'))
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
								T({ variant: 'text-xs/bold', style: { color: textMuted() } }, '+10s')
							)
						),

						// Synced Lyrics Container
						h(
							RN.View,
							{
								key: 'lyrics-box',
								style: {
									width: '100%',
									marginTop: 18,
									padding: 12,
									borderRadius: 12,
									backgroundColor: surfaceTertiary(),
									minHeight: 120
								}
							},
							T({ variant: 'text-xs/bold', style: { color: textMuted(), marginBottom: 8 } }, 'SYNCHRONIZED LYRICS (LRCLIB)'),
							lyricsState.status === 'loading'
								? T({ variant: 'text-sm/medium', style: { color: textMuted(), textAlign: 'center', marginVertical: 20 } }, 'Loading lyrics...')
								: (lyricsState.synced && lyricsState.synced.length > 0)
									? h(
										RN.ScrollView,
										{
											ref: function (ref) { activeLyricScrollRef.current = ref },
											style: { maxHeight: 150 },
											nestedScrollEnabled: true,
											showsVerticalScrollIndicator: true
										},
										lyricsState.synced.map(function (line, idx) {
											var isCurrent = idx === lyricsState.activeIndex
											return h(
												Tap,
												{
													key: String(line.timeMs) + '-' + idx,
													onPress: function () { seekTo(line.timeMs / 1000) },
													style: {
														paddingVertical: 4,
														paddingHorizontal: 6,
														borderRadius: 6,
														backgroundColor: isCurrent ? 'rgba(255, 0, 51, 0.2)' : 'transparent'
													}
												},
												T({
													variant: isCurrent ? 'text-md/bold' : 'text-sm/normal',
													style: {
														color: isCurrent ? '#ffffff' : textMuted(),
														textAlign: 'center'
													}
												}, line.text)
											)
										})
									)
									: T({ variant: 'text-sm/medium', style: { color: textMuted(), textAlign: 'center', marginVertical: 20 } }, lyricsState.plain ? lyricsState.plain : 'No synchronized lyrics available for this track.')
						)
					] : [
						T({ key: 'empty', variant: 'text-md/medium', style: { color: textMuted(), marginVertical: 40 } }, 'No music playing right now.'),
						h(
							Design.Button,
							{
								key: 'search-btn',
								text: 'Search Songs',
								variant: 'primary',
								onPress: function () { setTab('search') }
							}
						)
					]
				) : null,

				// TAB 2: SEARCH SONGS
				currentTab === 'search' ? h(
					RN.View,
					{ style: { flex: 1 } },
					// Search Input Row
					h(
						RN.View,
						{
							style: {
								flexDirection: 'row',
								alignItems: 'center',
								backgroundColor: surfaceTertiary(),
								borderRadius: 10,
								paddingHorizontal: 10,
								marginBottom: 12
							}
						},
						SearchIcon ? h(SearchIcon, { size: 'sm', color: textMuted() }) : null,
						h(Design.TextInput, {
							value: searchText,
							onChange: setSearchText,
							onSubmitEditing: function () { performSearch(searchText) },
							placeholder: 'Search songs, artists, albums...',
							style: { flex: 1, paddingVertical: 8, paddingHorizontal: 8, color: textNormal() }
						}),
						searchText ? h(
							Tap,
							{ onPress: function () { setSearchText(''); searchState.results = []; changed() }, style: { padding: 6 } },
							T({ variant: 'text-xs/bold', style: { color: textMuted() } }, 'X')
						) : null
					),
					// Search Button
					h(
						Design.Button,
						{
							text: searchState.loading ? 'Searching...' : 'Search',
							variant: 'primary',
							disabled: searchState.loading || !searchText.trim(),
							onPress: function () { performSearch(searchText) },
							style: { marginBottom: 12 }
						}
					),
					// Results ScrollView
					h(
						RN.ScrollView,
						{ style: { maxHeight: scrollMax - 140 }, nestedScrollEnabled: true, showsVerticalScrollIndicator: true },
						searchState.error ? T({ variant: 'text-sm/medium', style: { color: '#f23f43', textAlign: 'center', marginVertical: 14 } }, searchState.error) : null,
						searchState.results.map(function (s) {
							return h(
								RN.View,
								{
									key: s.videoId,
									style: {
										flexDirection: 'row',
										alignItems: 'center',
										padding: 8,
										borderRadius: 10,
										backgroundColor: surfaceTertiary(),
										marginBottom: 8,
										gap: 10
									}
								},
								// Thumbnail
								s.thumbnail
									? h(RN.Image, {
										source: { uri: s.thumbnail },
										style: { width: 44, height: 44, borderRadius: 8, backgroundColor: surface() }
									})
									: (MusicIcon ? h(MusicIcon, { size: 'md', color: ACCENT_COLOR }) : null),
								// Title & Info
								h(
									RN.View,
									{ style: { flex: 1 } },
									T({ variant: 'text-sm/bold', numberOfLines: 1, style: { color: textNormal() } }, s.title),
									T({ variant: 'text-xs/medium', numberOfLines: 1, style: { color: textMuted() } }, s.artist + (s.duration ? ' • ' + s.duration : ''))
								),
								// Action Buttons: Play Now & Add Queue
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
											paddingHorizontal: 10,
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
											paddingHorizontal: 8,
											borderRadius: 6
										}
									},
									T({ variant: 'text-xs/bold', style: { color: textNormal() } }, '+ Queue')
								)
							)
						})
					)
				) : null,

				// TAB 3: UP NEXT QUEUE & HISTORY
				currentTab === 'queue' ? h(
					RN.ScrollView,
					{ style: { maxHeight: scrollMax - 80 }, nestedScrollEnabled: true, showsVerticalScrollIndicator: true },
					// Header & Clear Queue
					h(
						RN.View,
						{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
						T({ variant: 'heading-md/bold', style: { color: textNormal() } }, 'Up Next (' + queue.length + ')'),
						queue.length > 0 ? h(
							Tap,
							{ onPress: clearQueue },
							T({ variant: 'text-xs/bold', style: { color: '#f23f43' } }, 'Clear All')
						) : null
					),
					queue.length === 0
						? T({ variant: 'text-sm/medium', style: { color: textMuted(), marginVertical: 14 } }, 'No upcoming tracks in queue. Search and tap "+ Queue" to add songs.')
						: queue.map(function (item, idx) {
							return h(
								RN.View,
								{
									key: item.videoId + '-' + idx,
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
									key: 'hist-' + item.videoId + '-' + idx,
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
						{ title: 'Audio Stream Provider' },
						h(Design.TableRow, {
							key: 'inst-desc',
							label: 'Custom Invidious Instance',
							subLabel: 'Optional custom URL (e.g. https://yt.chocolatemoo53.com). Leave empty to use automatic healthy fallback rotation.'
						}),
						h(Design.TextInput, {
							key: 'custom-inst-input',
							value: String(setting('customInstance') || ''),
							placeholder: 'https://...',
							onChange: function (val) {
								setSetting('customInstance', val)
								changed()
							},
							style: { marginHorizontal: 12, marginBottom: 12, color: textNormal() }
						})
					),
					h(
						Design.TableRowGroup,
						{ title: 'Playback Preferences' },
						h(Design.TableSwitchRow, {
							key: 'auto-play',
							label: 'Auto-play next track',
							subLabel: 'Automatically start the next track in queue when the current track finishes',
							value: Boolean(setting('autoPlayNext')),
							onValueChange: function (v) {
								setSetting('autoPlayNext', v)
								changed()
							}
						}),
						h(Design.TableSwitchRow, {
							key: 'mini-player',
							label: 'Show Mini-Player Bar',
							subLabel: 'Show compact playback bar floating above chat input',
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
							label: 'YouTube Music for Valenced',
							subLabel: 'Experimental ad-free music streaming with LRCLIB synchronized lyrics directly inside Discord.'
						}),
						h(Design.TableRow, {
							key: 'abt-2',
							label: 'Source Code & Catalog',
							subLabel: 'Built and maintained by asaprajx on GitHub.'
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
				{ title: 'YouTube Music' },
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
			)
		)
	}

	// ======================================================================================
	// Plugin Registration & Lifecycle
	// ======================================================================================
	var definePlugin = typeof plugin === 'function' ? plugin : (valenced.plugin || function (def) { return def })

	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
	exports.default = definePlugin({
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
