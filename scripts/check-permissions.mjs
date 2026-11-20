import { readFileSync } from 'node:fs';

const vars = readFileSync('.dev.vars', 'utf8');
const token = (vars.match(/^DISCORD_BOT_TOKEN=(.*)$/m) ?? [, ''])[1].trim();
if (token === '') { console.error('缺少 DISCORD_BOT_TOKEN'); process.exit(1); }

const [, , guildId, channelId] = process.argv;
const api = (path) => fetch('https://discord.com/api/v10' + path, { headers: { authorization: 'Bot ' + token } }).then(async (r) => ({ status: r.status, body: await r.json() }));

const me = await api('/users/@me');
if (me.status !== 200) { console.log(JSON.stringify({ me: me.status })); process.exit(0); }
const member = await api('/guilds/' + guildId + '/members/' + me.body.id);
const roles = await api('/guilds/' + guildId + '/roles');
const channel = await api('/channels/' + channelId);
if (member.status !== 200 || roles.status !== 200 || channel.status !== 200) {
  console.log(JSON.stringify({ member: member.status, roles: roles.status, channel: channel.status }));
  process.exit(0);
}

const perms = new Map(roles.body.map((r) => [r.id, BigInt(r.permissions)]));
const overwrites = new Map((channel.body.permission_overwrites ?? []).map((o) => [o.id, o]));
const everyone = perms.get(guildId) ?? 0n;
const memberRoles = member.body.roles ?? [];

const ALL = (1n << 64n) - 1n;
let base = everyone;
for (const id of memberRoles) base |= perms.get(id) ?? 0n;
if (overwrites.has(guildId)) { base &= ~BigInt(overwrites.get(guildId).deny); base |= BigInt(overwrites.get(guildId).allow); }
let roleAllow = 0n, roleDeny = 0n;
for (const id of memberRoles) { const o = overwrites.get(id); if (o) { roleAllow |= BigInt(o.allow); roleDeny |= BigInt(o.deny); } }
const memberOver = overwrites.get(member.body.user.id);
let eff = (base & ~roleDeny) | roleAllow;
if (memberOver) eff = (eff & ~BigInt(memberOver.deny)) | BigInt(memberOver.allow);

const bits = { viewChannel: 1n << 10n, sendMessages: 1n << 11n, readHistory: 1n << 16n, embedLinks: 1n << 14n, attachFiles: 1n << 15n };
const check = Object.fromEntries(Object.entries(bits).map(([k, v]) => [k, (eff & v) === v]));
console.log(JSON.stringify({ guild: guildId, channel: channelId, channelName: channel.body.name ?? '(unknown)', check, bitfield: eff.toString() }));
