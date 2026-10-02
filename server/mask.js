// key 打码：前端永远拿不到完整 key
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.startsWith('$')) return s; // $ENV 引用名本身不敏感
  if (s.length <= 12) return s.slice(0, 2) + '****';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

module.exports = { maskKey };
