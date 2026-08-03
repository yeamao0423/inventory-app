// Web Push（VAPID + aes128gcm）—— 手寫，不引入函式庫。
//
// 規格：RFC 8291（訊息加密）、RFC 8188（aes128gcm content-coding）、RFC 8292（VAPID）。
// 全部用 Deno 內建的 Web Crypto 完成：ECDH(P-256) → HKDF-SHA256 → AES-128-GCM，
// 授權標頭則是 ES256 簽的 JWT。這樣 Edge Function 就沒有任何 runtime 依賴。
//
// 需要的 Function Secrets：
//   VAPID_PUBLIC_KEY   base64url 的未壓縮 P-256 公鑰（65 bytes，0x04 開頭）
//   VAPID_PRIVATE_KEY  base64url 的 P-256 私鑰純量（32 bytes）
//   VAPID_SUBJECT      mailto: 或 https: 開頭的聯絡方式

// ── base64url ───────────────────────────────────────────────
export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// ── HKDF-SHA256（extract + expand 一次做完）─────────────────
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

// ── VAPID：把 base64url 的公私鑰組成 Web Crypto 的 JWK ──────
function vapidJwk(publicKey: Uint8Array, privateKey?: Uint8Array) {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY 必須是 65 bytes 的未壓縮 P-256 公鑰");
  }
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(publicKey.slice(1, 33)),
    y: b64urlEncode(publicKey.slice(33, 65)),
    ext: true,
  };
  if (privateKey) jwk.d = b64urlEncode(privateKey);
  return jwk;
}

// ES256 簽的 VAPID JWT。aud 是推播服務的 origin，一個 endpoint 一組。
// export 是為了能離線驗簽（見開發筆記）。
export async function vapidAuthHeader(endpoint: string): Promise<string> {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@likedaigo.com";
  if (!pub || !priv) throw new Error("VAPID 金鑰未設定");

  const key = await crypto.subtle.importKey(
    "jwk",
    vapidJwk(b64urlDecode(pub), b64urlDecode(priv)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const header = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = utf8(`${header}.${payload}`);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signingInput,
  );
  const jwt = `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${pub}`;
}

// ── RFC 8291 訊息加密 ───────────────────────────────────────
// export 是為了能在不打真實推播服務的情況下做加解密往返驗證。
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublicRaw: Uint8Array, // 訂閱的 p256dh（65 bytes）
  authSecret: Uint8Array, // 訂閱的 auth（16 bytes）
): Promise<Uint8Array> {
  // 每則訊息一組臨時金鑰對
  const asKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeys.privateKey, 256),
  );

  // IKM = HKDF(ikm=ecdh, salt=auth, info="WebPush: info\0" || ua_pub || as_pub)
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 = 最後一筆 record 的分隔符（只送一筆）
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded),
  );

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushResult {
  endpoint: string;
  ok: boolean;
  status: number;
  /** 410/404 代表訂閱已失效，呼叫端該把它刪掉 */
  gone: boolean;
}

/** 送一則推播。payload 會被 JSON 序列化後加密。 */
export async function sendPush(
  sub: PushSubscriptionRow,
  payload: unknown,
  ttlSeconds = 600,
): Promise<PushResult> {
  const body = await encryptPayload(
    utf8(JSON.stringify(payload)),
    b64urlDecode(sub.p256dh),
    b64urlDecode(sub.auth),
  );
  const auth = await vapidAuthHeader(sub.endpoint);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "high",
    },
    body,
  });

  if (!res.ok) {
    console.error("web push failed", res.status, await res.text().catch(() => ""));
  }
  return {
    endpoint: sub.endpoint,
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
  };
}

export function vapidConfigured(): boolean {
  return !!(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY"));
}
