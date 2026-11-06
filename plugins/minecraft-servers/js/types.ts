export interface MinecraftServer {
	id: string
	name: string
	address: string
	port?: number
	edition: 'java' | 'bedrock'
	note?: string
	favorite?: boolean
	watch?: boolean
	addedAt: number
}

export interface PlayerInfo {
	name: string
	id?: string
}

export interface ServerStatusData {
	online: boolean
	host: string
	ip?: string
	port?: number
	version?: string
	protocol?: number | null
	software?: string
	gamemode?: string
	srv?: string
	eula?: boolean
	players: {
		online: number
		max: number
		list: PlayerInfo[]
		hidden?: number
	}
	motd: string
	icon?: string
	ping: number | null
	providerPing?: number | null
	rawPing?: number | null
	pingFrom?: 'measuring' | 'phone' | 'site' | 'none'
	phoneReachable?: boolean
	pingNote?: string
	countsFrom?: string
	siteConflict?: boolean
	plugins?: string[]
	mods?: string[]
	via?: string[]
	error?: string
	retrievedAt?: number
}

export interface HistoryEntry {
	t: number
	o: 1 | 0
	p: number
	ms: number | null
}

export interface PluginSettings {
	servers: MinecraftServer[]
	history: Record<string, HistoryEntry[]>
	provider: 'auto' | 'mcstatus' | 'mcsrvstat' | 'minetools'
	timeout: number
	cacheSeconds: number
	refreshSeconds: number
	refreshSeconds2: number
	compact: boolean
	heads: boolean
	motd: boolean
	icons: boolean
	sort: 'manual' | 'status' | 'players' | 'name' | 'favorites'
	placement: 'menu' | 'left' | 'right'
	alerts: boolean
	alertSeconds: number
	historyLength: number
	pingSource: 'phone' | 'site'
	liveCounts: boolean
	plainScroll: boolean
	pingSamples: number
	pingFactor: number
}

export const DEFAULT_SETTINGS: PluginSettings = {
	servers: [],
	history: {},
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
