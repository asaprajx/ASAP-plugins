import React from 'react'
import { View, Text, Pressable, ScrollView, Image, type StyleProp, type ViewStyle } from 'react-native'
import { Design } from '@valenced/discord/design'
import type { MinecraftServer, ServerStatusData } from './types'

export const COLORS = {
	GREEN: '#23a55a',
	RED: '#f23f43',
	AMBER: '#f0b232',
	GRAY: '#80848e',
	BLURPLE: '#5865f2',
	SURFACE: '#2b2d31',
	RAISED: '#35373c',
}

export function tint(hex: string, alpha: number): string {
	const m = /^#([0-9a-f]{6})$/i.exec(hex)
	if (!m) return hex
	const n = parseInt(m[1], 16)
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

export function pingColor(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return COLORS.GRAY
	return ms < 60 ? COLORS.GREEN : ms < 150 ? COLORS.AMBER : COLORS.RED
}

export function timeAgo(timestamp: number): string {
	const s = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
	if (s < 5) return 'just now'
	if (s < 60) return `${s}s ago`
	if (s < 3600) return `${Math.round(s / 60)}m ago`
	return `${Math.round(s / 3600)}h ago`
}

export function Card({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
	return (
		<View style={[{ backgroundColor: COLORS.SURFACE, borderRadius: 14, padding: 14, gap: 10 }, style]}>
			{children}
		</View>
	)
}

export function Chip({ text, color = COLORS.GRAY, dot }: { text: string; color?: string; dot?: boolean }) {
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: tint(color, 0.18), alignSelf: 'flex-start' }}>
			{dot && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />}
			<Design.Text variant="text-xs/bold" style={{ color }}>{text}</Design.Text>
		</View>
	)
}

function tileColor(text: string): string {
	let n = 0
	for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) >>> 0
	const palette = ['#5865f2', '#3ba55d', '#eb459e', '#faa81a', '#ed4245', '#1abc9c', '#9b59b6', '#3498db']
	return palette[n % 8]
}

export function ServerAvatar({
	server,
	data,
	size = 48,
	dotColor,
	showIcons = true,
}: {
	server: MinecraftServer
	data?: ServerStatusData
	size?: number
	dotColor?: string
	showIcons?: boolean
}) {
	const inner = showIcons && data?.icon ? (
		<Image source={{ uri: data.icon }} style={{ width: size, height: size, borderRadius: Math.round(size * 0.22) }} />
	) : (
		<View style={{ width: size, height: size, borderRadius: Math.round(size * 0.22), backgroundColor: tileColor(server.address), alignItems: 'center', justifyContent: 'center' }}>
			<Design.Text variant="heading-md/bold" style={{ color: '#ffffff' }}>
				{String(server.name || server.address).charAt(0).toUpperCase()}
			</Design.Text>
		</View>
	)

	return (
		<View style={{ width: size, height: size }}>
			{inner}
			{dotColor && (
				<View style={{ position: 'absolute', right: -3, bottom: -3, width: 16, height: 16, borderRadius: 8, backgroundColor: dotColor, borderWidth: 3, borderColor: COLORS.SURFACE }} />
			)}
		</View>
	)
}

export function SparkBar({ list }: { list: Array<{ o: number; p: number }> }) {
	const recent = list.slice(-30)
	const peak = Math.max(1, recent.reduce((m, x) => Math.max(m, x.p || 0), 0))
	return (
		<View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 46, gap: 3 }}>
			{recent.map((x, i) => {
				const height = x.o ? Math.max(5, Math.round(((x.p || 0) / peak) * 46)) : 46
				return (
					<View
						key={i}
						style={{
							flex: 1,
							height,
							borderRadius: 3,
							backgroundColor: x.o ? COLORS.GREEN : tint(COLORS.RED, 0.5),
						}}
					/>
				)
			})}
		</View>
	)
}

export function StatCard({
	label,
	value,
	sub,
	color,
	children,
}: {
	label: string
	value: string | number
	sub?: string
	color?: string
	children?: React.ReactNode
}) {
	return (
		<View style={{ flexBasis: '48%', flexGrow: 1, backgroundColor: COLORS.SURFACE, borderRadius: 14, padding: 14, gap: 4 }}>
			<Design.Text variant="text-xs/semibold" color="text-muted">{String(label).toUpperCase()}</Design.Text>
			<Design.Text variant="heading-md/bold" numberOfLines={1} style={color ? { color } : undefined}>{value}</Design.Text>
			{sub ? <Design.Text variant="text-xs/medium" color="text-muted" numberOfLines={1}>{sub}</Design.Text> : null}
			{children}
		</View>
	)
}

export function SegmentedTabs<T extends string>({
	items,
	value,
	onChange,
	compact,
}: {
	items: Array<{ value: T; label: string }>
	value: T
	onChange: (val: T) => void
	compact?: boolean
}) {
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: compact ? 6 : 8 }}>
			{items.map((item) => {
				const active = item.value === value
				return (
					<Pressable key={item.value} onPress={() => onChange(item.value)}>
						<View style={{ paddingHorizontal: compact ? 11 : 14, paddingVertical: 7, borderRadius: 999, backgroundColor: active ? COLORS.BLURPLE : COLORS.RAISED }}>
							<Design.Text variant="text-sm/semibold" style={{ color: active ? '#ffffff' : '#dbdee1' }}>
								{item.label}
							</Design.Text>
						</View>
					</Pressable>
				)
			})}
		</ScrollView>
	)
}
