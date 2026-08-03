import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { resolveShopBaseUrl, slugifyProductName } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'
import { compressImage } from '../lib/imageUtils'

// 組合商品：店家把幾件商品綁成一套、設一口價，拿到專屬網址貼 IG 導購。
//
// 組合**不是商品**（見 docs/adr/0004）：不進庫存、不成為訂單品項。
// 消費者買下一套時，訂單品項仍是各件商品，套裝價與原價加總的差額走 discount_amount。
// 所以這頁只管三件事：綁哪幾件、一口價多少、落地頁長什麼樣。
//
// slug 一律由名稱推導（與商品頁共用 slugifyProductName），不給手動編輯 ——
// 商城落地頁的正規網址是用名稱重算的，兩邊各自維護一定會歪。
export default function BundlesPage() {
  const { profile, store, storeId } = useAuth()
  const canManage = profile?.role === 'super_admin' || profile?.role === 'admin'

  const [bundles, setBundles] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [copiedId, setCopiedId] = useState(null)
  const [pickerQuery, setPickerQuery] = useState('')

  const shopBase = (import.meta.env.DEV && import.meta.env.VITE_SHOP_URL)
    ? import.meta.env.VITE_SHOP_URL.replace(/\/+$/, '')
    : resolveShopBaseUrl(store)

  async function load() {
    if (!storeId) return
    setLoading(true)
    const [{ data: bs, error: be }, { data: ps }] = await Promise.all([
      supabase.from('bundles')
        .select('*, bundle_items(id, product_id, sort_order)')
        .eq('store_id', storeId).order('sort_order').order('id'),
      supabase.from('storefront_products')
        .select('product_id, shop_price, published, products(name, product_images(url, sort_order))')
        .eq('store_id', storeId).order('sort_order'),
    ])
    if (be) setError('載入失敗：' + be.message)
    else setBundles(bs || [])
    setProducts((ps || []).map(sp => ({
      id: sp.product_id,
      name: sp.products?.name || `#${sp.product_id}`,
      price: Number(sp.shop_price) || 0,
      published: sp.published,
      image: [...(sp.products?.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url || null,
    })))
    setLoading(false)
  }
  useEffect(() => { load() }, [storeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products])

  function bundleUrl(b) {
    if (!shopBase) return ''
    return `${shopBase}/bundles/${b.id}/${encodeURIComponent(b.slug || slugifyProductName(b.name))}`
  }

  async function copyUrl(b) {
    const url = bundleUrl(b)
    if (!url) { setError('尚未設定商城網域，無法產生連結'); return }
    try { await navigator.clipboard.writeText(url) } catch { /* 權限被擋就算了 */ }
    setCopiedId(b.id)
    setTimeout(() => setCopiedId(null), 1800)
  }

  function startNew() {
    setError(''); setMsg('')
    setPickerQuery('')
    setDraft({
      id: null, name: '', bundle_price: '', hero_image_url: '', description: '',
      is_published: false, sort_order: bundles.length, productIds: [],
    })
  }

  function editExisting(b) {
    setError(''); setMsg('')
    setPickerQuery('')
    setDraft({
      ...b,
      bundle_price: b.bundle_price ?? '',
      description: b.description || '',
      hero_image_url: b.hero_image_url || '',
      productIds: [...(b.bundle_items || [])].sort((a, b2) => a.sort_order - b2.sort_order).map(bi => bi.product_id),
    })
  }

  const setField = (k, v) => setDraft(d => ({ ...d, [k]: v }))

  function toggleProduct(pid) {
    setDraft(d => ({
      ...d,
      productIds: d.productIds.includes(pid) ? d.productIds.filter(x => x !== pid) : [...d.productIds, pid],
    }))
  }
  function moveProduct(idx, delta) {
    setDraft(d => {
      const next = [...d.productIds]
      const to = idx + delta
      if (to < 0 || to >= next.length) return d
      ;[next[idx], next[to]] = [next[to], next[idx]]
      return { ...d, productIds: next }
    })
  }

  // 落地頁主圖：與商品圖同一個 bucket，路徑另開 bundles/ 前綴避免與商品資料夾混在一起
  async function uploadHero(file) {
    if (!file) return
    setUploading(true); setError('')
    try {
      const compressed = await compressImage(file)
      const ext = compressed.name.split('.').pop().toLowerCase()
      const path = `bundles/${storeId}/${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, compressed)
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(path)
      setField('hero_image_url', publicUrl)
    } catch (e) {
      setError('圖片上傳失敗：' + (e.message || e))
    }
    setUploading(false)
  }

  // 名稱 → slug，同店撞號時補 -2、-3…（DB 有 unique (store_id, slug) 兜底）
  function uniqueSlug(name, selfId) {
    const base = slugifyProductName(name) || 'bundle'
    const taken = new Set(bundles.filter(b => b.id !== selfId).map(b => b.slug))
    if (!taken.has(base)) return base
    for (let n = 2; n < 100; n++) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
    }
    return `${base}-${Date.now()}`
  }

  const listTotal = useMemo(
    () => (draft?.productIds || []).reduce((s, pid) => s + (productById.get(pid)?.price || 0), 0),
    [draft, productById],
  )

  async function save() {
    if (!draft) return
    setError('')
    const name = (draft.name || '').trim()
    if (!name) { setError('請填組合名稱'); return }
    if (draft.productIds.length < 2) { setError('組合至少要有兩件商品'); return }
    const price = Number(draft.bundle_price)
    if (!Number.isFinite(price) || price <= 0) { setError('請填套裝價（一口價）'); return }
    if (draft.is_published && price >= listTotal) {
      setError(`套裝價 NT$${price.toLocaleString()} 未低於原價加總 NT$${listTotal.toLocaleString()}，消費者不會拿到折扣`)
      return
    }

    const row = {
      store_id: storeId,
      name,
      slug: uniqueSlug(name, draft.id),
      bundle_price: price,
      hero_image_url: draft.hero_image_url || null,
      description: draft.description || '',
      is_published: !!draft.is_published,
      sort_order: draft.sort_order ?? bundles.length,
    }

    setSaving(true)
    let bundleId = draft.id
    if (bundleId) {
      const { error: e1 } = await supabase.from('bundles').update(row).eq('id', bundleId)
      if (e1) { setError('儲存失敗：' + e1.message); setSaving(false); return }
    } else {
      const { data, error: e1 } = await supabase.from('bundles').insert(row).select('id').single()
      if (e1) { setError('儲存失敗：' + e1.message); setSaving(false); return }
      bundleId = data.id
    }

    // 品項整批換掉：數量少，改動也不頻繁，先刪再插最不容易出錯
    await supabase.from('bundle_items').delete().eq('bundle_id', bundleId)
    if (draft.productIds.length > 0) {
      const { error: e2 } = await supabase.from('bundle_items').insert(
        draft.productIds.map((pid, i) => ({ bundle_id: bundleId, product_id: pid, sort_order: i })),
      )
      if (e2) { setError('儲存商品清單失敗：' + e2.message); setSaving(false); return }
    }

    revalidateShop({ storeId, slug: store?.slug })
    setMsg('✓ 已儲存')
    setDraft(null)
    setSaving(false)
    load()
  }

  async function togglePublish(b) {
    const { error: err } = await supabase.from('bundles')
      .update({ is_published: !b.is_published }).eq('id', b.id)
    if (err) { setError('更新失敗：' + err.message); return }
    revalidateShop({ storeId, slug: store?.slug })
    load()
  }

  async function remove(b) {
    if (!window.confirm(`確定刪除組合「${b.name}」？此動作無法復原（不影響商品本身）。`)) return
    const { error: err } = await supabase.from('bundles').delete().eq('id', b.id)
    if (err) { setError('刪除失敗：' + err.message); return }
    revalidateShop({ storeId, slug: store?.slug })
    if (draft?.id === b.id) setDraft(null)
    load()
  }

  if (!canManage) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅店主與管理員可管理組合商品</div>
      </div>
    </div>
  )

  const filteredProducts = products.filter(p =>
    !pickerQuery.trim() || p.name.toLowerCase().includes(pickerQuery.trim().toLowerCase()),
  )

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">組合商品</div>
          <div className="ph-sub">把幾件商品綁成一套、設一口價，拿專屬網址貼社群</div>
        </div>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--blue-bg)', color: 'var(--blue)', fontSize: 13 }}>{msg}</div>}

      {/* 清單 */}
      {!draft && (
        <div className="card" style={{ padding: 16 }}>
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>載入中…</div>
          ) : bundles.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.7 }}>
              還沒有組合。建一個「整套穿搭」把三、四件商品綁在一起，貼到 IG 讓客人一鍵買整套。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bundles.map(b => {
                const count = (b.bundle_items || []).length
                return (
                  <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                    {b.hero_image_url
                      ? <img src={b.hero_image_url} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
                      : <div style={{ width: 44, height: 44, borderRadius: 8, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>🎁</div>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {b.name}
                        <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 6px', borderRadius: 4, background: b.is_published ? 'var(--blue-bg)' : 'var(--bg)', color: b.is_published ? 'var(--blue)' : 'var(--text-3)' }}>
                          {b.is_published ? '已發佈' : '草稿'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                        {count} 件 ・套裝價 NT${Number(b.bundle_price).toLocaleString()}
                      </div>
                    </div>
                    <button type="button" onClick={() => copyUrl(b)}
                      style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: copiedId === b.id ? 'var(--blue-bg)' : 'var(--bg)', color: copiedId === b.id ? 'var(--blue)' : 'var(--text)', cursor: 'pointer', fontWeight: 600, flexShrink: 0 }}>
                      {copiedId === b.id ? '✓ 已複製' : '複製連結'}
                    </button>
                    <button type="button" onClick={() => togglePublish(b)}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: 'var(--text)' }}>
                      {b.is_published ? '下架' : '發佈'}
                    </button>
                    <button type="button" onClick={() => editExisting(b)}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: 'var(--text)' }}>
                      編輯
                    </button>
                    <button type="button" onClick={() => remove(b)}
                      style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer' }}>刪除</button>
                  </div>
                )
              })}
            </div>
          )}
          <button type="button" onClick={startNew}
            style={{ marginTop: 14, fontSize: 13, padding: '8px 14px', borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-2)' }}>
            ＋ 新增組合
          </button>
        </div>
      )}

      {/* 編輯器 */}
      {draft && (
        <>
          <div className="sec">{draft.id ? '編輯組合' : '新增組合'}</div>
          <div className="card" style={{ padding: 16 }}>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">組合名稱</label>
              <input className="form-input" type="text" value={draft.name}
                onChange={e => setField('name', e.target.value)} placeholder="例：春日出遊三件組" />
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)', wordBreak: 'break-all' }}>
                網址：{shopBase || '（尚未設定網域）'}/bundles/{draft.id || '…'}/{slugifyProductName(draft.name) || '…'}
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">套裝價（一口價）</label>
              <input className="form-input" type="number" inputMode="numeric" value={draft.bundle_price}
                onChange={e => setField('bundle_price', e.target.value)} placeholder="2500" />
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
                已選商品原價加總 NT${listTotal.toLocaleString()}
                {Number(draft.bundle_price) > 0 && listTotal > 0 && (
                  Number(draft.bundle_price) < listTotal
                    ? <>　→　客人省 <strong>NT${(listTotal - Number(draft.bundle_price)).toLocaleString()}</strong></>
                    : <span style={{ color: 'var(--red)' }}>　→　套裝價沒有比原價便宜</span>
                )}
                <div>套裝價只在整套齊全時成立，且不與優惠券、會員等級折扣併用。</div>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">落地頁主圖</label>
              {draft.hero_image_url && (
                <img src={draft.hero_image_url} alt="" style={{ width: 140, height: 140, objectFit: 'cover', borderRadius: 10, display: 'block', marginBottom: 8 }} />
              )}
              <input type="file" accept="image/*" disabled={uploading}
                onChange={e => uploadHero(e.target.files?.[0])} style={{ fontSize: 13 }} />
              {uploading && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>上傳中…</div>}
              {draft.hero_image_url && (
                <button type="button" onClick={() => setField('hero_image_url', '')}
                  style={{ marginTop: 6, fontSize: 12, background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', padding: 0 }}>
                  移除主圖
                </button>
              )}
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">介紹文字</label>
              <textarea className="form-input" rows={4} style={{ resize: 'vertical', lineHeight: 1.7 }}
                value={draft.description} onChange={e => setField('description', e.target.value)}
                placeholder="這一套怎麼搭、適合什麼場合…" />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!draft.is_published}
                onChange={e => setField('is_published', e.target.checked)} />
              發佈到商城（未勾為草稿，商城看不到）
            </label>
          </div>

          {/* 商品清單 */}
          <div className="sec" style={{ marginTop: 16 }}>這一套包含哪些商品</div>
          <div className="card" style={{ padding: 16 }}>
            {draft.productIds.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>還沒選商品。從下面的清單勾選。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {draft.productIds.map((pid, idx) => {
                  const p = productById.get(pid)
                  return (
                    <div key={pid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-3)', width: 18 }}>{idx + 1}</span>
                      {p?.image
                        ? <img src={p.image} alt="" style={{ width: 34, height: 34, borderRadius: 6, objectFit: 'cover' }} />
                        : <div style={{ width: 34, height: 34, borderRadius: 6, background: 'var(--bg)' }} />}
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
                        {p?.name || `#${pid}`}
                        {p && !p.published && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--red)' }}>未上架</span>}
                      </div>
                      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>NT${(p?.price || 0).toLocaleString()}</span>
                      <button type="button" onClick={() => moveProduct(idx, -1)} disabled={idx === 0}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14 }}>▲</button>
                      <button type="button" onClick={() => moveProduct(idx, 1)} disabled={idx === draft.productIds.length - 1}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14 }}>▼</button>
                      <button type="button" onClick={() => toggleProduct(pid)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 12 }}>移除</button>
                    </div>
                  )
                })}
              </div>
            )}

            <input className="form-input" type="search" value={pickerQuery}
              onChange={e => setPickerQuery(e.target.value)} placeholder="搜尋商品名稱…" style={{ marginBottom: 10 }} />
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              {filteredProducts.length === 0 ? (
                <div style={{ padding: 12, fontSize: 13, color: 'var(--text-3)' }}>沒有符合的商品</div>
              ) : filteredProducts.map(p => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={draft.productIds.includes(p.id)} onChange={() => toggleProduct(p.id)} />
                  {p.image
                    ? <img src={p.image} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover' }} />
                    : <div style={{ width: 30, height: 30, borderRadius: 6, background: 'var(--bg)' }} />}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
                    {p.name}
                    {!p.published && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--red)' }}>未上架</span>}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--text-3)' }}>NT${p.price.toLocaleString()}</span>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
              只選商品、不指定規格 —— 顏色尺寸由消費者在落地頁自己挑。
              未上架的商品在落地頁不會出現，整套就湊不齊、套裝價不成立。
            </div>
          </div>

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
