// 식품 표시·광고 규정 검수 웹서비스 - Cloudflare Worker (규정 지식베이스 + Claude API 스트리밍)
import { INDEX, CHUNKS } from "./kb.js";
import { EXPORT_CHUNKS } from "./exportkb.js";
import UI_HTML from "./ui.html";

// 위치 고정 중계기 - Anthropic 미지원 경유지(홍콩 등) 차단을 피하기 위해
// 미국 동부에 상주하는 Durable Object가 업스트림 호출을 대신 수행한다
export class Relay {
  constructor(state, env) { this.env = env; }
  async fetch(request) {
    const target = request.headers.get("X-Relay-Target");
    if (!target || !target.startsWith("https://gateway.ai.cloudflare.com/") && !target.startsWith("https://api.anthropic.com/")) {
      return new Response("bad target", { status: 400 });
    }
    const headers = new Headers();
    for (const h of ["x-api-key", "anthropic-version", "content-type"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    return fetch(target, { method: "POST", headers, body: request.body });
  }
}

async function relayFetch(env, target, headers, body) {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay-v1"), { locationHint: "enam" });
  return stub.fetch("https://relay/", {
    method: "POST",
    headers: { ...headers, "X-Relay-Target": target },
    body,
  });
}

const BASE_IDS = ["L1-8", "L1-8_2", "L4-2-1", "L4-2-2", "L4-2-3", "L4-2-4", "C-case"];
const HFF_BASE = ["C-hff1", "C-hff2", "L3-4", "L3-5-1"];

function pickChunks(text, ptype) {
  const scored = [];
  for (const it of INDEX.items || []) {
    let s = 0;
    for (const k of it.kw || []) {
      if (k && text.includes(k)) s += 2;
    }
    if (BASE_IDS.includes(it.id)) s += 3;
    if (ptype === "건강기능식품") {
      if (HFF_BASE.includes(it.id)) s += 3;
      if (it.id.startsWith("L3")) s += 1;
    }
    if (s > 0) scored.push([s, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 9).map((x) => x[1]);
}

function buildPrompt(ptype, text, pdftext, picked, hasImages, suggest, compose) {
  let ref = "";
  const budget = 14000;
  for (const it of picked) {
    const c = CHUNKS[it.id];
    if (!c) continue;
    const piece = "[" + (c.kind === "요약" ? "요약: " : "원문: ") + c.title + "]\n" + c.text + "\n\n";
    if (ref.length + piece.length < budget) ref += piece;
  }
  if (compose) {
    return [
      "너는 한국 식품 표시사항(라벨) 문안 작성 전문가다. 아래 [규정 자료]를 근거로, 제공된 자료(품목제조보고서·제품 정보·이미지)에서 확인되는 정보로 패키지에 인쇄할 표시사항 문안 초안을 작성하라.",
      "",
      "제품 유형: " + ptype,
      "",
      ref ? "[규정 자료]\n" + ref : "",
      "[제공된 제품 정보]",
      text.slice(0, 5000),
      pdftext ? pdftext.slice(0, 3000) : "",
      hasImages ? "\n(첨부된 이미지·PDF의 내용도 정보로 활용하라)" : "",
      "",
      "[출력 형식 - 반드시 이 마크다운 구조로]",
      "## 표시사항 문안 초안",
      "(일괄표시면 형식으로: 제품명 / 식품유형 / 내용량 / 원재료명 / 소비기한 / 보관방법 / 포장재질 / 품목보고번호 / 제조원 / 판매원 / 섭취방법 등. 자료에 없는 값은 [확인 필요: 무엇]으로 표시)",
      "## 의무 문구",
      "(부정·불량식품 신고 1399, 소비자분쟁해결기준 교환·보상 문구, 반품·교환처 등 이 제품에 필요한 것)",
      "## 확인 필요 항목",
      "- 자료로 확정할 수 없어 담당자 확인이 필요한 항목과 그 이유",
      "## 사용 금지·주의 표현",
      "- 이 제품 유형에서 쓰면 위반이 되는 표현 (제공된 광고 문구가 있으면 그것도 판정)",
      "## 다음 단계",
      "(인쇄 전 확인 1~3개)",
      "",
      "[규칙] 규정 자료에 있는 내용은 그 조문을 근거로 하라. 자료에 없는 값을 지어내지 말고 [확인 필요]로 남겨라. 입력에 없는 제품 사실(원산지·첨가물·함량·인증 등)을 새로 추가하지 말라. 제품 유형에 따라 영양성분 표시 의무 여부를 판단해 언급하라.",
    ].join("\n");
  }
  const parts = [
    "너는 한국 식품 표시·광고 규정 검수 전문가다. 아래 [규정 자료]의 원문·요약을 최우선 근거로 삼아 제품 문구를 검수하라.",
    "",
    "제품 유형: " + ptype,
    "",
    ref ? "[규정 자료 - 이 발췌를 근거로 인용하라]\n" + ref : "",
    "[검수 대상 문구]",
    text.slice(0, 5000),
    pdftext ? pdftext.slice(0, 3000) : "",
    hasImages ? "\n(첨부된 패키지 이미지·PDF 페이지의 문구와 표시면도 함께 검수하라)" : "",
    "",
    "[출력 형식 - 반드시 이 마크다운 구조로]",
    "## 종합 판정",
    "(한두 문장. 전체 위험 수준)",
    "## 위반 위험 문구",
    '- [높음] "문구" — 위반 사유. 근거: (규정 자료의 해당 조문·항목 인용, 요약 자료면 \'요약 기준\' 명시). 수정 제안: ~',
    "- [중간]/[낮음] 같은 형식. 위험 문구가 없으면 '발견된 위험 문구 없음'",
    "## 누락 의심 필수 표시사항",
    "- 항목명 — 제공된 내용에서 확인되지 않음 (실물에 있다면 무시)",
    "## 오타·표기 오류",
    '- "잘못된 표기" → "올바른 표기" — 이유',
    "(다음을 모두 점검하라: ① 원재료명·식품첨가물 명칭이 공전·고시상 정식 명칭과 다른 경우(예: 글리세린지방산에스테르, 소르빈산칼륨 등의 오기) ② 알레르기 유발물질 표시, 보관방법, '부정·불량식품 신고는 국번없이 1399' 등 정형 문구의 오타 ③ 일반 한글 맞춤법·띄어쓰기 오류. 공전상 명칭 여부가 확실하지 않으면 '확인 필요'를 붙여라. 없으면 '발견된 오타 없음')",
    suggest
      ? "## 수정 문안 제안\n" +
        '- 원래: "문구" → 제안: "규정에 맞게 고친 문구" (한 줄 이유)\n' +
        "(위반·위험 문구마다 위 형식으로. 원래 표현의 마케팅 의도는 최대한 살리되 규정을 지키는 문구로 바꿔라. 규정상 살릴 방법이 없는 문구는 '삭제 권고'라고 써라.)\n" +
        "### 전체 수정본\n" +
        "(광고 문구 전체를 위 제안이 모두 반영된 완성 문안으로 다시 써서 한 단락으로 제시하라. 표시사항 항목(제품명·원재료명 등)은 고치지 말고 광고·홍보 문구만 다시 써라. "
        + "입력에 없는 제품 사실(원산지·첨가물 유무·함량·인증 등)을 새로 추가하거나 사실처럼 단정하지 말라. 확인되지 않은 것은 문안에 넣지 말라.)"
      : "",
    "## 다음 단계",
    "(가장 시급한 수정 1~3개)",
    "",
    "[규칙] 규정 자료에 있는 내용은 그 조문·항목을 근거로 정확히 인용하라. 자료에 없는 사항은 일반 지식으로 판단하되 '자료 외 판단(원문 확인 필요)'을 붙여라. 조항 번호를 지어내지 말라.",
  ];
  return parts.join("\n");
}

function buildExportPrompt(country, text, pdftext, hasImages, suggest) {
  const chunks = EXPORT_CHUNKS[country] || [];
  const ref = chunks.map((c) => "[참고: " + c.title + "]\n" + c.text).join("\n\n");
  const nation = country === "수출(미국)" ? "미국(FDA)" : "일본(식품표시기준)";
  const lang = country === "수출(미국)" ? "영어" : "일본어";
  const parts = [
    "너는 한국 식품의 " + nation + " 수출용 표시(라벨) 사전 점검 전문가다. 아래 [참고 자료]와 너의 지식을 근거로, 이 제품을 " + nation + " 시장에 수출한다고 가정하고 라벨 문구를 검수하라.",
    "",
    "[참고 자료 - 핵심 요약이며 규정 원문이 아니다. 원문 확인이 필요한 판단에는 반드시 '원문 확인 필요'를 붙여라]",
    ref,
    "",
    "[검수 대상 문구 - 한국어 라벨이거나 현지어 초안일 수 있다]",
    text.slice(0, 5000),
    pdftext ? pdftext.slice(0, 3000) : "",
    hasImages ? "\n(첨부된 패키지 이미지·PDF 페이지의 문구와 표시면도 함께 검수하라)" : "",
    "",
    "[출력 형식 - 반드시 이 마크다운 구조로]",
    "## 종합 판정",
    "(한두 문장. " + nation + " 기준 위험 수준과 가장 큰 문제)",
    "## 부적합·위험 표시",
    '- [높음] "문구" — ' + nation + " 기준 위반·부적합 사유. 근거: (참고 자료 또는 일반 지식, 지식이면 '원문 확인 필요' 병기). 수정 방향: ~",
    "- [중간]/[낮음] 같은 형식. 한국 라벨을 그대로 쓸 수 없는 항목(알레르겐 목록 차이, 영양성분표 형식 차이 등)도 여기서 짚어라.",
    "## 누락 의심 필수 표시사항",
    "- " + nation + " 필수 항목 중 제공된 내용에서 확인되지 않는 것 (실물에 있다면 무시)",
    "## 오타·표기 오류",
    "- " + lang + " 표기의 철자·용어 오류, 잘못된 현지 명칭 (제공된 문구에 현지어가 없으면 '현지어 문안 없음 — 번역 라벨 작성 필요'라고 써라)",
    suggest
      ? "## 수정 문안 제안\n- 항목별로 " + lang + " 표시 문안 예시를 제안하라 (예: 알레르겐 문장, 내용량 표기, 원산국 표기). 제공된 광고 문구가 있으면 현지 규제에 맞는 " + lang + " 대체 문구도 제안하라.\n### 현지 라벨 표시 초안\n(필수 표시사항을 " + lang + "로 정리한 일괄 표시 초안을 제시하라. 확인 불가한 항목은 [확인 필요]로 남겨라.)"
      : "",
    "## 다음 단계",
    "(수출 전 반드시 해야 할 확인 1~3개 - 예: 현지 수입자 검토, 첨가물 허용 여부 확인)",
    "",
    "[규칙] 참고 자료는 요약이므로 세부 수치·조항은 단정하지 말고 '원문 확인 필요'를 붙여라. 조항 번호를 지어내지 말라. 입력에 없는 제품 사실(원산지·첨가물·함량·인증 등)을 새로 추가하지 말고 확인 불가 항목은 [확인 필요]로 남겨라. 이 검수는 참고용 사전 점검이며 최종 라벨은 현지 수입자와 전문가 검토로 확정해야 함을 다음 단계에서 상기시켜라.",
  ];
  return parts.join("\n");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const code = request.headers.get("X-Access-Code") || "";
  return !!env.ACCESS_CODE && code === env.ACCESS_CODE;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/api/auth") {
      return json({ ok: authorized(request, env) }, authorized(request, env) ? 200 : 401);
    }

    if (request.method === "GET" && url.pathname === "/api/diag") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const up = await relayFetch(env,
        "https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages",
        { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }));
      let detail = "";
      try { detail = (await up.text()).slice(0, 120); } catch (e) {}
      return json({ colo: request.cf && request.cf.colo, upstream: up.status, detail });
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      return json({
        kb: Object.keys(CHUNKS).length,
        updated: INDEX.updated || "",
        model: env.MODEL || "claude-haiku-4-5",
      });
    }

    // 공유 검수 이력 (Cloudflare KV) - 접속 코드 인증자 전원이 공유
    if (url.pathname === "/api/hist" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const list = await env.HIST.list({ prefix: "h:", limit: 30 });
      const items = [];
      for (const k of list.keys) {
        const m = k.metadata || {};
        items.push({ id: k.name, d: m.d || "", n: m.n || "", p: m.p || "" });
      }
      return json({ items });
    }
    if (url.pathname === "/api/hist" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const now = new Date();
      const d = now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      // 키를 역순 타임스탬프로 만들어 목록이 최신순이 되게 한다
      const id = "h:" + String(1e13 - Date.now()).padStart(13, "0") + Math.random().toString(36).slice(2, 6);
      const rec = { d, n: String(body.n || "").slice(0, 40), p: String(body.p || "").slice(0, 20), input: String(body.input || "").slice(0, 8000), r: String(body.r || "").slice(0, 30000) };
      await env.HIST.put(id, JSON.stringify(rec), { metadata: { d: rec.d, n: rec.n, p: rec.p } });
      // 100건 초과분 정리
      const list = await env.HIST.list({ prefix: "h:", limit: 200 });
      for (let i = 100; i < list.keys.length; i++) await env.HIST.delete(list.keys[i].name);
      return json({ ok: true, id });
    }
    if (url.pathname.startsWith("/api/hist/") && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      const rec = await env.HIST.get(url.pathname.slice("/api/hist/".length));
      if (!rec) return json({ error: "not_found" }, 404);
      return new Response(rec, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/api/hist/") && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      await env.HIST.delete(url.pathname.slice("/api/hist/".length));
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      if (!authorized(request, env)) return json({ error: "auth", message: "접속 코드가 올바르지 않습니다." }, 401);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key", message: "서버에 API 키가 설정되지 않았습니다." }, 500);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad_request" }, 400);
      }
      const ptype = body.ptype || "일반식품";
      const text = body.text || "";
      const pdftext = body.pdftext || "";
      const images = (body.images || []).slice(0, 8);
      const suggest = !!body.suggest;
      const compose = !!body.compose;
      const isExport = !!EXPORT_CHUNKS[ptype];
      const picked = isExport ? [] : pickChunks(text + " " + pdftext + " " + ptype + (compose ? " 표시 원재료명 소비기한 내용량" : ""), ptype);
      const prompt = isExport
        ? buildExportPrompt(ptype, text, pdftext, images.length > 0, suggest)
        : buildPrompt(ptype, text, pdftext, picked, images.length > 0, suggest, compose);

