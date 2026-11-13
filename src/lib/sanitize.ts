// Markdown 渲染白名单消毒：marked 允许内嵌原始 HTML，直接注入 innerHTML 会造成 XSS。
// 这里用浏览器 DOMParser 解析后按标签/属性白名单重建，再序列化回 HTML。

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 's', 'u', 'blockquote', 'mark', 'kbd', 'i', 'b', 'small',
  'ul', 'ol', 'li', 'code', 'pre', 'a', 'img', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
  'details', 'summary',
])
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math',
  'template', 'link', 'meta', 'base', 'noscript',
])
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  code: new Set(['class']),
  pre: new Set(['class']),
  th: new Set(['align']),
  td: new Set(['align']),
}

/** 仅允许 http/https 链接；javascript: / data: 等返回空串 */
export function safeHttpUrl(raw: string): string {
  try {
    const u = new URL(raw, window.location.origin)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href
  } catch {
    // 非法 URL
  }
  return ''
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const body = doc.body
  // 从叶到根：先解包/删除内层未知标签，再处理外层，保证提升出的子节点也被清理
  const elements = Array.from(body.querySelectorAll('*')).reverse()
  for (const el of elements) {
    if (!el.isConnected) continue
    const tag = el.tagName.toLowerCase()
    if (DROP_TAGS.has(tag)) {
      el.remove()
      continue
    }
    if (!ALLOWED_TAGS.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }
    const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>()
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (!allowed.has(name)) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === 'href' || name === 'src') {
        const safe = safeHttpUrl(attr.value)
        if (safe) el.setAttribute(name, safe)
        else el.removeAttribute(attr.name)
      }
    }
    if (tag === 'a' && el.getAttribute('target') === '_blank') {
      el.setAttribute('rel', 'noopener noreferrer')
    }
  }
  return body.innerHTML
}
