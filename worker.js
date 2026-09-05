// 식품 표시·광고 규정 검수 웹서비스 - Cloudflare Worker (규정 지식베이스 + Claude API 스트리밍)
import { INDEX, CHUNKS } from "./kb.js";
import UI_HTML from "./ui.html";

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

function buildPrompt(ptype, text, pdftext, picked, hasImages, suggest) {
  let ref = "";
  const budget = 14000;
  for (const it of picked) {
    const c = CHUNKS[it.id];
    if (!c) continue;
    const piece = "[" + (c.kind === "요약" ? "요약: " : "원문: ") + c.title + "]\n" + c.text + "\n\n";
    if (ref.length + piece.length < budget) ref += piece;
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
        "(광고 문구 전체를 위 제안이 모두 반영된 완성 문안으로 다시 써서 한 단락으로 제시하라. 표시사항 항목(제품명·원재료명 등)은 고치지 말고 광고·홍보 문구만 다시 써라.)"
      : "",
    "## 다음 단계",
    "(가장 시급한 수정 1~3개)",
    "",
    "[규칙] 규정 자료에 있는 내용은 그 조문·항목을 근거로 정확히 인용하라. 자료에 없는 사항은 일반 지식으로 판단하되 '자료 외 판단(원문 확인 필요)'을 붙여라. 조항 번호를 지어내지 말라.",
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

    if (request.method === "GET" && url.pathname === "/api/status") {
      if (!authorized(request, env)) return json({ error: "auth" }, 401);
      return json({
        kb: Object.keys(CHUNKS).length,
        updated: INDEX.updated || "",
        model: env.MODEL || "claude-haiku-4-5",
      });
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
      const images = (body.images || []).slice(0, 6);
      const suggest = !!body.suggest;
      const picked = pickChunks(text + " " + pdftext + " " + ptype, ptype);
      const prompt = buildPrompt(ptype, text, pdftext, picked, images.length > 0, suggest);

      const content = [];
      for (const durl of images) {
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(durl);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      content.push({ type: "text", text: prompt });

      const model = body.precise ? (env.PRECISE_MODEL || "claude-sonnet-5") : (env.MODEL || "claude-haiku-4-5");
      // Cloudflare AI Gateway 경유 (Workers 직접 호출은 일부 경유지에서 Anthropic이 403으로 차단)
      const upstream = await fetch("https://gateway.ai.cloudflare.com/v1/b24a7a0550fd3f7e512be74ed4affa7a/labelcheck/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: suggest ? 4000 : 3000,
          stream: true,
          messages: [{ role: "user", content }],
        }),
      });

      if (!upstream.ok) {
        const status = upstream.status;
        let detail = "";
        try { detail = (await upstream.text()).slice(0, 300); } catch (e) {}
        let msg = "API 오류 (" + status + "). 잠시 후 다시 시도하세요." + (detail ? " [" + detail + "]" : "");
        if (status === 401) msg = "서버의 API 키가 올바르지 않습니다. 관리자에게 문의하세요.";
        if (status === 429) msg = "요청이 많거나 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.";
        if (status === 529) msg = "AI 서버가 혼잡합니다. 잠시 후 다시 시도하세요.";
        return json({ error: "api", message: msg }, 502);
      }

      // 참조 조문 목록을 첫 줄(JSON)로 보내고, 이어서 업스트림 SSE를 그대로 통과시킨다
      const refs = picked
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
