// 跨工具同步：opencode ⇄ pi 的 provider 级同步
// 策略（用户确认）：已存在同 ID → 覆盖更新，接口类型与模型均以源端为准；
// key 智能转换：pi 的 $ENV 引用 ↔ opencode 的 {env:ENV} 引用，其余写实际值明文。
const fs = require('fs');
const piStore = require('./piStore');
const opencodeStore = require('./opencodeStore');
const { CONFIG_PATHS } = require('./paths');
const { parseJsonc } = require('./jsonc');

const STORES = { opencode: opencodeStore, pi: piStore };

// 方向校验："pi->opencode" / "opencode->pi"
function parseDirection(direction) {
  const m = String(direction || '').match(/^(opencode|pi)\s*->\s*(opencode|pi)$/);
  if (!m || m[1] === m[2]) {
    throw new Error(`direction 非法: ${direction}（应为 "pi->opencode" 或 "opencode->pi"）`);
  }
  return { source: m[1], target: m[2] };
}

// 剥 UTF-8 BOM 后 JSON.parse，失败返回 {}
function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return {};
  }
}

// ---------- key 智能转换 ----------

// 识别源端 key 的形态（不要求本进程能读到值）：
// 返回 { kind: 'env-ref'|'plain'|'auth'|'none', envName?, actual?, skip, skipReason }
// - env-ref：$ENV / {env:ENV} 引用 → 直接把引用形式转写到目标端，两端运行时各自解析
// - plain：明文 → 写明文
// - auth：key 存于源端 auth.json → 读出实际值写明文
// - none：无 key → 目标端不写 key
function sourceKeyActual(tool, id, rawKey) {
  if (tool === 'pi') {
    if (rawKey.startsWith('$')) {
      const envName = rawKey.slice(1);
      const v = process.env[envName];
      return {
        kind: 'env-ref',
        envName,
        actual: (typeof v === 'string' && v.charCodeAt(0) === 0xfeff) ? v.slice(1) : (v || null),
        skip: false,
        note: process.env[envName] ? null : `本进程未读到环境变量 ${envName} 的值，仍会按引用同步（由目标端运行时解析）`,
      };
    }
    if (rawKey) return { kind: 'plain', actual: rawKey, skip: false };
    const auth = readJsonSafe(CONFIG_PATHS.piAuth);
    const k = auth[id] && auth[id].key;
    if (k) return { kind: 'auth', actual: k, skip: false, note: '源端 key 取自 pi 的 auth.json，将以明文写入目标端' };
    return { kind: 'none', skip: true, skipReason: '源端没有可用的 API key（配置与 auth.json 均未找到），目标端不写入 key' };
  }
  // opencode：{env:VAR} 引用 / 明文 / auth.json 兜底
  const m = rawKey.match(/^\{env:([^}]+)\}$/);
  if (m) {
    const envName = m[1].trim();
    const v = process.env[envName];
    return {
      kind: 'env-ref',
      envName,
      actual: (typeof v === 'string' && v.charCodeAt(0) === 0xfeff) ? v.slice(1) : (v || null),
      skip: false,
      note: process.env[envName] ? null : `本进程未读到环境变量 ${envName} 的值，仍会按引用同步（由目标端运行时解析）`,
    };
  }
  if (rawKey) return { kind: 'plain', actual: rawKey, skip: false };
  const auth = readJsonSafe(CONFIG_PATHS.ocAuth);
  const k = auth[id] && auth[id].key;
  if (k) return { kind: 'auth', actual: k, skip: false, note: '源端 key 取自 opencode 的 auth.json，将以明文写入目标端' };
  return { kind: 'none', skip: true, skipReason: '源端没有可用的 API key（配置与 auth.json 均未找到），目标端不写入 key' };
}

// 目标端应写入的 key 形式：
// - 引用：pi 写 $ENVNAME，opencode 写 {env:ENVNAME}（无需本进程读到值）
// - 明文 / auth 实际值：写明文
// - 无 key：不写
function keyForTarget(targetTool, k) {
  if (k.kind === 'env-ref') {
    return targetTool === 'pi' ? { apiKey: '$' + k.envName } : { apiKey: `{env:${k.envName}}` };
  }
  if (k.actual) {
    return {
      apiKey: k.actual,
      note: targetTool === 'pi'
        ? 'pi 侧写入了明文 key（源端为实际值；如需引用环境变量，可在编辑里改为 env:变量名 形式）'
        : 'opencode 侧写入了明文 key（源端为实际值）',
    };
  }
  return { apiKey: null };
}