      const content = [];
      for (const durl of images) {
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(durl);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      content.push({ type: "text", text: prompt });

      const model = body.precise ? (env.PRECISE_MODEL || "claude-sonnet-5") : (env.MODEL || "claude-haiku-4-5");
      // 위치 고정 중계기(미국 동부) 경유 - 홍콩 등 미지원 경유지의 403 차단 회피
      const upstream = await relayFetch(env,
        "https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages",
        {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        JSON.stringify({
          model,
          max_tokens: suggest ? 4000 : 3000,
          stream: true,
          messages: [{ role: "user", content }],
        }));

      if (!upstream.ok) {
        const status = upstream.status;
        let detail = "";
        try { detail = (await upstream.text()).slice(0, 300); } catch (e) {}
        // 홍콩 등 미지원 경유지에서 실행된 경우 - 클라이언트가 재요청하면 경유지가 바뀐다
        if (status === 403 && detail.includes("forbidden")) {
          return json({ error: "region_retry", message: "해외 경유지 문제 - 자동 재시도 중입니다." }, 503);
        }
        let msg = "API 오류 (" + status + "). 잠시 후 다시 시도하세요." + (detail ? " [" + detail + "]" : "");
        if (status === 401) msg = "서버의 API 키가 올바르지 않습니다. 관리자에게 문의하세요.";
        if (status === 429) msg = "요청이 많거나 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.";
        if (status === 529) msg = "AI 서버가 혼잡합니다. 잠시 후 다시 시도하세요.";
        return json({ error: "api", message: msg }, 502);
      }

      // 참조 조문 목록을 첫 줄(JSON)로 보내고, 이어서 업스트림 SSE를 그대로 통과시킨다
      const refs = isExport
        ? (EXPORT_CHUNKS[ptype] || []).map((c) => ({ title: c.title, kind: c.kind }))
        : picked
            .map((it) => {
              const c = CHUNKS[it.id];
              return c ? { title: c.title, kind: c.kind || "원문" } : null;
            })
            .filter(Boolean);
      const header = new TextEncoder().encode("META:" + JSON.stringify({ refs, model }) + "\n");
      const upstreamReader = upstream.body.getReader();
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(header);
        },
        async pull(controller) {
          const { done, value } = await upstreamReader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() {
          upstreamReader.cancel().catch(() => {});
        },
      });
      return new Response(readable, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
