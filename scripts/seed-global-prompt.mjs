import { readFileSync } from 'node:fs';

const vars = readFileSync('.dev.vars', 'utf8');
const pw = (vars.match(/^ADMIN_PASSWORD=(.*)$/m) ?? [, ''])[1].trim();
const base = 'https://dc-ai-bot.<subdomain>.workers.dev';

const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
if (login.status !== 200 || cookie === '') { console.log(JSON.stringify({ login: login.status })); process.exit(0); }

const list = await (await fetch(base + '/api/prompts', { headers: { cookie } })).json();
const items = list.items ?? [];
const source = items.find((p) => p.scope === 'guild' && p.scopeId === '150000000000000002');
const existingGlobal = items.find((p) => p.scope === 'global');
console.log(JSON.stringify({ scopes: items.map((p) => p.scope + ':' + p.scopeId), hasSource: Boolean(source), hasGlobal: Boolean(existingGlobal) }));

if (!source) process.exit(0);
const body = { scope: 'global', scopeId: '', systemPrompt: source.systemPrompt };
if (typeof source.persona === 'string') body.persona = source.persona;
if (typeof source.temperature === 'number') body.temperature = source.temperature;
if (typeof source.maxTokens === 'number') body.maxTokens = source.maxTokens;
const put = await fetch(base + '/api/prompts', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
console.log(JSON.stringify({ put: put.status, body: (await put.text()).slice(0, 200) }));
