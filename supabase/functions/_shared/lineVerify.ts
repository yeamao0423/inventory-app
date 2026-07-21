// ============================================================
// LINE 身分驗證共用模組
//   verifyIdToken : 驗 LINE id_token → 已驗證的 userId(sub)/email/name
//   exchangeCode  : Web OAuth 授權碼換 id_token（需 Channel Secret）
//   兩條入口（LIFF id_token / Web OAuth code）最終都收斂成
//   { lineUserId, email, name } — email 來自 id_token claim，視為未驗證。
// ============================================================

export type LineIdentity = {
  lineUserId: string;
  email: string | null;
  name: string | null;
};

// 驗 id_token（LINE 官方 verify 端點；簽章/效期/audience 由 LINE 驗，前端無法偽造）
export async function verifyIdToken(
  idToken: string,
  channelId: string,
): Promise<LineIdentity | null> {
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.sub) return null;
  return {
    lineUserId: out.sub as string,
    email: (out.email as string | undefined) ?? null,
    name: (out.name as string | undefined) ?? null,
  };
}

// Web OAuth：authorization code 換 token → 回 id_token（唯一需要 Channel Secret 的一步）
export async function exchangeCode(
  code: string,
  redirectUri: string,
  channelId: string,
  channelSecret: string,
): Promise<string | null> {
  const res = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: channelId,
      client_secret: channelSecret,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.id_token) return null;
  return out.id_token as string;
}