// ---------- 数据准备 ----------

// 读取源端 provider 的 key 原始形式（pi：$ENV/明文；opencode：{env:}/明文）
function readRawKey(tool, id) {
  if (tool === 'pi') {
    const doc = readJsonSafe(CONFIG_PATHS.pi);
    const p = (doc.providers || {})[id];
    return (p && p.apiKey) || '';
  }
  try {
    const doc = parseJsonc(fs.readFileSync(CONFIG_PATHS.opencode, 'utf8'));
    const p = (doc.provider || {})[id];
    return (p && p.options && p.options.apiKey) || '';
  } catch {
    return '';
  }
}

// 读取源端某 provider 的完整数据（附内部字段 _rawApiKey 供 key 转换用）
function readSourceProvider(tool, provId) {
  const store = STORES[tool];
  const data = store.read();
  const prov = data.providers.find((p) => p.id === provId);
  if (!prov) throw new Error(`${tool} 中不存在 provider: ${provId}`);
  prov._rawApiKey = readRawKey(tool, provId);
  return prov;
}

// ---------- 预检 ----------

function plan(direction, providerIds) {
  const { source, target } = parseDirection(direction);
  const srcData = STORES[source].read();
  const tgtData = STORES[target].read();
  const tgtById = new Map(tgtData.providers.map((p) => [p.id, p]));
  const srcById = new Map(srcData.providers.map((p) => [p.id, p]));
  const wanted = providerIds && providerIds.length ? providerIds : srcData.providers.map((p) => p.id);

  const items = [];
  for (const id of wanted) {
    const src = srcById.get(id);
    if (!src) {
      items.push({ id, action: 'missing', existed: false, sourceModels: 0, targetModels: 0, notes: [`源端不存在 provider: ${id}`] });
      continue;
    }
    const tgt = tgtById.get(id);
    const k = sourceKeyActual(source, id, readRawKey(source, id));
    const t = keyForTarget(target, k);
    const notes = [];
    if (k.envName) notes.push(`key 以环境变量 ${k.envName} 引用形式写入，两端行为一致`);
    if (k.note) notes.push(k.note);
    if (t.note) notes.push(t.note);
    if (k.skip && k.skipReason) notes.push(k.skipReason);
    items.push({
      id,
      action: tgt ? 'overwrite' : 'create',
      existed: !!tgt,
      sourceName: src.name,
      sourceStyle: src.style,
      sourceModels: src.models.length,
      targetModels: tgt ? tgt.models.length : 0,
      targetStyle: tgt ? tgt.style : null,
      willSyncKey: !k.skip,
      keyNote: k.envName ? `引用环境变量 ${k.envName}` : (k.actual ? '写入明文 key' : '不写入 key'),
      notes,
    });
  }
  return {
    source,
    target,
    sourceConfigPath: srcData.configPath,
    targetConfigPath: tgtData.configPath,
    items,
  };
}

// ---------- 应用 ----------

async function apply(direction, providerIds) {
  const { source, target } = parseDirection(direction);
  const results = [];
  for (const id of providerIds || []) {
    try {
      const src = readSourceProvider(source, id);
      const k = sourceKeyActual(source, id, src._rawApiKey);
      const t = keyForTarget(target, k);
      const entry = {
        id: src.id,
        name: src.name,
        baseUrl: src.baseUrl,
        style: src.style, // 接口类型以源为准（用户确认）
        models: src.models.map((m) => ({ id: m.id, name: m.name })),
        apiKey: t.apiKey,
      };
      const { existed } = await STORES[target].upsertProvider(entry);
      results.push({
        id,
        ok: true,
        action: existed ? 'overwrite' : 'create',
        models: entry.models.length,
        keyWritten: !!t.apiKey,
        keyNote: k.envName
          ? `key 以环境变量 ${k.envName} 引用形式写入`
          : (t.apiKey ? 'key 写入明文' : (k.skip ? `key 未写入：${k.skipReason}` : 'key 未写入')),
        notes: [k.note, t.note].filter(Boolean),
      });
    } catch (e) {
      results.push({ id, ok: false, action: 'error', error: e.message });
    }
  }
  return {
    source,
    target,
    ok: results.every((r) => r.ok),
    results,
    summary: {
      created: results.filter((r) => r.ok && r.action === 'create').length,
      overwritten: results.filter((r) => r.ok && r.action === 'overwrite').length,
      failed: results.filter((r) => !r.ok).length,
    },
  };
}

module.exports = { plan, apply, parseDirection };

