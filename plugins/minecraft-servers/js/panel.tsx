import React, { useState, useEffect } from 'react'
import { View, ScrollView, Pressable } from 'react-native'
import { Design } from '@valenced/discord/design'
import { actions } from '@valenced/discord/actions'
import { ReactNativeClipboard } from '@valenced/externals/react-native-clipboard'
import { Card, Chip, ServerAvatar, SparkBar, StatCard, SegmentedTabs, COLORS, pingColor, timeAgo } from './components'
import { formatAddress, parseAddress } from './status'
import type { MinecraftServer, ServerStatusData, PluginSettings } from './types'

export function MinecraftServersPanel({
	settings,
	results,
	onUpdateSettings,
	onRefresh,
	onClose,
}: {
	settings: PluginSettings
	results: Record<string, { state: string; data?: ServerStatusData; at: number }>
	onUpdateSettings: (patch: Partial<PluginSettings>) => void
	onRefresh: (server: MinecraftServer, force: boolean) => void
	onClose: () => void
}) {
	const [activeView, setActiveView] = useState<{ name: 'list' | 'detail' | 'edit'; id?: string }>({ name: 'list' })
	const [editForm, setEditForm] = useState<Partial<MinecraftServer>>({
		name: '',
		address: '',
		port: 0,
		edition: 'java',
		favorite: false,
		watch: false,
		note: '',
	})

	const servers = settings?.servers || []
	const selectedServer = servers.find(s => s.id === activeView.id)

	const startAdd = () => {
		setEditForm({
			name: '',
			address: '',
			port: 0,
			edition: 'java',
			favorite: false,
			watch: false,
			note: '',
		})
		setActiveView({ name: 'edit' })
	}

	const startEdit = (s: MinecraftServer) => {
		setEditForm({ ...s })
		setActiveView({ name: 'edit', id: s.id })
	}

	const saveServer = () => {
		const parsed = parseAddress(editForm.address || '', editForm.port)
		if (parsed.error) {
			actions.ToastActionCreators.open('MC_VAL_ERR', { text: parsed.error })
			return
		}

		const id = editForm.id || 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
		const clean: MinecraftServer = {
			id,
			name: (editForm.name || parsed.host || 'Minecraft Server').trim(),
			address: parsed.host!,
			port: parsed.port || 0,
			edition: editForm.edition || 'java',
			note: (editForm.note || '').trim(),
			favorite: !!editForm.favorite,
			watch: !!editForm.watch,
			addedAt: editForm.addedAt || Date.now(),
		}

		const updated = selectedServer
			? servers.map(s => (s.id === selectedServer.id ? clean : s))
			: [...servers, clean]

		onUpdateSettings({ servers: updated })
		onRefresh(clean, true)
		setActiveView({ name: 'list' })
		actions.ToastActionCreators.open('MC_SAVED', { text: `Saved ${clean.name}` })
	}

	const deleteServer = (id: string) => {
		const updated = servers.filter(s => s.id !== id)
		onUpdateSettings({ servers: updated })
		setActiveView({ name: 'list' })
		actions.ToastActionCreators.open('MC_DELETED', { text: 'Server deleted' })
	}

	const copyText = (txt: string, msg: string) => {
		ReactNativeClipboard.Clipboard.setString(txt)
		actions.ToastActionCreators.open('MC_COPY', { text: `${msg} copied!` })
	}

	return (
		<View style={{ flex: 1, padding: 16, gap: 14 }}>
			{/* LIST VIEW */}
			{activeView.name === 'list' && (
				<ScrollView contentContainerStyle={{ gap: 12 }}>
					<View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
						<Design.Text variant="heading-lg/bold">Minecraft Servers</Design.Text>
						<Design.Button text="+ Add" size="sm" variant="primary" onPress={startAdd} />
					</View>

					{servers.length === 0 ? (
						<Card>
							<Design.Text variant="text-md/medium" color="text-muted" style={{ textAlign: 'center', paddingVertical: 20 }}>
								No Minecraft servers saved yet. Tap "+ Add" to track your first server!
							</Design.Text>
						</Card>
					) : (
						servers.map(server => {
							const r = results[server.id]
							const d = r?.data
							const isOnline = d?.online
							const stColor = !r || r.state === 'loading' ? COLORS.GRAY : isOnline ? COLORS.GREEN : COLORS.RED

							return (
								<Pressable key={server.id} onPress={() => setActiveView({ name: 'detail', id: server.id })}>
									<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: settings?.compact ? 10 : 12, borderRadius: 14, backgroundColor: COLORS.SURFACE }}>
										<ServerAvatar server={server} data={d} dotColor={stColor} showIcons={settings?.icons} />
										<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
											<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
												<Design.Text variant="text-md/bold" numberOfLines={1}>
													{server.name}
												</Design.Text>
												{server.favorite && <Design.Text variant="text-sm/bold" style={{ color: COLORS.AMBER }}>★</Design.Text>}
											</View>
											<Design.Text variant="text-xs/medium" color="text-muted" numberOfLines={1}>
												{formatAddress(server)}
											</Design.Text>
										</View>

										{isOnline && (
											<View style={{ alignItems: 'flex-end', gap: 2 }}>
												<Chip text={`${d.players.online}/${d.players.max}`} color={COLORS.GREEN} />
												{d.ping !== null && (
													<Design.Text variant="text-xs/semibold" style={{ color: pingColor(d.ping) }}>
														{d.ping}ms
													</Design.Text>
												)}
											</View>
										)}
									</View>
								</Pressable>
							)
						})
					)}
				</ScrollView>
			)}

			{/* DETAIL VIEW */}
			{activeView.name === 'detail' && selectedServer && (
				<ScrollView contentContainerStyle={{ gap: 14 }}>
					<Design.Button text="‹ Back to Servers" size="sm" variant="secondary" onPress={() => setActiveView({ name: 'list' })} />
					{(() => {
						const r = results[selectedServer.id]
						const d = r?.data
						const isOnline = d?.online
						const history = (settings?.history && settings.history[selectedServer.id]) || []

						return (
							<>
								<View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
									<ServerAvatar server={selectedServer} data={d} size={56} showIcons={settings?.icons} />
									<View style={{ flex: 1, gap: 4 }}>
										<Design.Text variant="heading-lg/bold">{selectedServer.name}</Design.Text>
										<Design.Text variant="text-sm/medium" color="text-muted" onPress={() => copyText(formatAddress(selectedServer), 'Address')}>
											{formatAddress(selectedServer)} (tap to copy)
										</Design.Text>
									</View>
								</View>

								<View style={{ flexDirection: 'row', gap: 8 }}>
									<Design.Button text="Refresh" size="sm" variant="secondary" onPress={() => onRefresh(selectedServer, true)} />
									<Design.Button text="Edit" size="sm" variant="secondary" onPress={() => startEdit(selectedServer)} />
									<Design.Button text="Delete" size="sm" variant="destructive" onPress={() => deleteServer(selectedServer.id)} />
								</View>

								<Card>
									<View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
										<Chip text={isOnline ? 'Online' : 'Offline'} color={isOnline ? COLORS.GREEN : COLORS.RED} dot />
										{r?.at ? <Design.Text variant="text-xs/medium" color="text-muted">{timeAgo(r.at)}</Design.Text> : null}
									</View>
									{d?.motd ? (
										<Design.Text variant="text-sm/medium" style={{ marginTop: 4 }}>
											{d.motd}
										</Design.Text>
									) : null}
								</Card>

								<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
									<StatCard
										label="Players"
										value={isOnline ? `${d?.players.online} / ${d?.players.max}` : '—'}
										sub={d?.countsFrom ? `Source: ${d.countsFrom}` : undefined}
									/>
									<StatCard
										label="Ping"
										value={d?.ping !== null && d?.ping !== undefined ? `${d.ping} ms` : '—'}
										color={pingColor(d?.ping)}
										sub={d?.pingFrom ? `Measured via ${d.pingFrom}` : undefined}
									/>
									<StatCard
										label="Version"
										value={d?.version || selectedServer.edition.toUpperCase()}
										sub={d?.software || 'Minecraft'}
									/>
									<StatCard
										label="Checks"
										value={history.length}
										sub={history.length ? `${Math.round((history.filter(h => h.o).length / history.length) * 100)}% uptime` : 'No history'}
									/>
								</View>

								{history.length > 0 && (
									<Card>
										<Design.Text variant="text-xs/semibold" color="text-muted">PLAYER HISTORY</Design.Text>
										<SparkBar list={history} />
									</Card>
								)}
							</>
						)
					})()}
				</ScrollView>
			)}

			{/* EDIT / ADD VIEW */}
			{activeView.name === 'edit' && (
				<ScrollView contentContainerStyle={{ gap: 14 }}>
					<Design.Text variant="heading-lg/bold">
						{selectedServer ? 'Edit Server' : 'Add Minecraft Server'}
					</Design.Text>

					<Design.TextInput
						label="Server Address"
						placeholder="play.example.com"
						value={editForm.address || ''}
						onChange={(v: string) => setEditForm(f => ({ ...f, address: v }))}
						autoCapitalize="none"
					/>

					<Design.TextInput
						label="Server Name (Optional)"
						placeholder="Survival World"
						value={editForm.name || ''}
						onChange={(v: string) => setEditForm(f => ({ ...f, name: v }))}
					/>

					<View style={{ gap: 6 }}>
						<Design.Text variant="text-sm/semibold">Edition</Design.Text>
						<SegmentedTabs
							items={[{ value: 'java', label: 'Java Edition' }, { value: 'bedrock', label: 'Bedrock Edition' }]}
							value={editForm.edition || 'java'}
							onChange={(edition) => setEditForm(f => ({ ...f, edition }))}
						/>
					</View>

					<Design.TextInput
						label="Custom Note (Optional)"
						placeholder="e.g. Whitelisted, hosted by Alex"
						value={editForm.note || ''}
						onChange={(v: string) => setEditForm(f => ({ ...f, note: v }))}
					/>

					<Design.TableRowGroup>
						<Design.TableSwitchRow
							label="Favorite"
							subLabel="Display star and prioritize in list"
							value={!!editForm.favorite}
							onValueChange={(favorite: boolean) => setEditForm(f => ({ ...f, favorite }))}
						/>
						<Design.TableSwitchRow
							label="Notify Online/Offline"
							subLabel="Send alert when this server state changes"
							value={!!editForm.watch}
							onValueChange={(watch: boolean) => setEditForm(f => ({ ...f, watch }))}
						/>
					</Design.TableRowGroup>

					<View style={{ flexDirection: 'row', gap: 10 }}>
						<Design.Button text="Cancel" size="md" variant="secondary" onPress={() => setActiveView({ name: 'list' })} />
						<Design.Button text="Save Server" size="md" variant="primary" onPress={saveServer} />
					</View>
				</ScrollView>
			)}
		</View>
	)
}
