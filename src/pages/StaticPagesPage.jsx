import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { resolveShopBaseUrl } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'
import { TEMPLATES, getTemplate, initialVars, renderTemplate } from '../lib/legalTemplates'
import { renderMarkdown } from '../lib/markdown'

// 店家自訂靜態頁（服務條款／FAQ／隱私權／自訂頁）。
// 內容存 store_pages.body（Markdown）；template 模式另存 template_key + vars 供回頭重編。
export default function StaticPagesPage() {
  const { profile, store, storeId } = useAuth()
  const isOwner = profile?.role === 'super_admin'

  const [pages, setPages] = useState([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(null) // 正在編輯的頁（含未儲存的新頁）
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const shopBase = resolveShopBaseUrl(store)

  async function load() {
    if (!storeId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('store_pages').select('*')
      .eq('store_id', storeId).order('sort_order').order('id')
    if (err) setError('載入失敗：' + err.message)
    else setPages(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [storeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 尚未建立的內建範本（依 slug 判斷）
  const missingTemplates = useMemo(() => {
    const used = new Set(pages.map(p => p.slug))
    return TEMPLATES.filter(t => !used.has(t.slug))
  }, [pages])

  // 目前 draft 的 Markdown 內容（template 模式即時渲染；custom 模式取 body）
  const draftBody = useMemo(() => {
    if (!draft) return ''
    if (draft.mode === 'template') {
      const tpl = getTemplate(draft.template_key)
      return tpl ? renderTemplate(tpl, draft.vars, store) : ''
    }
    return draft.body || ''
  }, [draft, store])

  const previewHtml = useMemo(() => renderMarkdown(draftBody), [draftBody])

  function startNewTemplate(tpl) {
    setError(''); setMsg('')
    setDraft({
      id: null, slug: tpl.slug, title: tpl.title, mode: 'template',
      template_key: tpl.key, vars: initialVars(tpl, store), body: '',
      is_published: false, sort_order: pages.length,
    })
  }
  function startNewCustom() {
    setError(''); setMsg('')
    setDraft({
      id: null, slug: '', title: '', mode: 'custom',
      template_key: null, vars: {}, body: '',
      is_published: false, sort_order: pages.length,
    })
  }
  function editExisting(page) {
    setError(''); setMsg('')
    setDraft({ ...page, vars: page.vars || {} })
  }

  const setField = (key, value) => setDraft(d => ({ ...d, [key]: value }))
  const setVar = (key, value) => setDraft(d => ({ ...d, vars: { ...d.vars, [key]: value } }))

  // 範本 → 全文自訂：把目前渲染結果灌進 body，切成 custom 模式
  function switchToCustom() {
    setDraft(d => ({ ...d, mode: 'custom', body: draftBody, template_key: null }))
  }

  function validSlug(s) { return /^[a-z0-9-]+$/.test(s) }

  async function save() {
    if (!draft) return
    setError('')
    const slug = (draft.slug || '').trim().toLowerCase()
    if (!slug || !validSlug(slug)) { setError('網址代稱只能用小寫英數與連字號（例：terms）'); return }
    if (!draft.title.trim()) { setError('請填標題'); return }
    // slug 不可與其他頁重複
    if (pages.some(p => p.slug === slug && p.id !== draft.id)) { setError(`代稱「${slug}」已被其他頁使用`); return }

    const body = draft.mode === 'template'
      ? renderTemplate(getTemplate(draft.template_key), draft.vars, store)
      : (draft.body || '')

    const row = {
      store_id: storeId, slug, title: draft.title.trim(),
      mode: draft.mode, template_key: draft.template_key,
      vars: draft.vars || {}, body,
      is_published: draft.is_published, sort_order: draft.sort_order ?? pages.length,
      updated_at: new Date().toISOString(),
    }

    setSaving(true)
    const q = draft.id
      ? supabase.from('store_pages').update(row).eq('id', draft.id)
      : supabase.from('store_pages').insert(row)
    const { error: err } = await q
    if (err) { setError('儲存失敗：' + err.message); setSaving(false); return }

    revalidateShop({ storeId, slug: store?.slug })
    setMsg('✓ 已儲存')
    setDraft(null)
    setSaving(false)
    load()
  }

  async function togglePublish(page) {
    const { error: err } = await supabase.from('store_pages')
      .update({ is_published: !page.is_published, updated_at: new Date().toISOString() })
      .eq('id', page.id)
    if (err) { setError('更新失敗：' + err.message); return }
    revalidateShop({ storeId, slug: store?.slug })
    load()
  }

  async function remove(page) {
    if (!window.confirm(`確定刪除「${page.title}」？此動作無法復原。`)) return
    const { error: err } = await supabase.from('store_pages').delete().eq('id', page.id)
    if (err) { setError('刪除失敗：' + err.message); return }
    revalidateShop({ storeId, slug: store?.slug })
    if (draft?.id === page.id) setDraft(null)
    load()
  }

  if (!isOwner) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅店主可管理靜態頁</div>
      </div>
    </div>
  )

  return (
    <div className="page">
      <style>{`
        .md-preview h3 { font-size: 16px; font-weight: 700; margin: 18px 0 8px; }
        .md-preview h4 { font-size: 14px; font-weight: 700; margin: 14px 0 6px; }
        .md-preview p { font-size: 13px; line-height: 1.8; margin: 8px 0; color: var(--text); }
        .md-preview ul { margin: 8px 0; padding-left: 20px; }
        .md-preview li { font-size: 13px; line-height: 1.8; margin: 4px 0; }
        .md-preview hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
        .md-preview a { color: var(--blue); }
      `}</style>

      <div className="ph">
        <div>
          <div className="ph-title">靜態頁</div>
          <div className="ph-sub">服務條款、FAQ、隱私權與自訂頁（顯示於商城）</div>
        </div>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--blue-bg)', color: 'var(--blue)', fontSize: 13 }}>{msg}</div>}

      {/* 一鍵建立內建範本 */}
      {!draft && missingTemplates.length > 0 && (
        <>
          <div className="sec">一鍵建立法律政策頁</div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 12 }}>
              內建合規範本，會自動帶入店名／客服等現有設定，你只需補幾個關鍵欄位即可發佈。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {missingTemplates.map(t => (
                <button key={t.key} type="button" onClick={() => startNewTemplate(t)}
                  style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>＋ 建立「{t.title}」</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{t.description}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* 現有頁面清單 */}
      {!draft && (
        <>
          <div className="sec" style={{ marginTop: 20 }}>頁面清單</div>
          <div className="card" style={{ padding: 16 }}>
            {loading ? (
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>載入中…</div>
            ) : pages.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>尚無頁面。用上方按鈕建立，或新增自訂頁。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pages.map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {p.title}
                        <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 6px', borderRadius: 4, background: p.is_published ? 'var(--blue-bg)' : 'var(--bg)', color: p.is_published ? 'var(--blue)' : 'var(--text-3)' }}>
                          {p.is_published ? '已發佈' : '草稿'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                        /{p.slug}{p.mode === 'custom' ? '（自訂）' : ''}
                        {p.is_published && shopBase && (
                          <> ・<a href={`${shopBase}/legal/${p.slug}`} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>檢視</a></>
                        )}
                      </div>
                    </div>
                    <button type="button" onClick={() => togglePublish(p)}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: 'var(--text)' }}>
                      {p.is_published ? '下架' : '發佈'}
                    </button>
                    <button type="button" onClick={() => editExisting(p)}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: 'var(--text)' }}>
                      編輯
                    </button>
                    <button type="button" onClick={() => remove(p)}
                      style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer' }}>刪除</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={startNewCustom}
              style={{ marginTop: 14, fontSize: 13, padding: '8px 14px', borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-2)' }}>
              ＋ 新增自訂頁
            </button>
          </div>
        </>
      )}

      {/* 編輯器 */}
      {draft && (
        <>
          <div className="sec">
            {draft.id ? '編輯頁面' : draft.mode === 'template' ? `建立「${draft.title}」` : '新增自訂頁'}
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">標題</label>
              <input className="form-input" type="text" value={draft.title}
                onChange={e => setField('title', e.target.value)} placeholder="例：服務條款" />
            </div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">網址代稱（/legal/代稱）</label>
              <input className="form-input" type="text" value={draft.slug}
                disabled={draft.mode === 'template' && !!getTemplate(draft.template_key)}
                onChange={e => setField('slug', e.target.value)} placeholder="terms" />
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
                商城網址：{shopBase || '（尚未設定網域）'}/legal/{draft.slug || '…'}
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!draft.is_published}
                onChange={e => setField('is_published', e.target.checked)} />
              發佈到商城（未勾為草稿，商城不顯示）
            </label>

            {/* template 模式：變數表單 */}
            {draft.mode === 'template' && getTemplate(draft.template_key) && (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>可自訂欄位</div>
                {getTemplate(draft.template_key).variables.map(v => (
                  <div key={v.key} className="form-group" style={{ marginBottom: 10 }}>
                    <label className="form-label">{v.label}</label>
                    <input className="form-input" type="text" placeholder={v.placeholder || ''}
                      value={draft.vars[v.key] ?? ''} onChange={e => setVar(v.key, e.target.value)} />
                    {v.hint && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-3)' }}>{v.hint}</div>}
                  </div>
                ))}
                <button type="button" onClick={switchToCustom}
                  style={{ marginTop: 4, fontSize: 12, background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', padding: 0 }}>
                  改用全文自訂（把目前內容轉成 Markdown 完全編輯）
                </button>
              </>
            )}

            {/* custom 模式：Markdown 全文 */}
            {draft.mode === 'custom' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">內容（Markdown：## 標題、- 清單、**粗體**、[文字](網址)）</label>
                <textarea className="form-input" rows={16}
                  style={{ resize: 'vertical', lineHeight: 1.7, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                  value={draft.body} onChange={e => setField('body', e.target.value)}
                  placeholder={'## 標題\n\n段落內容…\n\n- 項目一\n- 項目二'} />
              </div>
            )}
          </div>

          {/* 即時預覽 */}
          <div className="sec" style={{ marginTop: 16 }}>預覽</div>
          <div className="card md-preview" style={{ padding: 16 }}
            dangerouslySetInnerHTML={{ __html: previewHtml || '<p style="color:var(--text-3)">（無內容）</p>' }} />

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn" type="button" onClick={save} disabled={saving} style={{ flex: 1 }}>
              {saving ? '儲存中…' : '儲存'}
            </button>
            <button type="button" onClick={() => { setDraft(null); setError('') }}
              style={{ padding: '0 20px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: 'var(--text)' }}>
              取消
            </button>
          </div>
        </>
      )}
    </div>
  )
}
